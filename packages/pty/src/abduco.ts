import { execFile, type SpawnOptions, spawn } from 'node:child_process'
import {
  closeSync,
  existsSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  unlinkSync,
} from 'node:fs'
import { hostname, tmpdir, userInfo } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { createLogger } from '@podium/logger'
import { ABDUCO_SUN_PATH_MAX, abducoSocketPathBytes } from '@podium/runtime/abduco-socket'
import {
  abducoSocketPathname,
  assertLinuxUnixSocketPath,
  instanceSessionSliceName,
  resolveInstanceId,
} from '@podium/runtime/instance'
import {
  resolveScopeBudget,
  resolveSessionsSliceHigh,
  type ScopeBudget,
  type ScopeRole,
  scopeBudgetProperties,
  sliceBudgetArgv,
} from '@podium/runtime/scope'
import { ABDUCO_FEATURES, resolveAbducoBin } from './abduco-bin.js'
import { defaultPtyBackend } from './backends/index.js'
import type { PtyBackend, PtyProcess } from './backends/types.js'
import { type AgentSession, withHardRepaint, wrapPty } from './session.js'
import { shellQuote } from './tmux.js'

const log = createLogger('pty:abduco')

/**
 * abduco-backed durable sessions. abduco is "detach/reattach, nothing else": a
 * daemonized master holds the agent's PTY and pipes bytes transparently — no grid,
 * no copy-mode, no status chrome — so xterm.js stays the only terminal emulator in
 * the stack. The master survives both the attach client and the daemon process
 * (verified: it setsids and reparents to the user manager).
 */

/**
 * The abduco client treats any input chunk whose FIRST byte equals the detach key
 * (default `^\` = 0x1c) as a detach request and swallows the whole chunk. We remap
 * it to 0xff, a byte that can never occur in valid UTF-8 input from xterm.js. The
 * raw byte cannot be passed through node argv (JS strings argv-encode as UTF-8, so
 * '\xff' becomes 0xC3 0xBF and the real key would be 0xC3 — the first byte of
 * é/à/ö, far worse than the default), so the attach command routes through
 * `sh -c` with printf producing the byte.
 */
export function abducoAttachArgv(
  label: string,
  bin = 'abduco',
  opts?: { sizeNeutral?: boolean },
): string[] {
  // -N (podium's abduco patch): attach without announcing a size. Only a binary
  // that carries the feature understands it — an upstream abduco would reject it
  // and the attach would fail, so the caller resolves that binary first.
  const flags = `-q${opts?.sizeNeutral ? ' -N' : ''}`
  return ['sh', '-c', `exec ${shellQuote(bin)} ${flags} -e "$(printf '\\377')" -a "$0"`, label]
}

/**
 * The binary for an attach, plus whether it can actually be asked to attach
 * size-neutrally. A caller that wants `-N` needs the patched build; when the
 * machine only has an upstream abduco the attach still happens, with today's
 * resize-on-attach behaviour, rather than failing outright.
 */
export function resolveAttachBin(sizeNeutral: boolean): { bin: string; sizeNeutral: boolean } {
  if (!sizeNeutral) return { bin: resolveAbducoBin() ?? 'abduco', sizeNeutral: false }
  const patched = resolveAbducoBin({ requireFeatures: ABDUCO_FEATURES })
  if (patched) return { bin: patched, sizeNeutral: true }
  if (!warnedNoSizeNeutral) {
    warnedNoSizeNeutral = true
    log.warn('no podium abduco build available — attaching will resize the running program', {
      requiredFeatures: ABDUCO_FEATURES,
    })
  }
  return { bin: resolveAbducoBin() ?? 'abduco', sizeNeutral: false }
}

let warnedNoSizeNeutral = false

/** abduco runs the command via execvp from argv — no shell, no quoting needed. */
export function abducoCreateArgv(label: string, cmd: string, args: string[] = []): string[] {
  return ['-n', label, cmd, ...args]
}

/**
 * argv for `systemd-run` that launches `command` in its OWN transient `--user`
 * scope. THIS is what makes agents and shells survive a podium redeploy/crash.
 *
 * Without it the abduco master is a child of the spawning service and lives in
 * that service's cgroup. `systemctl restart podium-backend.service` (the redeploy)
 * uses the systemd default `KillMode=control-group`, which SIGTERMs every process
 * in the cgroup — the master and its agent included. abduco's setsid detaches the
 * controlling terminal but does NOT leave the cgroup, so detaching alone never
 * saved it (the long-standing "tabs stay, sessions die" bug).
 *
 * A `--scope` unit is a sibling cgroup of the service, so the restart's
 * cgroup-kill can't reach it. `--collect` GCs the (empty) scope once the master
 * exits; `--quiet` drops the "Running as unit …" line.
 *
 * CPUWeight=50/IOWeight=100 put the agent (and every child: test runs, builds) in
 * the BATCH tier of the two-tier scheduling scheme (POD-598): the host runs ~10x
 * CPU-oversubscribed by agent/test workloads, and POD-594 measured the daemon main
 * thread runqueue-waiting 60% of wall time when every scope competed at the default
 * CPUWeight=100. Interactive services carry CPUWeight=900/IOWeight=500.
 *
 * The scope is also PLACED and BOUNDED (POD-2413): `--slice` puts it in the
 * instance's sessions slice, and the budget adds MemoryHigh/MemoryMax/
 * MemorySwapMax/TasksMax plus `OOMPolicy=continue`, so a runaway session is
 * killed by the kernel inside its own cgroup instead of taking the host with it.
 * Both defaults are resolved here rather than at each call site, because all
 * four spawn paths (abduco master, codex app-server, grok ACP, opencode serve)
 * come through this one builder and a per-caller budget would be four policies.
 */
export function systemdScopeArgv(
  unit: string,
  command: string[],
  options: { slice?: string; budget?: ScopeBudget } = {},
): string[] {
  const slice = options.slice ?? instanceSessionSliceName()
  const budget = options.budget ?? resolveScopeBudget('session')
  return [
    '--user',
    '--scope',
    '--collect',
    '--quiet',
    `--slice=${slice}`,
    '--property=CPUWeight=50',
    '--property=IOWeight=100',
    ...scopeBudgetProperties(budget),
    `--unit=${unit}`,
    '--',
    ...command,
  ]
}

/** The transient scope unit name for a session label — the single source of truth. */
export function scopeUnitName(label: string): string {
  return `${label}.scope`
}

