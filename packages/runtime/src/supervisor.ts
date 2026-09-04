/**
 * Parent-death watchdog: tie a supervised backend's lifetime to the shell that
 * spawned it (POD-1228).
 *
 * Podium Desktop spawns `podium [--takeover]` as a sidecar and reaps it from
 * Tauri's `RunEvent::Exit` / `WindowEvent::Destroyed` handlers. That covers a
 * deliberate quit and nothing else: a GUI crash, a SIGKILL, or a plain SIGTERM
 * runs none of the shell's exit code, so the sidecar is simply reparented and
 * keeps running — holding the fixed hook-ingest port (45777) and the sessions it
 * had open. The next launch then binds a fresh server port, finds hook-ingest
 * already taken, and the daemon host dies on the conflict.
 *
 * No exit path the supervisor has to execute can fix that, because the failure
 * mode is precisely "the supervisor executed nothing". So the check lives on
 * THIS side: the shell exports its own PID as `PODIUM_SUPERVISOR_PID`, and a
 * supervised process shuts itself down as soon as that PID is gone.
 *
 * Three exit cues cover deliberate shutdown plus both supervisor-loss shapes:
 *
 *  - **Shutdown marker.** The shell writes a PID-scoped file before reaping the
 *    child. This is the portable graceful-shutdown request, including Windows.
 *  - **Reparenting.** When we were spawned directly by the supervisor, our ppid
 *    IS its pid; the kernel changes it to init/launchd the moment the supervisor
 *    dies. Exact and immune to PID reuse, but only available for a direct child.
 *  - **Liveness.** `kill(pid, 0)` covers the indirect case (a wrapper between us
 *    and the shell), where ppid was never the supervisor's to begin with.
 *
 * A process that means to outlive its launcher, including every `detached: true`
 * spawn in the tree, must not inherit either supervisor signal.
 * {@link unsupervisedEnv} strips both for exactly those spawns.
 */
import { createLogger } from '@podium/logger'
import { existsSync } from 'node:fs'
import { isAlive } from './run-registry'

const log = createLogger('runtime:supervisor')

/** Set by the desktop shell (apps/desktop/src-tauri/src/main.rs) to its own PID. */
export const SUPERVISOR_PID_ENV = 'PODIUM_SUPERVISOR_PID'
/**
 * Optional file the desktop shell creates for a deliberate, graceful shutdown.
 * Windows has no SIGTERM equivalent in `std::process`; the file gives every OS
 * the same bounded close path without adding a localhost control endpoint.
 */
export const SUPERVISOR_SHUTDOWN_FILE_ENV = 'PODIUM_SUPERVISOR_SHUTDOWN_FILE'

/**
 * How often to re-check the supervisor. A second is far below the window in
 * which a relaunch could collide with us (the human has to notice the crash and
 * reopen the app), and the check is two syscalls.
 */
export const SUPERVISOR_POLL_MS = 1_000

export type EnvSnapshot = Readonly<Record<string, string | undefined>>

/**
 * The supervisor PID this process was launched under, or undefined when it is
 * not supervised. Rejects a malformed value and our own PID — a self-reference
 * would make the watchdog wait forever on a process that is us.
 */
export function readSupervisorPid(env: EnvSnapshot, selfPid = process.pid): number | undefined {
  const raw = env[SUPERVISOR_PID_ENV]
  if (raw === undefined || raw === '') return undefined
  const pid = Number(raw)
  if (!Number.isSafeInteger(pid) || pid <= 1) return undefined
  return pid === selfPid ? undefined : pid
}

export interface SupervisorProbe {
  /** This process's parent PID; `process.ppid` in production. */
  ppid: () => number
  /** Is `pid` a live process? {@link isAlive} in production. */
  alive: (pid: number) => boolean
  /** Has the desktop shell written its deliberate-shutdown marker? */
  shutdownRequested: (path: string) => boolean
}

const realProbe: SupervisorProbe = {
  ppid: () => process.ppid,
  alive: (pid) => isAlive(pid),
  shutdownRequested: (path) => existsSync(path),
}

/**
 * Has the supervisor gone away?
 *
 * `directChild` is decided ONCE, at watch start, by comparing our ppid to the
 * supervisor's pid. It cannot be re-derived per poll: after the supervisor dies
 * our ppid no longer matches, which is the very thing being detected.
 */
