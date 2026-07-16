import { execFile, execFileSync, spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { promisify } from 'node:util'
import { resolveAbducoBin } from './abduco-bin.js'
import { defaultPtyBackend } from './pty/index.js'
import type { PtyBackend, PtyProcess } from './pty/types.js'
import { type AgentSession, withHardRepaint, wrapPty } from './session'
import { shellQuote } from './tmux.js'

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
export function abducoAttachArgv(label: string, bin = 'abduco'): string[] {
  return ['sh', '-c', `exec ${shellQuote(bin)} -q -e "$(printf '\\377')" -a "$0"`, label]
}

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
 */
export function systemdScopeArgv(unit: string, command: string[]): string[] {
  return [
    '--user',
    '--scope',
    '--collect',
    '--quiet',
    '--property=CPUWeight=50',
    '--property=IOWeight=100',
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

/**
 * Free a stale scope squatting this label's unit name so the master can be (re)created
 * in its OWN scope. Guarded on there being NO live master for the label — we only ever
 * clear a zombie scope held open by orphaned grandchildren, never a live agent. Sync to
 * match {@link spawnAbducoAgent}; runs only on the (re)spawn path, not per frame.
 * Best-effort: a missing unit or absent systemd just makes the commands no-ops.
 */
function reclaimStaleScope(label: string): void {
  if (abducoHasSession(label)) return
  for (const args of scopeReclaimArgvs(scopeUnitName(label))) {
    try {
      spawnSync('systemctl', args, {
        stdio: 'ignore',
        timeout: 8000,
        env: scopeEnv(process.env),
      })
    } catch {
      // best-effort: no such unit / no systemd
    }
  }
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

let scopeChecked = false
let scopeOk = false
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
export function canScopeMaster(): boolean {
  if (scopeChecked) return scopeOk
  scopeChecked = true
  scopeOk =
    !process.env.PODIUM_NO_SCOPE &&
    process.platform === 'linux' &&
    userRuntimeDir() !== undefined &&
    spawnSync('systemd-run', ['--user', '--scope', '--collect', '--quiet', '--', 'true'], {
      stdio: 'ignore',
      timeout: 8000,
      env: scopeEnv(process.env),
    }).status === 0
  return scopeOk
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

function listSessions(): AbducoSessionEntry[] {
  // `abduco` with no args lists sessions; it also reaps stale sockets as a side
  // effect. Exit status varies by version, so parse whatever it printed.
  const bin = resolveAbducoBin()
  if (!bin) return []
  const res = spawnSync(bin, [], { encoding: 'utf8' })
  return parseAbducoList(res.stdout ?? '')
}

export function abducoHasSession(label: string): boolean {
  try {
    return listSessions().some((s) => s.name === label && s.alive)
  } catch {
    return false
  }
}

const execFileAsync = promisify(execFile)

/**
 * Async twin of {@link listSessions}. The sync version does a blocking `spawnSync`
 * on the main thread; on the daemon's reattach path that runs once per session and,
 * for ~30 durable sessions, back-to-back `fork+exec` calls starve the event loop so
 * the server can't accept connections. This variant lets the caller `await` it,
 * keeping the loop responsive.
 */
async function listSessionsAsync(): Promise<AbducoSessionEntry[]> {
  const bin = resolveAbducoBin()
  if (!bin) return []
  try {
    const { stdout } = await execFileAsync(bin, [], { encoding: 'utf8' })
    return parseAbducoList(stdout ?? '')
  } catch (err) {
    // `abduco` exits non-zero on some versions even when it printed a valid list;
    // recover whatever it wrote to stdout before giving up.
    const stdout = (err as { stdout?: string })?.stdout
    return stdout ? parseAbducoList(stdout) : []
  }
}

/** Non-blocking {@link abducoHasSession}. Prefer this on hot paths (reattach). */
export async function abducoHasSessionAsync(label: string): Promise<boolean> {
  try {
    return (await listSessionsAsync()).some((s) => s.name === label && s.alive)
  } catch {
    return false
  }
}

/** SIGTERM the session master — verified to take the app down and clean the socket. */
export function killAbducoSession(label: string): void {
  try {
    const entry = listSessions().find((s) => s.name === label && s.alive)
    if (entry) process.kill(entry.pid, 'SIGTERM')
  } catch {
    // already gone
  }
}

/**
 * Non-blocking {@link killAbducoSession}. The sync version does a blocking
 * `spawnSync(abduco)` (which forks+execs and reaps sockets while listing) on the
 * daemon loop; the `kill` control-message handler is a per-session action that arrives
 * in bursts (superagent killing several agents, auto-hibernation), so serializing
 * those fork+execs starves every other session. Prefer this on that hot path — the
 * sync version stays fine for one-shot shutdown teardown (disposeAll).
 */
export async function killAbducoSessionAsync(label: string): Promise<void> {
  try {
    const entry = (await listSessionsAsync()).find((s) => s.name === label && s.alive)
    if (entry) process.kill(entry.pid, 'SIGTERM')
  } catch {
    // already gone
  }
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
function stripAttachChrome(proc: PtyProcess): PtyProcess {
  const strip = createAltScreenStripper()
  return {
    get pid() {
      return proc.pid
    },
    onData: (cb) =>
      proc.onData((d) => {
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
  backend?: PtyBackend
}

/**
 * Create a detached abduco session running the agent, then attach a client.
 * The session app inherits cwd/env from the CREATE call (abduco has no flags for
 * either); TERM/COLORTERM must be forced here — there is no tmux
 * `default-terminal` equivalent. Initial pty geometry is abduco's 80x25 default;
 * the attach client immediately resizes to cols×rows (abduco sends the size and
 * SIGWINCHes the app group on attach).
 */
export function spawnAbducoAgent(opts: AbducoSpawnOptions): AgentSession {
  const bin = resolveAbducoBin()
  if (!bin) throw new Error('abduco unavailable: not installed and the vendored build failed')
  const createArgs = abducoCreateArgv(opts.label, opts.cmd, opts.args ?? [])
  const execOpts = {
    stdio: 'ignore',
    cwd: opts.cwd ?? process.cwd(),
    env: {
      ...scopeEnv(process.env),
      TERM: 'xterm-256color',
      COLORTERM: 'truecolor',
      ...opts.env,
    },
  } as const
  // Create the master in its own systemd scope so it outlives a redeploy. `--scope`
  // runs in the foreground but returns the instant the create process exits — abduco
  // daemonizes the master and returns immediately, so timing matches the bare call.
  // (cwd/env are inherited by the scope, verified against the live user manager.)
  if (canScopeMaster()) {
    // Reclaim a stale scope squatting this label's unit name first, or `systemd-run`
    // fails ("unit already exists") and the master falls into the daemon's cgroup —
    // where the next redeploy kills it (see scopeReclaimArgvs). Guarded on no live
    // master, so we only ever clear a zombie scope held open by orphaned grandchildren.
    reclaimStaleScope(opts.label)
    try {
      execFileSync(
        'systemd-run',
        systemdScopeArgv(scopeUnitName(opts.label), [bin, ...createArgs]),
        execOpts,
      )
      return attachAbducoAgent({
        label: opts.label,
        cols: opts.cols,
        rows: opts.rows,
        ...(opts.env ? { env: opts.env } : {}),
        ...(opts.backend ? { backend: opts.backend } : {}),
      })
    } catch (err) {
      // A direct master would be reaped on the next redeploy, so make the
      // degradation loud rather than silently reintroducing the original bug.
      console.warn(
        `[podium] systemd scope unavailable for ${opts.label}; session will NOT survive a podium restart: ${err instanceof Error ? err.message : String(err)}`,
      )
    }
  } else if (process.platform === 'linux' && !process.env.PODIUM_NO_SCOPE && !scopeWarned) {
    // Same degradation as the catch above, but on the no-user-manager path (system
    // service without lingering). Once per process, not per session.
    scopeWarned = true
    console.warn(
      '[podium] no systemd user manager reachable (XDG_RUNTIME_DIR/linger missing?); durable sessions will NOT survive a podium restart — run `loginctl enable-linger <user>`',
    )
  }
  execFileSync(bin, createArgs, execOpts)
  return attachAbducoAgent({
    label: opts.label,
    cols: opts.cols,
    rows: opts.rows,
    ...(opts.env ? { env: opts.env } : {}),
    ...(opts.backend ? { backend: opts.backend } : {}),
  })
}

/**
 * Attach a node-pty client to an existing abduco session. dispose() SIGKILLs the
 * client (the master + agent survive) — a hard kill on purpose: the client's atexit
 * handler would otherwise print cursor/alt-screen restore chrome into the stream.
 *
 * The attach nudges a repaint: abduco only SIGWINCHes the app's process group, and
 * node-based TUIs (Claude Code included) repaint only when the dimensions actually
 * CHANGE — so reattaching at the previous geometry would show a blank screen.
 * redraw()'s shrink/restore is ack-based (restores after the app's first frame), so
 * it lands correctly even while the abduco client is still connecting.
 */
export function attachAbducoAgent(opts: {
  label: string
  cols: number
  rows: number
  env?: Record<string, string>
  /** Reattaching a shell: nudge with Ctrl-L too, since it won't repaint on SIGWINCH while idle. */
  hardRepaint?: boolean
  backend?: PtyBackend
}): AgentSession {
  const [cmd, ...args] = abducoAttachArgv(opts.label, resolveAbducoBin() ?? 'abduco')
  const backend = opts.backend ?? defaultPtyBackend()
  const proc = backend.spawn({
    file: cmd as string,
    args,
    cols: opts.cols,
    rows: opts.rows,
    env: { ...process.env, COLORTERM: 'truecolor', ...opts.env } as Record<string, string>,
  })
  const session = withHardRepaint(
    wrapPty(stripAttachChrome(proc), { cols: opts.cols, rows: opts.rows }),
    opts.hardRepaint ?? false,
  )
  session.redraw()
  return {
    ...session,
    dispose() {
      try {
        proc.kill('SIGKILL')
      } catch {
        // already exited
      }
      session.dispose()
    },
  }
}