/**
 * `systemctl --user` argv pairs that free a stale scope so it can be recreated. A
 * redeploy/crash can leave a session's scope ACTIVE when the agent's own grandchildren
 * (a leaked sub-process, stray Xvfb from a verify run …) keep its cgroup non-empty. The
 * deterministic unit name then blocks every subsequent `systemd-run` with "unit already
 * exists", so the master silently falls back into the spawning service's cgroup — where
 * the next redeploy's KillMode=control-group SIGKILLs it. That recurs on each restart
 * and looks like "the agent keeps getting shut down", but only for the one session whose
 * scope name is squatted. `stop` SIGTERMs the squatting orphans (freeing the name);
 * `reset-failed` clears any leftover unit state. Both are best-effort no-ops when absent.
 */
export function scopeReclaimArgvs(unit: string): string[][] {
  return [
    ['--user', 'stop', unit],
    ['--user', 'reset-failed', unit],
  ]
}

/** Injection seam for {@link reclaimStaleScope}'s `systemctl` calls (tests pass a spy). */
export type SystemctlRunner = (
  file: string,
  args: string[],
  options: { timeout: number; env: NodeJS.ProcessEnv },
) => Promise<unknown>

/**
 * Free a stale scope squatting this label's unit name so the master can be (re)created
 * in its OWN scope. Guarded on there being NO live master for the label — we only ever
 * clear a zombie scope held open by orphaned grandchildren, never a live agent. The
 * liveness guard MUST use the direct socket index ({@link abducoSocketHasSession}): the
 * global `abduco` listing connects to every master in turn, so one wedged historical
 * session hangs the guard forever and no agent can ever (re)spawn. Runs only on the
 * (re)spawn path, not per frame.
 * Best-effort: a missing unit or absent systemd just makes the commands no-ops.
 */
export async function reclaimStaleScope(
  label: string,
  env: NodeJS.ProcessEnv = liveEnv(),
  run: SystemctlRunner = execFileAsync,
): Promise<void> {
  if (abducoSocketHasSession(label, env)) return
  for (const args of scopeReclaimArgvs(scopeUnitName(label))) {
    try {
      await run('systemctl', args, {
        timeout: 8000,
        env: scopeEnv(env),
      })
    } catch {
      // best-effort: no such unit / no systemd
    }
  }
}

/**
 * Free a durable label still owned by a TERMINATED master, so a respawn under that
 * label can create instead of dying on abduco's "create-session: Address already in
 * use". Guarded on there being no LIVE master (that one is adopted, never reaped).
 *
 * The reclaim is an attach: abduco's server loop runs `while (clients ||
 * !exit_packet_delivered)`, so the master exits — and unlinks its socket — as soon as
 * one client has taken delivery of the exit status. That client needs a real PTY (a
 * pipe-stdin attach returns without collecting it), which is why this drains through
 * the pty backend rather than a plain child process. Bounded and best-effort: a
 * client that does not finish is killed and the create is attempted anyway.
 */
export async function reclaimTerminatedSession(
  label: string,
  env: NodeJS.ProcessEnv = liveEnv(),
  options: { timeoutMs?: number; backend?: PtyBackend } = {},
): Promise<void> {
  if (abducoSocketHasSession(label, env)) return
  for (const socketPath of abducoTerminatedSocketPaths(label, env)) {
    await drainTerminatedMaster(socketPath, env, options)
  }
}

const TERMINATED_DRAIN_TIMEOUT_MS = 5000

async function drainTerminatedMaster(
  socketPath: string,
  env: NodeJS.ProcessEnv,
  options: { timeoutMs?: number; backend?: PtyBackend },
): Promise<void> {
  const [file, ...args] = abducoAttachArgv(socketPath, resolveAbducoBin() ?? 'abduco')
  if (!file) return
  let proc: PtyProcess
  try {
    proc = (options.backend ?? defaultPtyBackend()).spawn({
      file,
      args,
      cols: 80,
      rows: 24,
      env: { ...env, TERM: 'xterm-256color' } as Record<string, string>,
    })
  } catch (err) {
    log.warn('could not drain a terminated abduco master', { socketPath, err })
    return
  }
  await new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      try {
        proc.kill('SIGKILL')
      } catch {
        // already gone
      }
      resolve()
    }, options.timeoutMs ?? TERMINATED_DRAIN_TIMEOUT_MS)
    proc.onExit(() => {
      clearTimeout(timer)
      resolve()
    })
  })
}

/**
 * The user manager's runtime dir. `XDG_RUNTIME_DIR` is only in the environment of
 * logind sessions and `--user` units — a SYSTEM service with `User=` (the all-in-one
 * `podium.service`) never gets it, which silently disabled scoping and put every
 * master back in the service cgroup (the "all sessions die on redeploy" bug, again).
 * Fall back to the fixed logind path `/run/user/<uid>`; it exists exactly when a
 * user manager is running for us (login session or `loginctl enable-linger`).
 */
export function userRuntimeDir(): string | undefined {
  if (process.env.XDG_RUNTIME_DIR) return process.env.XDG_RUNTIME_DIR
  if (process.platform !== 'linux' || typeof process.getuid !== 'function') return undefined
  const dir = `/run/user/${process.getuid()}`
  return existsSync(dir) ? dir : undefined
}

/** Env for systemd-run/systemctl `--user` calls: they locate the user bus via XDG_RUNTIME_DIR. */
function scopeEnv(base: NodeJS.ProcessEnv): Record<string, string> {
  const dir = userRuntimeDir()
  return { ...base, ...(dir ? { XDG_RUNTIME_DIR: dir } : {}) } as Record<string, string>
}

let scopeOk: boolean | undefined
let scopeInFlight: Promise<boolean> | undefined
let scopeWarned = false

/**
 * Whether the abduco master can be launched in its own systemd scope: a Linux
 * systemd *user* manager (see {@link userRuntimeDir}) that actually accepts a
 * transient scope. The probe launches a real throwaway scope rather than checking
 * `systemd-run --version`: a present binary with a dead/absent user manager (env
 * var set but no lingering, container without logind) must read as NO here, or
 * every spawn takes the failure path. `PODIUM_NO_SCOPE` forces it off (tests /
 * non-systemd hosts). Memoized — the answer can't change within a process.
 */
