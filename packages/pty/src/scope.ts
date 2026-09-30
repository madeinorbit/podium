import { execFile, type SpawnOptions, spawn } from 'node:child_process'
import { closeSync, existsSync, mkdtempSync, openSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { createLogger } from '@podium/logger'
import { instanceSessionSliceName } from '@podium/runtime/instance'
import {
  resolveScopeBudget,
  resolveSessionsSliceHigh,
  type ScopeBudget,
  type ScopeRole,
  scopeBudgetProperties,
  sliceBudgetArgv,
} from '@podium/runtime/scope'

const log = createLogger('pty:scope')

/**
 * The systemd side of a durable session: the transient `--user` scope that puts
 * a podium-host (and every child it runs) outside the daemon's cgroup, the
 * sessions-slice budget, and the spawn options every durable create shares.
 *
 * MOVED from `abduco.ts` when the abduco backend was deleted (POD-4986): the
 * scope was never abduco's — every durable spawn path (podium-host, codex
 * app-server, grok ACP, opencode serve) comes through {@link systemdScopeArgv}.
 */

/**
 * argv for `systemd-run` that launches `command` in its OWN transient `--user`
 * scope. THIS is what makes agents and shells survive a podium redeploy/crash.
 *
 * Without it the host is a child of the spawning service and lives in that
 * service's cgroup. `systemctl restart podium-backend.service` (the redeploy)
 * uses the systemd default `KillMode=control-group`, which SIGTERMs every process
 * in the cgroup — the host and its agent included. A setsid detaches the
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
 * four spawn paths (podium-host, codex app-server, grok ACP, opencode serve)
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

/** Injection seam for the scope's `systemctl` calls (tests pass a spy). */
export type SystemctlRunner = (
  file: string,
  args: string[],
  options: { timeout: number; env: NodeJS.ProcessEnv },
) => Promise<unknown>

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
export function scopeEnv(base: NodeJS.ProcessEnv): Record<string, string> {
  const dir = userRuntimeDir()
  return { ...base, ...(dir ? { XDG_RUNTIME_DIR: dir } : {}) } as Record<string, string>
}

let scopeOk: boolean | undefined
let scopeInFlight: Promise<boolean> | undefined

/**
 * Whether a durable host can be launched in its own systemd scope: a Linux
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
 * Live env snapshot for child `podium-host`/`systemctl` calls.
 *
 * Bun's `spawnSync`/`execFileSync` (unlike Node) ignore mid-process
 * `process.env` mutations when `env` is omitted — they reuse the process-start
 * environment. That breaks HOME isolation in tests (session created under a
 * temp `$HOME` via an explicit `env`, then "not found" by a bare listing) and would also miss any runtime env change in production. Always pass
 * the live map. [spec:SP-3f93]
 */
export function liveEnv(): NodeJS.ProcessEnv {
  return { ...process.env }
}

const execFileAsync = promisify(execFile)

/**
 * The kill path's scope sweep:
 * stop the label's transient scope unit and clear its unit state. Best-effort —
 * no systemd, an unscoped spawn (fallback path), or an already-gone unit all
 * make these no-ops.
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

/** What every durable create carries (formerly `AbducoSpawnOptions`). */
export interface DurableSpawnOptions {
  label: string
  cmd: string
  args?: string[]
  cwd?: string
  /**
   * The pty size, for terminal sessions. Absent only beside `noPty`: a pty
   * forked at a junk size is how a session starts disagreeing with its first
   * viewer, so a pty spawn without geometry is refused rather than defaulted.
   */
  cols?: number
  rows?: number
  /**
   * Headless engines (codex app-server, opencode serve, grok stdio) run under
   * podium-host with pipes instead of a pty (`--no-pty`).
   */
  noPty?: boolean
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
   * Applied to the CREATE call — the app's own environment.
   */
  stripEnv?: readonly string[]
  /**
   * What this master is, for the scope budget (POD-2413). `'attach'` is a
   * client TUI parked beside a session: it gets a terminal-sized budget rather
   * than an agent's, so a warm attachment can never be what pushes the instance
   * over its aggregate throttle — and it is the first thing given back under
   * pressure. Default `'session'`: the agent's own process tree.
   */
  scopeRole?: ScopeRole
  /**
   * Refuse when the host grants no writer lease (POD-4434). Headless engine
   * spawns leave it off and judge the lease themselves (POD-4433).
   */
  requireLease?: boolean
}

/**
 * Awaited process creation with the child's stderr preserved in the thrown error.
 *
 * A bare child-process failure only reports the command; the actual diagnosis is on
 * the child's stderr, which `stdio: 'ignore'` threw away. That blindness once
 * turned a create failing with a one-line "File name too long" into a session
 * that produced no output and an e2e timeout 20s later — and sent the first
 * investigation chasing systemd, which was only relaying the inner exit status.
 * [spec:SP-0be7]
 *
 * stderr is redirected to a FILE, never a pipe: the host daemonizes and
 * inherits this fd, and waiting for pipe EOF would block the create call until
 * the whole agent session exited.
 */
export async function execCreate(
  file: string,
  args: string[],
  options: SpawnOptions,
): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'podium-create-err-'))
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