export function supervisorGone(
  supervisorPid: number,
  directChild: boolean,
  probe: SupervisorProbe = realProbe,
): boolean {
  if (directChild && probe.ppid() !== supervisorPid) return true
  return !probe.alive(supervisorPid)
}

/**
 * The repeating-timer seam, as start-returns-its-own-stop rather than a handle. A handle would
 * have to be typed `ReturnType<typeof setInterval>`, which is `Timeout` under the Node lib and
 * `number` under the DOM one — and this module is compiled under both.
 */
export interface IntervalScheduler {
  every: (ms: number, callback: () => void) => () => void
}

const realScheduler: IntervalScheduler = {
  every: (ms, callback) => {
    const timer = setInterval(callback, ms)
    // Never a reason for a process to stay up: the server it watches is what holds the loop open.
    ;(timer as unknown as { unref?: () => void }).unref?.()
    return () => clearInterval(timer)
  },
}

export interface SupervisorWatchOptions {
  env?: EnvSnapshot
  probe?: SupervisorProbe
  intervalMs?: number
  /** Test seam; production polls on a real, unref'd interval. */
  scheduler?: IntervalScheduler
}

/**
 * Start watching the supervisor named by `PODIUM_SUPERVISOR_PID`; call
 * `onOrphaned` once when it dies. Returns a stop fn, or undefined when this
 * process is not supervised — so callers can `?.()` it on their own shutdown
 * without asking whether the watch ever started.
 *
 * `onOrphaned` should be the process's ordinary SIGTERM shutdown: the point is
 * that the sidecar leaves the same way the shell would have made it leave, not
 * that it dies harder.
 */
export function watchSupervisor(
  onOrphaned: (supervisorPid: number) => void,
  options: SupervisorWatchOptions = {},
): (() => void) | undefined {
  const probe = options.probe ?? realProbe
  const supervisorPid = readSupervisorPid(options.env ?? process.env)
  if (supervisorPid === undefined) return undefined

  const directChild = probe.ppid() === supervisorPid
  const shutdownFile =
    options.env?.[SUPERVISOR_SHUTDOWN_FILE_ENV] ?? process.env[SUPERVISOR_SHUTDOWN_FILE_ENV]
  const scheduler = options.scheduler ?? realScheduler

  // `stop` is only readable once `every` has returned it; a scheduler that fires
  // its callback synchronously would otherwise reach it before it exists.
  let stop: (() => void) | undefined
  let fired = false
  const check = (): void => {
    if (fired) return
    const requested =
      shutdownFile !== undefined && shutdownFile !== '' && probe.shutdownRequested(shutdownFile)
    if (!requested && !supervisorGone(supervisorPid, directChild, probe)) return
    fired = true
    stop?.()
    if (requested) {
      log.info('supervisor requested graceful shutdown', { supervisorPid })
    } else {
      log.warn('supervisor exited — shutting down with it', { supervisorPid, directChild })
    }
    onOrphaned(supervisorPid)
  }

  const stopWatch = scheduler.every(options.intervalMs ?? SUPERVISOR_POLL_MS, check)
  stop = stopWatch
  // The supervisor may already be gone by the time we finish booting (it crashed
  // during our startup). Check immediately rather than serving for a full poll
  // interval as an orphan.
  check()
  return stopWatch
}

/**
 * A copy of `env` with the supervisor PID and shutdown marker removed, for a spawn that is MEANT to
 * outlive this process (`detached: true`). Without this a detached successor
 * inherits our supervisor and takes itself down when the shell dies — which is
 * the opposite of what detaching it was for.
 *
 * `PODIUM_DESKTOP_SUPERVISED` deliberately stays: it says how this machine's
 * backend is being run (log sink, setup defaults, transfer routing), which is
 * still true of the successor. Only the pid-to-die-with is inapplicable.
 */
export function unsupervisedEnv<T extends Record<string, string | undefined>>(env: T): T {
  const copy = { ...env }
  delete copy[SUPERVISOR_PID_ENV]
  delete copy[SUPERVISOR_SHUTDOWN_FILE_ENV]
  return copy
}