export function canScopeMaster(): Promise<boolean> {
  if (scopeOk !== undefined) return Promise.resolve(scopeOk)
  if (scopeInFlight) return scopeInFlight
  if (
    process.env.PODIUM_NO_SCOPE ||
    process.platform !== 'linux' ||
    userRuntimeDir() === undefined
  ) {
    scopeOk = false
    return Promise.resolve(false)
  }

  let pending!: Promise<boolean>
  pending = new Promise<boolean>((resolve) => {
    execFile(
      'systemd-run',
      // THE PROBE RUNS THE REAL ARGV, not a bare scope. A user manager that
      // accepts `--scope` but rejects the budget — no memory controller
      // delegated, an older systemd — would otherwise pass here and then fail
      // every actual spawn, so each session would silently take the "will NOT
      // survive a podium restart" fallback. A gate must test what it gates.
      systemdScopeArgv(`podium-scope-probe-${process.pid}.scope`, ['true']),
      { timeout: 8000, env: scopeEnv(liveEnv()) },
      (error) => resolve(error === null),
    )
  })
    .then((ok) => {
      scopeOk = ok
      return ok
    })
    .finally(() => {
      if (scopeInFlight === pending) scopeInFlight = undefined
    })
  scopeInFlight = pending
  return pending
}

let sliceBudgetApplied = false

/**
 * Put the aggregate throttle on the instance's sessions slice.
 *
 * The slice is IMPLICIT — no unit file declares it; systemd materializes it the
 * first time a scope names it — so its budget cannot ride the scope's argv and
 * has to be set afterwards, which is why every spawn path calls this once a
 * scope actually exists. Memoized on SUCCESS only: the first call of a daemon's
 * life may well land before any scope does, and a failure there must not
 * silently mean "this instance runs unthrottled until the next restart".
 *
 * Deliberately a `MemoryHigh` and never a `MemoryMax`: a Max here would let one
 * greedy session get every other session on the instance killed, which is the
 * collective OOM death the whole hierarchy exists to prevent. The throttle is
 * the last line before the HOST starts swapping, not a per-session control.
 */
export async function applySessionsSliceBudget(
  run: SystemctlRunner = execFileAsync,
  env: NodeJS.ProcessEnv = liveEnv(),
): Promise<void> {
  if (sliceBudgetApplied) return
  const high = resolveSessionsSliceHigh(env)
  if (high === undefined) {
    sliceBudgetApplied = true
    return
  }
  try {
    await run('systemctl', sliceBudgetArgv(instanceSessionSliceName(), high), {
      timeout: 8000,
      env: scopeEnv(env),
    })
    sliceBudgetApplied = true
  } catch (err) {
    // The slice may not exist yet (no scope has named it). Stay un-memoized so
    // the next spawn tries again.
    log.debug('could not set the sessions slice budget yet', { err })
  }
}

/**
 * True when an abduco binary can be obtained — $PODIUM_ABDUCO, PATH, the build
 * cache, or by compiling the vendored source on first use (see abduco-bin.ts).
 */
export function isAbducoAvailable(): boolean {
  return resolveAbducoBin() !== undefined
}

export interface AbducoSessionEntry {
  name: string
  pid: number
  alive: boolean
}

/**
 * Parse `abduco` (no args) session-list output. Lines after the header are
 * `<state> <day>\t<datetime>\t<pid>\t<name>`. The state char maps to socket mode
 * bits the server toggles (abduco 0.6 source, server_mark_socket_exec):
 * `*` = S_IXUSR = a client is ATTACHED (alive!), `+` = S_IXGRP = the app
 * TERMINATED (only its exit status is held), ` ` = detached and alive. Note this
 * is the opposite of the folklore reading of `*`; trust the source — misreading
 * `*` as dead would declare every session with a connected podium client dead.
 */
export function parseAbducoList(output: string): AbducoSessionEntry[] {
  const entries: AbducoSessionEntry[] = []
  for (const line of output.split('\n')) {
    const fields = line.split('\t')
    if (fields.length < 4) continue
    const pid = Number.parseInt(fields[2]?.trim() ?? '', 10)
    const name = fields.slice(3).join('\t').trim()
    if (!name || Number.isNaN(pid)) continue
    entries.push({ name, pid, alive: !line.trimStart().startsWith('+') })
  }
  return entries
}

/**
 * Live env snapshot for child `abduco`/`systemctl` calls.
 *
 * Bun's `spawnSync`/`execFileSync` (unlike Node) ignore mid-process
 * `process.env` mutations when `env` is omitted — they reuse the process-start
 * environment. That breaks HOME isolation in tests (session created under a
 * temp `$HOME` via an explicit `env`, then "not found" by a bare `abduco`
 * list) and would also miss any runtime env change in production. Always pass
 * the live map. [spec:SP-3f93]
 */
function liveEnv(): NodeJS.ProcessEnv {
  return { ...process.env }
}

const execFileAsync = promisify(execFile)

const ABDUCO_SOCKET_WAIT_MS = 5000
const ABDUCO_SOCKET_POLL_MS = 10
/** Ceiling for the global `abduco` listing — see {@link listSessions}. */
const ABDUCO_LIST_TIMEOUT_MS = 8000

/**
 * Candidate roots in abduco's resolution order — ALL FOUR OF THEM (POD-2853).
 *
 * abduco does not resolve one directory, it walks a FALL-THROUGH CHAIN:
 * `ABDUCO_SOCKET_DIR`, then `HOME`, then `TMPDIR`, then `/tmp` (config.h), and
 * it moves to the next one on ANY failure of the current one — the directory's
 * parent does not exist, `mkdir` is refused, the per-user subdirectory is owned
 * by someone else or group/world accessible, the composed name truncates, or
 * the probe bind fails. It says nothing when it does: the create SUCCEEDS, at a
 * different root.
 *
 * This function used to stop at the first root. When `ABDUCO_SOCKET_DIR` was
 * set it looked ONLY under it, and when it was unset ONLY under `$HOME/.abduco`
 * — so a master that fell through to `/tmp` was invisible to every caller that
 * asks "is this label alive". Measured directly: an abduco master created with
 * a given environment, alive and holding its socket, while `abducoSocketPath`
 * called with THAT SAME ENVIRONMENT answered `undefined`.
 *
 * THE ERROR IS ONE-SIDED TOWARD "ABSENT", which is the expensive direction on
 * every caller — the spawn path reports "did not publish a live socket" for a
 * session that is running, `reclaimStaleScope` clears a scope out from under a
 * live master, and the reattach path answers "session not found". Same shape as
 * POD-2761, which fixed the ATTACH path's environment and left this one.
 *
 * The two non-user-specific entries under `ABDUCO_SOCKET_DIR` are historical
 * compatibility, not abduco's behaviour, and are kept so nothing that resolves
 * today stops resolving.
 */
function abducoSocketDirs(env: NodeJS.ProcessEnv, username?: string): string[] {
  const dirs: string[] = []
  let user = username
  if (!user) {
    try {
      user = userInfo().username
    } catch {
      // No passwd entry: abduco names the subdirectory by numeric uid instead.
      user = typeof process.getuid === 'function' ? String(process.getuid()) : undefined
    }
  }
  /** A non-personal root: `<root>/abduco/<user>`, exactly as create_socket_dir builds it. */
  const shared = (root: string) => {
    if (user) dirs.push(join(root, 'abduco', user))
  }
  if (env.ABDUCO_SOCKET_DIR) {
    shared(env.ABDUCO_SOCKET_DIR)
    dirs.push(join(env.ABDUCO_SOCKET_DIR, 'abduco'), env.ABDUCO_SOCKET_DIR)
  }
  // HOME is abduco's `personal` root: `$HOME/.abduco`, with NO user subdirectory.
  if (env.HOME) dirs.push(join(env.HOME, '.abduco'))
  if (env.TMPDIR) shared(env.TMPDIR)
  shared('/tmp')
  // De-duplicated because the chain overlaps in ordinary configurations —
  // TMPDIR is very often /tmp — and every duplicate is another readdir on the
  // spawn path's poll loop.
  return dirs.filter((dir, i) => dirs.indexOf(dir) === i)
}

/**
 * Resolve one live abduco socket for a durable label.
 *
 * Relative abduco names are stored as `<label>@<hostname>`. The hostname is
 * written once by the abduco master and can be stale after an OS rename, so a
 * recovery path must retain the discovered filename and attach by its absolute
 * path instead of asking abduco to reconstruct it from the current hostname.
 */
export function abducoSocketPath(
  label: string,
  env: NodeJS.ProcessEnv = process.env,
  username?: string,
): string | undefined {
  for (const path of abducoSocketCandidates(label, env, username)) {
    try {
      if ((statSync(path).mode & 0o010) === 0) return path
    } catch {
      // The master exited between readdir and stat; keep looking.
    }
  }
  return undefined
}

/** abduco's create-dir probe: bind `.abduco-<pid>`, then unlink on the success path. */
const ABDUCO_BIND_TEMP_RE = /^\.abduco-(\d+)$/

/**
 * `kill(pid, 0)` liveness: ESRCH is gone; EPERM means the pid is alive but not
 * ours. Same shape {@link reapAbducoTestSessions} uses for crashed spawners.
 */
function pidIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM'
  }
}

/**
 * Unlink leftover `.abduco-<pid>` bind probes whose pid is not alive.
 *
 * abduco binds that name while picking a writable socket directory (then
 * unlinks it and binds the real session socket). A killed spawn, failed
 * create, or crashed test runner leaves the probe behind. Nothing else
 * reaps them, so `abducoSocketCandidates`' `readdirSync` — and the global
 * `abduco` listing — grow without bound.
 *
 * A temp whose pid is still alive is a bind in flight: leave it. Pid
 * liveness, not mtime: a just-started create must not be collected.
 */
export function reapStaleAbducoBindTemps(
  env: NodeJS.ProcessEnv = process.env,
  username?: string,
): string[] {
  const reaped: string[] = []
  for (const dir of abducoSocketDirs(env, username)) {
    let names: string[]
    try {
      names = readdirSync(dir)
    } catch {
      continue
    }
    for (const name of names) {
      const match = ABDUCO_BIND_TEMP_RE.exec(name)
      if (!match) continue
      const pid = Number(match[1])
      if (!Number.isInteger(pid) || pid < 1 || pidIsAlive(pid)) continue
      const path = join(dir, name)
      try {
        unlinkSync(path)
        reaped.push(path)
      } catch {
        // raced with a live bind, or already gone
      }
    }
  }
  return reaped
}

/** Every socket file that could belong to this label, in abduco's own preference order. */
function abducoSocketCandidates(
  label: string,
  env: NodeJS.ProcessEnv,
  username?: string,
): string[] {
  const paths: string[] = []
  for (const dir of abducoSocketDirs(env, username)) {
    let names: string[]
    try {
      names = readdirSync(dir)
    } catch {
      continue
    }
    const candidates = names
      .filter((name) => name === label || name.startsWith(`${label}@`))
      .sort((a, b) => {
        // Prefer an explicitly named socket, then make historical host-suffixed
        // recovery deterministic when more than one stale candidate exists.
        if (a === label) return -1
        if (b === label) return 1
        return a.localeCompare(b)
      })
    for (const name of candidates) paths.push(join(dir, name))
  }
  return paths
}

/**
 * Sockets held by a TERMINATED master for this label: the app exited and the master
 * lingers only to hand its exit status to the next client (abduco marks that with
 * S_IXGRP; see {@link parseAbducoList}). {@link abducoSocketPath} skips them — they
 * are not a live session — but abduco's own `create-session` still refuses the name,
 * so the spawn path has to clear them explicitly.
 */
export function abducoTerminatedSocketPaths(
  label: string,
  env: NodeJS.ProcessEnv = process.env,
  username?: string,
): string[] {
  const paths: string[] = []
  for (const path of abducoSocketCandidates(label, env, username)) {
    try {
      if ((statSync(path).mode & 0o010) !== 0) paths.push(path)
    } catch {
      // vanished between readdir and stat — nothing left to reclaim
    }
  }
  return paths
}

/**
 * Wait for a newly-created master to publish its socket before starting the
 * attach client. "abduco -n" exits after handing work to the daemonized master;
 * the master can therefore still be between fork and bind when an immediate
 * "-a" runs. A durable label is unique, so the socket index is the safe
 * readiness signal and also gives us the absolute path needed for renamed hosts.
 */
export async function waitForAbducoSocket(
  label: string,
  env: NodeJS.ProcessEnv = liveEnv(),
  options: { timeoutMs?: number; pollMs?: number; username?: string } = {},
): Promise<string> {
  const timeoutMs = options.timeoutMs ?? ABDUCO_SOCKET_WAIT_MS
  const pollMs = options.pollMs ?? ABDUCO_SOCKET_POLL_MS
  const deadline = Date.now() + timeoutMs
  let path = abducoSocketPath(label, env, options.username)
  while (path === undefined && Date.now() < deadline) {
    const delay = Math.min(pollMs, Math.max(1, deadline - Date.now()))
    await new Promise<void>((resolve) => setTimeout(resolve, delay))
    path = abducoSocketPath(label, env, options.username)
  }
  if (path === undefined) {
    throw new Error(
      'abduco session ' + label + ' did not publish a live socket within ' + timeoutMs + 'ms',
    )
  }
  return path
}

export function abducoSocketHasSession(
  label: string,
  env: NodeJS.ProcessEnv = process.env,
  username?: string,
): boolean {
  return abducoSocketPath(label, env, username) !== undefined
}

/**
 * `abduco` with no args lists sessions and reaps stale sockets as a side effect.
 * Exit status varies by version, so parse whatever it printed, including stdout
 * attached to a non-zero exit.
 */
async function listSessions(): Promise<AbducoSessionEntry[]> {
  const bin = resolveAbducoBin()
  if (!bin) return []
  try {
    // BOUNDED (POD-1953). The listing connects to every master in turn, so one
    // wedged session makes it hang — and an unbounded hang here is not a slow
    // answer, it is a lost one: the caller's `await` never returns and whatever
    // followed it never runs. Every caller has a correct empty-list fallback.
    const { stdout } = await execFileAsync(bin, [], {
      encoding: 'utf8',
      env: liveEnv(),
      timeout: ABDUCO_LIST_TIMEOUT_MS,
    })
    return parseAbducoList(stdout ?? '')
  } catch (err) {
    // `abduco` exits non-zero on some versions even when it printed a valid list;
    // recover whatever it wrote to stdout before giving up.
    const stdout = (err as { stdout?: string })?.stdout
    return stdout ? parseAbducoList(stdout) : []
  }
}

/**
 * Whether a live abduco master owns this label. Answered from the socket index
 * ({@link abducoSocketHasSession}), never the global `abduco` listing: on daemon
 * recovery the listing connects to every master in lexical order, so one wedged
 * legacy session turns into a fleet-wide reattach outage. Kept async because every
 * caller awaits it and the previous implementation shelled out.
 */
export async function abducoHasSession(label: string): Promise<boolean> {
  return abducoSocketHasSession(label)
}

/**
 * SIGTERM the session master and sweep its systemd scope. The async list/process
 * path keeps burst kills from starving every other session on the daemon loop.
 */
export async function killAbducoSession(
  label: string,
  run: SystemctlRunner = execFileAsync,
): Promise<void> {
  // Started BEFORE the listing, not after it (POD-1953). The scope sweep is the
  // reap that always works — it signals the whole cgroup by unit name and needs
  // nothing from `abduco` — but it used to be reachable only THROUGH the await
  // below, so a listing that hung took the reliable half down with it and the
  // kill became a silent no-op: master alive, scope alive, nothing logged, and a
  // row that said 'hibernated' for four hours.
  const scope = stopSessionScope(label, run)
  try {
    const entry = (await listSessions()).find((s) => s.name === label && s.alive)
    if (entry) process.kill(entry.pid, 'SIGTERM')
  } catch {
    // already gone
  }
  // Also sweep the session's scope cgroup (POD-108): SIGTERMing the master takes
  // the agent down via PTY hangup, but grandchildren the agent spawned (test
  // runs, builds, stray Xvfb) survive in the scope and stay resident — the same
  // orphans reclaimStaleScope otherwise has to clear at the NEXT spawn, which an
  // archived session never gets. `systemctl stop` signals the whole cgroup and
  // escalates to SIGKILL on its stop timeout; reset-failed clears leftover unit
  // state. Unconditional: a dead master with squatting orphans still needs it.
  await scope
}

/**
 * Every durable label this host is still RUNNING, read from the socket index.
 *
 * The census answer for POD-1953: a server that parked a row cannot know the
 * reap landed, so on connect the daemon tells it which labels are in fact still
 * alive. No `abduco` fork, so it cannot hang behind a wedged master however many
 * sessions this machine holds.
 *
 * ONE readdir per directory and ONE stat per entry. Asking
 * {@link abducoSocketPath} per label instead would re-read the whole directory
 * for every entry in it, and these directories are not small — the box this was
 * written on had 7032 sockets, where the quadratic form took 30 SECONDS and hung
 * the daemon's connect handshake behind it.
 *
 * A master that TERMINATED (S_IXGRP: the app exited, the master lingers holding
 * its exit status) owns the name but is not an agent, and is excluded here for
 * the same reason {@link abducoSocketPath} skips it: reviving a row over one
 * would resurrect nothing.
 */
export function listLiveAbducoLabels(
  env: NodeJS.ProcessEnv = process.env,
  /** Injection seam: the cost this function is bounded on is the read COUNT. */
  readdir: (dir: string) => string[] = readdirSync,
): string[] {
  const labels = new Set<string>()
  for (const dir of abducoSocketDirs(env)) {
    let names: string[]
    try {
      names = readdir(dir)
    } catch {
      continue
    }
    for (const name of names) {
      // abduco binds `.abduco-<pid>` and renames it into place, and the temp is
      // left behind whenever that does not complete — 6944 of them on the box
      // this was written on. They are not sessions, and their mode is abduco's
      // business, not a contract: exclude them by name rather than trusting the
      // permission bits below to keep classifying them as dead.
      if (name.startsWith('.')) continue
      // Relative names are stored `<label>@<hostname>`; the label is the part
      // before the FIRST '@' (podium labels never contain one).
      const label = name.split('@')[0]
      if (!label) continue
      try {
        if ((statSync(join(dir, name)).mode & 0o010) === 0) labels.add(label)
      } catch {
        // The master exited between readdir and stat — not live, keep going.
      }
    }
  }
  return [...labels]
}

/**
 * Async, guard-free counterpart of {@link reclaimStaleScope} for the kill path:
 * stop the label's transient scope unit and clear its unit state. Best-effort —
 * no systemd, an unscoped spawn (fallback path), or an already-gone unit all
 * make these no-ops. tmux labels never had a scope, so it's a no-op there too.
 */
export async function stopSessionScope(
  label: string,
  run: SystemctlRunner = execFileAsync,
): Promise<void> {
  for (const args of scopeReclaimArgvs(scopeUnitName(label))) {
    try {
      await run('systemctl', args, { env: scopeEnv(liveEnv()), timeout: 8000 })
    } catch {
      // best-effort: no such unit / no systemd
    }
  }
}

/**
 * Teardown sweep for the abduco test harnesses (POD-107). Test labels embed the
 * spawning test process's pid (`podium-abduco-itest-<pid>`, `podium-ab-retail-<pid>`,
 * …), and the per-test `killAbducoSession` sits on the happy path only — a failed
 * assertion or a killed runner skips it and the detached master lives for days,
 * attributed to "project processes" in the host memory breakdown. Call this from
 * `afterAll`: it kills every session matching one of `patterns` whose captured pid
 * (each pattern's FIRST capture group) is this process — this run's sessions,
 * pass or fail — or no longer alive — a previous crashed run. Sessions of a
 * concurrent test process survive: their embedded pid is alive and not ours.
 */
export async function reapAbducoTestSessions(patterns: RegExp[]): Promise<string[]> {
  const reaped: string[] = []
  let sessions: AbducoSessionEntry[]
  try {
    sessions = await listSessions()
  } catch {
    return reaped
  }
  for (const s of sessions) {
    if (!s.alive) continue
    const m = patterns.map((re) => re.exec(s.name)).find((x) => x?.[1])
    if (!m?.[1]) continue
    const spawner = Number(m[1])
    if (spawner !== process.pid && pidIsAlive(spawner)) continue
    try {
      process.kill(s.pid, 'SIGTERM')
      reaped.push(s.name)
    } catch {
      // raced to death
    }
  }
  // An idle master parks in poll() and can sit on the pending SIGTERM; listing
  // connects to every socket, and that wake is when the quit flag is processed.
  if (reaped.length > 0) {
    try {
      await listSessions()
    } catch {
      // best-effort nudge
    }
  }
  return reaped
}

const ATTACH_CHROME = Buffer.from('\x1b[?1049h\x1b[H', 'latin1')
const EMPTY = new Uint8Array(0)

/**
 * One-shot, split-safe strip of the alt-screen chrome the abduco client prints when
 * it attaches with a tty stdin. Forwarding it would push the whole session into
 * xterm.js's alternate buffer and kill scrollback — the exact bug class this module
 * exists to remove. Holds back at most ATTACH_CHROME.length bytes, only until the
 * first divergence, and is a pure passthrough afterward.
 */
export function createAltScreenStripper(): (data: Uint8Array) => Uint8Array {
  let held = Buffer.alloc(0)
  let done = false
  return (data: Uint8Array): Uint8Array => {
    if (done) return data
    held = Buffer.concat([held, Buffer.from(data)])
    if (
      held.length <= ATTACH_CHROME.length &&
      ATTACH_CHROME.subarray(0, held.length).equals(held)
    ) {
      if (held.length === ATTACH_CHROME.length) {
        done = true // full prefix seen — swallow it
        return EMPTY
      }
      return EMPTY // still a plausible prefix — keep holding
    }
    done = true
    return held.length >= ATTACH_CHROME.length &&
      held.subarray(0, ATTACH_CHROME.length).equals(ATTACH_CHROME)
      ? held.subarray(ATTACH_CHROME.length)
      : held
  }
}

/** Delegate PtyProcess whose onData passes through the one-time chrome stripper. */
function stripAttachChrome(proc: PtyProcess, onReady: () => void): PtyProcess {
  const strip = createAltScreenStripper()
  let ready = false
  return {
    get pid() {
      return proc.pid
    },
    onData: (cb) =>
      proc.onData((d) => {
        if (!ready) {
          ready = true
          onReady()
        }
        const out = strip(d)
        if (out.length) cb(out)
      }),
    onExit: (cb) => proc.onExit(cb),
    write: (d) => proc.write(d),
    resize: (c, r) => proc.resize(c, r),
    kill: (s) => proc.kill(s),
  }
}

export interface AbducoSpawnOptions {
  label: string
  cmd: string
  args?: string[]
  cwd?: string
  cols: number
  rows: number
  env?: Record<string, string>
  /**
   * Variables to REMOVE from the environment the session app inherits.
   *
   * `env` can only add or overwrite, and for a credential that is not the same
   * thing: an empty `ANTHROPIC_API_KEY` is still a set `ANTHROPIC_API_KEY`, and
   * what a caller stripping provider keys means is that the child must resolve
   * as if the daemon had never carried them (POD-2059; the same removal the
   * non-durable spawn path does with `delete`).
   *
   * Applied to the CREATE call — the app's own environment. The attach client is
   * abduco itself and reads none of this.
   */
  stripEnv?: readonly string[]
  /**
   * Preserve replay already owned by a browser when adopting a live master.
   * Such an adoption must not trigger the attach client's initial repaint,
   * because that repaint clears retained scrollback. Defaults false so
   * ordinary/headed reattach keeps its blank-screen recovery repaint.
   */
  preserveReplayOnAdopt?: boolean

  backend?: PtyBackend
  /**
   * What this master is, for the scope budget (POD-2413). `'attach'` is a
   * client TUI parked beside a session: it gets a terminal-sized budget rather
   * than an agent's, so a warm attachment can never be what pushes the instance
   * over its aggregate throttle — and it is the first thing given back under
   * pressure. Default `'session'`: the agent's own process tree.
   */
  scopeRole?: ScopeRole
}

/**
 * Awaited process creation with the child's stderr preserved in the thrown error.
 *
 * A bare child-process failure only reports the command; the actual diagnosis is on
 * the child's stderr, which `stdio: 'ignore'` threw away. That blindness is what
 * turned an abduco create failing with the one-line "create-session: File name
 * too long" into a session that produced no output and an e2e timeout 20s later
 * — and sent the first investigation chasing systemd, which was only relaying
 * the inner abduco's exit status. [spec:SP-0be7]
 *
 * stderr is redirected to a FILE, never a pipe: abduco daemonizes the master,
 * which inherits this fd, and waiting for pipe EOF would
 * block the create call until the whole agent session exited.
 */
async function execCreate(file: string, args: string[], options: SpawnOptions): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'podium-abduco-err-'))
  const errPath = join(dir, 'stderr')
  const fd = openSync(errPath, 'w')
  try {
    await new Promise<void>((resolve, reject) => {
      const child = spawn(file, args, { ...options, stdio: ['ignore', 'ignore', fd] })
      child.once('error', reject)
      child.once('exit', (code, signal) => {
        if (code === 0) resolve()
        else reject(new Error(`${file} exited ${code ?? `from ${signal ?? 'an unknown signal'}`}`))
      })
    })
  } catch (err) {
    let detail = ''
    try {
      detail = readFileSync(errPath, 'utf8').trim()
    } catch {
      // the child may have failed before writing anything
    }
    if (!detail) throw err
    throw new Error(`${err instanceof Error ? err.message : String(err)}: ${detail}`)
  } finally {
    closeSync(fd)
    rmSync(dir, { recursive: true, force: true })
  }
}

/**
 * Say WHICH PATH was too long, and by how much (POD-2853).
 *
 * abduco's whole diagnosis of a socket path over `sun_path` is the eight words
 * "create-session: File name too long". It names neither the path it composed
 * nor the limit it measured against, and the path is not visible anywhere else:
 * it is built inside abduco out of `ABDUCO_SOCKET_DIR`, the user name, the
 * durable label and the hostname. A named instance hit this on EVERY spawn and
 * the message sent the first investigation to systemd, which was only relaying
 * the inner exit status.
 *
 * So the numbers are attached here, where the label and the environment are
 * both in hand. Only the length failure is rewritten — every other create
 * failure is returned untouched, because abduco's own text is the diagnosis for
 * those and a wrapper would only bury it.
 *
 * EVERY CANDIDATE IS LISTED, not just the first. abduco fails with ENAMETOOLONG
 * at the first root it managed to CREATE and then could not fit the name in,
 * and which root that was depends on `mkdir` results this side cannot see —
 * naming one would be a guess, and a confident wrong path is worse than the
 * message it replaced. The list is short (three or four entries) and shows at a
 * glance which root would have fitted.
 */
export function withComposedSocketPath(
  err: unknown,
  label: string,
  env: NodeJS.ProcessEnv,
): unknown {
  const message = err instanceof Error ? err.message : String(err)
  if (!/File name too long|ENAMETOOLONG/i.test(message)) return err
  const host = `@${hostname()}`
  const measured = abducoSocketDirs(env).map((dir) => {
    const bytes = abducoSocketPathBytes(`${dir}/`, label, host)
    return `${dir}/${label}${host} = ${bytes}`
  })
  if (measured.length === 0) return err
  return new Error(
    `${message} — no socket path may exceed ${ABDUCO_SUN_PATH_MAX} bytes, and abduco composes ` +
      `<dir>/<label>@<host>: ${measured.join('; ')}. ` +
      'Set ABDUCO_SOCKET_DIR to a shorter directory.',
  )
}

/**
 * Create a detached abduco session running the agent, then attach a client.
 * The session app inherits cwd/env from the CREATE call (abduco has no flags for
 * either); TERM/COLORTERM must be forced here — there is no tmux
 * `default-terminal` equivalent. Initial pty geometry is abduco's 80x25 default;
 * the attach client immediately resizes to cols×rows (abduco sends the size and
 * SIGWINCHes the app group on attach).
 */
export async function spawnAbducoAgent(opts: AbducoSpawnOptions): Promise<AgentSession> {
  const bin = resolveAbducoBin()
  if (!bin) throw new Error('abduco unavailable: not installed and the vendored build failed')
  const createArgs = abducoCreateArgv(opts.label, opts.cmd, opts.args ?? [])
  const childEnv: Record<string, string> = {
    ...scopeEnv(liveEnv()),
    TERM: 'xterm-256color',
    COLORTERM: 'truecolor',
    ...opts.env,
  }
  // AFTER the merge, so a caller cannot strip a variable it also set — the two
  // would otherwise depend on key order in an object literal.
  for (const key of opts.stripEnv ?? []) delete childEnv[key]
  // stdio is execCreate's to set: it captures stderr so a create failure
  // reports abduco's own diagnosis instead of a bare "Command failed".
  const execOpts = {
    cwd: opts.cwd ?? process.cwd(),
    env: childEnv,
  } as const
  // Bind-temp probes from killed creates accumulate in the socket dir;
  // every later spawn/reattach readdir pays for them. Sweep first so the
  // lookups below see live sockets, not thousands of leftover `.abduco-<pid>`.
  reapStaleAbducoBindTemps(childEnv)
  const attachTo = (
    socketPath: string,
    repaintOnAttach = true,
    sizeNeutral = false,
  ): AgentSession =>
    attachAbducoAgent({
      label: opts.label,
      socketPath,
      cols: opts.cols,
      rows: opts.rows,
      ...(opts.env ? { env: opts.env } : {}),
      ...(opts.backend ? { backend: opts.backend } : {}),
      repaintOnAttach,
      sizeNeutral,
    })
  const attachCreated = async (): Promise<AgentSession> =>
    attachTo(await waitForAbducoSocket(opts.label, childEnv))
  /**
   * A durable label is a constant of its session, so a respawn (every Resume) can
   * find the previous master still holding the name. abduco answers that with
   * "create-session: Address already in use", which used to end the session for good:
   * the daemon persists the raw failure as a spawn error and the row can never be
   * resumed again — while its agent is still running in its own scope (POD-1945).
   * A live master IS the session, so adopt it; the caller reports a reattach.
   */
  const adopt = (socketPath: string): AgentSession => {
    log.info('durable label already owned by a live master — adopting it', {
      label: opts.label,
      socketPath,
    })
    // Adopting a LIVE master: its program is already running at a size of its
    // own, so this attach must not move it.
    return { ...attachTo(socketPath, !opts.preserveReplayOnAdopt, true), adopted: true }
  }
  const live = abducoSocketPath(opts.label, childEnv)
  if (live) return adopt(live)
  // No live master, but a TERMINATED one can still hold the name (podium's liveness
  // index skips those; abduco's create does not). Clear it, or the create below dies.
  await reclaimTerminatedSession(opts.label, childEnv)
  /** Adopt when a create lost a race to a concurrent spawn of the same label. */
  const adoptRaceWinner = (): AgentSession | undefined => {
    const raced = abducoSocketPath(opts.label, childEnv)
    return raced ? adopt(raced) : undefined
  }
  if (childEnv.ABDUCO_SOCKET_DIR) {
    assertLinuxUnixSocketPath(
      abducoSocketPathname(childEnv.ABDUCO_SOCKET_DIR, opts.label, userInfo().username, hostname()),
      resolveInstanceId(childEnv),
      'an abduco session socket',
    )
  }
  // Create the master in its own systemd scope so it outlives a redeploy. `--scope`
  // runs in the foreground but returns the instant the create process exits — abduco
  // daemonizes the master and returns immediately, so timing matches the bare call.
  // (cwd/env are inherited by the scope, verified against the live user manager.)
  if (await canScopeMaster()) {
    // Reclaim a stale scope squatting this label's unit name first, or `systemd-run`
    // fails ("unit already exists") and the master falls into the daemon's cgroup —
    // where the next redeploy kills it (see scopeReclaimArgvs). Guarded on no live
    // master, so we only ever clear a zombie scope held open by orphaned grandchildren.
    await reclaimStaleScope(opts.label, childEnv)
    let createdInScope = false
    try {
      await execCreate(
        'systemd-run',
        systemdScopeArgv(scopeUnitName(opts.label), [bin, ...createArgs], {
          budget: resolveScopeBudget(opts.scopeRole ?? 'session'),
        }),
        execOpts,
      )
      createdInScope = true
      // The slice now exists, so its aggregate throttle can be set. Fire and
      // forget: a session must never wait on a best-effort budget call.
      void applySessionsSliceBudget()
    } catch (err) {
      // A concurrent spawn of the same label may have won: that master is the
      // session, and creating a second one is impossible anyway.
      const raced = adoptRaceWinner()
      if (raced) return raced
      // A direct master would be reaped on the next redeploy, so make the
      // degradation loud rather than silently reintroducing the original bug.
      //
      // BUT SAY WHICH FAILURE THIS IS (POD-2777). `systemd-run` also fails when
      // the socket path is too long, and the durability wording then blames the
      // wrong thing entirely: it promises a session that merely will not
      // survive a restart, when in fact nothing started and the direct create
      // below is about to fail for the same reason. Read top-down, the log told
      // an operator about restarts and never about a path or a limit.
      const detail = withComposedSocketPath(err, opts.label, childEnv)
      log.warn(
        detail === err
          ? 'systemd scope unavailable; session will NOT survive a podium restart'
          : 'the durable session socket path is too long — the session will not start at all',
        { label: opts.label, err: detail },
      )
    }
    // Do not treat an attach/readiness failure as a scope-launch failure: the
    // master is already alive, and creating a second one with the same label
    // would race the first and make the original client even less recoverable.
    if (createdInScope) return attachCreated()
  } else if (process.platform === 'linux' && !process.env.PODIUM_NO_SCOPE && !scopeWarned) {
    // Same degradation as the catch above, but on the no-user-manager path (system
    // service without lingering). Once per process, not per session.
    scopeWarned = true
    log.warn(
      'no systemd user manager reachable (XDG_RUNTIME_DIR/linger missing?); durable sessions ' +
        'will NOT survive a podium restart — run `loginctl enable-linger <user>`',
    )
  }
  try {
    await execCreate(bin, createArgs, execOpts)
  } catch (err) {
    const raced = adoptRaceWinner()
    if (!raced) throw withComposedSocketPath(err, opts.label, childEnv)
    return raced
  }
  return attachCreated()
}

/**
 * Attach a Bun.Terminal client to an existing abduco session. dispose() SIGKILLs the
 * client (the master + agent survive) — a hard kill on purpose: the client's atexit
 * handler would otherwise print cursor/alt-screen restore chrome into the stream.
 *
 * The attach nudges a repaint: abduco only SIGWINCHes the app's process group, and
 * node-based TUIs (Claude Code included) repaint only when the dimensions actually
 * CHANGE — so reattaching at the previous geometry would show a blank screen.
 * redraw()'s shrink/restore is ack-based (restores after the app's first frame), so
 * it lands correctly even while the abduco client is still connecting.
 */
/**
 * How long a size-neutral attach waits for its client to connect before
 * repainting anyway. Long enough for a local socket attach, short enough that a
 * reconnected viewer is not left looking at nothing.
 */
const ATTACH_REPAINT_FALLBACK_MS = 1000

/**
 * The size a size-neutral attach opens its pty at. `-N` means these dimensions
 * are never announced, so they are never the program's size and the value is
 * free — and it must NOT be the caller's last-known geometry, because a viewer's
 * first ask is usually for exactly that: it would be a no-op change here and
 * never reach the program, or would need a forced shrink-and-restore that moves
 * the program by a row. A size no viewer can ask for keeps every real ask a
 * single resize: one packet, one SIGWINCH, no reflow [spec:SP-6144].
 */
const SIZE_NEUTRAL_ATTACH_GEOMETRY = { cols: 1, rows: 1 } as const

export function attachAbducoAgent(opts: {
  label: string
  /** Existing socket path, when recovery found a host-suffixed socket. */
  socketPath?: string
  cols: number
  rows: number
  env?: Record<string, string>
  /** Reattaching a shell: nudge with Ctrl-L too, since it won't repaint on SIGWINCH while idle. */
  hardRepaint?: boolean
  /**
   * False only after `spawnAbducoAgent` proved this is a live-master adoption.
   * Fresh attaches default true; explicit redraw remains available afterward.
   */
  repaintOnAttach?: boolean
  /**
   * Attach without announcing a size (`-N`): the running program is neither
   * resized nor signalled by this attach. `cols`/`rows` are then IGNORED for the
   * attach pty, which opens at a sentinel size — they stay the caller's record
   * of the session's geometry, never a claim about the program's.
   * Every attach to an ALREADY RUNNING program wants this — a reconnect
   * is not a viewer asking for a size, and the caller's last-known size may be
   * stale. The exception is the attach right after a create: the master's pty is
   * forked at abduco's own default (80x25, it has no tty), and that first
   * attach's resize packet is the only thing that moves the program to the
   * requested size [spec:SP-6144].
   */
  sizeNeutral?: boolean
  backend?: PtyBackend
}): AgentSession {
  const attach = resolveAttachBin(opts.sizeNeutral ?? false)
  const [cmd, ...args] = abducoAttachArgv(opts.socketPath ?? opts.label, attach.bin, {
    sizeNeutral: attach.sizeNeutral,
  })
  const backend = opts.backend ?? defaultPtyBackend()
  const geometry = attach.sizeNeutral ? SIZE_NEUTRAL_ATTACH_GEOMETRY : opts
  const proc = backend.spawn({
    file: cmd as string,
    args,
    cols: geometry.cols,
    rows: geometry.rows,
    env: { ...process.env, COLORTERM: 'truecolor', ...opts.env } as Record<string, string>,
  })
  let ready = false
  let repaintPending = false
  let session: AgentSession
  let repaintTimer: ReturnType<typeof setTimeout> | undefined
  const flushRepaint = (): void => {
    if (repaintTimer) clearTimeout(repaintTimer)
    repaintTimer = undefined
    if (!repaintPending) return
    repaintPending = false
    session.redraw()
  }
  const filtered = stripAttachChrome(proc, () => {
    ready = true
    flushRepaint()
  })
  session = withHardRepaint(
    wrapPty(filtered, {
      cols: geometry.cols,
      rows: geometry.rows,
      sizeNeutral: attach.sizeNeutral,
    }),
    opts.hardRepaint ?? false,
  )
  if (opts.repaintOnAttach ?? true) {
    if (attach.sizeNeutral) {
      // A size-neutral attach repaints nothing by itself — the viewer's first ask
      // does that. All this can still deliver is a SHELL's hard Ctrl-L, and a
      // keystroke written before the attach client has taken the attach pty out
      // of canonical mode sits in its line buffer — echoed, and delivered glued
      // to whatever the viewer types next (measured: the agent read `0c796f0a`
      // as one chunk). So wait for the client's first byte, with a fallback for a
      // session quiet enough that none comes.
      repaintPending = true
      repaintTimer = setTimeout(flushRepaint, ATTACH_REPAINT_FALLBACK_MS)
      repaintTimer.unref?.()
    } else session.redraw()
  }
  return {
    ...session,
    redrawWhenReady() {
      if (ready) {
        session.redraw()
        return
      }
      repaintPending = true
    },

    dispose() {
      if (repaintTimer) clearTimeout(repaintTimer)
      repaintTimer = undefined
      try {
        proc.kill('SIGKILL')
      } catch {
        // already exited
      }
      session.dispose()
    },
  }
}
