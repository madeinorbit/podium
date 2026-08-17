/**
 * One boot kernel for the long-running Podium processes (server / daemon / host).
 * Each entrypoint in scripts/ is a thin composition over `bootProcess`; the shared
 * boot/shutdown semantics live here so the three processes can't silently diverge
 * (the combined dev host went without a crash net for a while purely through
 * divergence). What the kernel guarantees, in order:
 *
 *  - Logging sinks FIRST (configureProcessLogging): the crash net and every boot
 *    message now report through `@podium/logger`, and a logger with no sink
 *    registered discards what it is given. So the sink has to exist before the
 *    first thing that might need to say something does. This is cheap and
 *    IO-free — the file sink opens lazily on its first record — so it does not
 *    meaningfully delay the crash net behind it.
 *  - Crash net SECOND (installProcessSafetyNet, audit P0-1): an un-caught rejection
 *    or escaped throw — a dead socket's send, a throw from a PTY data callback —
 *    must log-and-survive, not terminate the process and drop every session.
 *  - Boot watchdog: under host memory pressure startup can intermittently wedge
 *    mid-init — the process stays alive but never finishes booting, so the service
 *    never serves and `Restart=always` (which only fires on EXIT) can't recover it.
 *    If boot hasn't completed in time, exit non-zero so systemd restarts us and
 *    retries — a fresh attempt usually lands in a freer memory window. Healthy
 *    boots finish in ~1-2s; the 45s default is generous headroom. Pass
 *    `bootTimeoutMs: null` for processes whose boot is provably bounded.
 *  - Systemd watchdog pet (startWatchdog, audit P0-3): with Type=notify +
 *    WatchdogSec on the unit, a wedged event loop stops petting and systemd
 *    restarts us — the only thing that catches a wedged-but-alive process (the
 *    documented big-paste msg-loop wedge). No-op outside notify units (dev/tests).
 *  - Supervisor watchdog (watchSupervisor, POD-1228): when a GUI shell spawned us
 *    and exports its PID, its death is our shutdown signal. The shell's own exit
 *    handlers cannot cover a crash or a SIGKILL — nothing of the shell runs then —
 *    so the orphan has to notice on its own or it keeps the ports and sessions.
 *  - Bounded close on SIGINT/SIGTERM: Bun's node:http `close()` can wait on
 *    lingering keep-alive sockets that Node drains promptly, which would stall
 *    SIGTERM until systemd SIGKILLs. Racing `close()` against `closeTimeoutMs`
 *    keeps shutdown prompt; on Node the close resolves first, so it's a no-op.
 *  - Stays alive (`await new Promise(() => {})`) until a signal arrives.
 *  - Drains the log sink on the way out, after close() and before exit, so the
 *    last records of a clean shutdown are on disk rather than in a dead process.
 */
import { createLogger } from '@podium/logger'
import { configureProcessLogging, type ProcessLogging } from './logging'
import { installProcessSafetyNet } from './process-safety'
import { startWatchdog } from './sd-notify'
import { watchSupervisor } from './supervisor'

export interface BootHandle {
  close: () => Promise<void> | void
}

export interface BootSpec<H extends BootHandle = BootHandle> {
  /** 'server' | 'daemon' | 'host' — used in log prefixes. */
  name: string
  /** Default true: register this role's log sink FIRST, before anything else. */
  logging?: boolean
  /** Default true: installProcessSafetyNet(name), immediately after logging. */
  safetyNet?: boolean
  /** null disables; default Number(process.env.PODIUM_BOOT_TIMEOUT_MS ?? 45_000). */
  bootTimeoutMs?: number | null
  /** Default true: startWatchdog() after start (no-op outside notify units). */
  watchdog?: boolean
  /** Default 4000; close() is raced against this on shutdown. */
  closeTimeoutMs?: number
  start: () => Promise<H>
  /** Logged after a successful start. */
  readyMessage?: (handle: H) => string
}

/**
 * Injectable process seam so the kernel is unit-testable without killing the test
 * runner (same style as the injected-env seam in sd-notify). Production uses the
 * real process; tests pass spies and a resolving `stayAlive`.
 */
export interface BootProc {
  exit: (code: number) => void
  onSignal: (signal: 'SIGINT' | 'SIGTERM', handler: () => void) => void
  /**
   * Register the process's log sink and bind its context. Returns the handle the
   * shutdown drain uses, or undefined when the caller runs its own logging.
   * A seam like the others: a unit test must not write to the real log dir.
   */
  configureLogging: (role: string) => ProcessLogging | undefined
  installSafetyNet: (name: string) => void
  startWatchdog: () => (() => void) | undefined
  /**
   * Start the parent-death watch, calling `onOrphaned` if the supervising shell
   * dies. Returns undefined (nothing to stop) when this process is unsupervised.
   */
  watchSupervisor: (onOrphaned: () => void) => (() => void) | undefined
  /**
   * Boot's own diagnostics. `fields` is structured context, NOT interpolation:
   * the message stays a constant so it can be grouped, and the varying parts
   * (role, timeout, the error) are queryable columns.
   */
  log: (msg: string, fields?: Record<string, unknown>) => void
  error: (msg: string, fields?: Record<string, unknown>) => void
  /** Never resolves in production — the entrypoint stays alive until a signal. */
  stayAlive: () => Promise<void>
}

const bootLog = createLogger('runtime:boot')

const realProc: BootProc = {
  exit: (code) => process.exit(code),
  onSignal: (signal, handler) => {
    process.on(signal, handler)
  },
  configureLogging: (role) => configureProcessLogging({ role }),
  installSafetyNet: installProcessSafetyNet,
  startWatchdog,
  watchSupervisor: (onOrphaned) => watchSupervisor(onOrphaned),
  log: (msg, fields) => bootLog.info(msg, fields),
  error: (msg, fields) => bootLog.error(msg, fields),
  stayAlive: () => new Promise<void>(() => {}),
}

export async function bootProcess<H extends BootHandle>(
  spec: BootSpec<H>,
  proc: BootProc = realProc,
): Promise<void> {
  // Sinks before the crash net, crash net before everything else — see the
  // header. Both are cheap and neither does IO at this point.
  const logging = spec.logging === false ? undefined : proc.configureLogging(spec.name)
  if (spec.safetyNet !== false) proc.installSafetyNet(spec.name)

  const bootTimeoutMs =
    spec.bootTimeoutMs === undefined
      ? Number(process.env.PODIUM_BOOT_TIMEOUT_MS ?? 45_000)
      : spec.bootTimeoutMs
  // Timeout is TERMINAL: in production proc.exit(1) never returns, but with an
  // injectable proc (tests) a late-resolving start() must not continue into
  // readiness and later double-exit(0).
  let bootTimedOut = false
  const bootWatchdog =
    bootTimeoutMs === null
      ? undefined
      : setTimeout(() => {
          bootTimedOut = true
          proc.error(
            'boot did not complete in time (host memory pressure?) — exiting for systemd to retry',
            { role: spec.name, bootTimeoutMs },
          )
          proc.exit(1)
        }, bootTimeoutMs)

  let handle: H
  try {
    handle = await spec.start()
  } catch (err) {
    // A failed boot must exit non-zero so systemd (Restart=always) retries —
    // previously the rejection was swallowed by the crash net and the process
    // lingered half-booted. Clear the timer so it can't later log a misleading
    // "did not complete" on top of the real failure.
    if (bootWatchdog !== undefined) clearTimeout(bootWatchdog)
    if (!bootTimedOut) {
      // exit(1) in finally: a hostile rejection value (throwing .stack/.message
      // getter) or a throwing proc.error must not skip the exit with the
      // recovery timer already cleared.
      try {
        // `err` goes through as a field: the logger's serializer owns flattening
        // it, and a hostile .stack/.message getter throwing there is caught by
        // the same guard that already protected the interpolated version.
        proc.error('boot failed', { role: spec.name, err })
      } finally {
        proc.exit(1)
      }
    }
    return
  }
  if (bootWatchdog !== undefined) clearTimeout(bootWatchdog)
  if (bootTimedOut) return
  if (spec.readyMessage) {
    proc.log(spec.readyMessage(handle), {
      role: spec.name,
      // Where this process's own records are going. Under systemd or detached
      // this is the only line that says so, and it is the first question anyone
      // debugging a quiet service asks.
      ...(logging ? { logs: logging.destination } : {}),
    })
  }

  const stopWatchdog = spec.watchdog !== false ? proc.startWatchdog() : undefined

  const closeTimeoutMs = spec.closeTimeoutMs ?? 4000
  let shuttingDown = false
  // Assigned below, after `shutdown` exists — the watch's first check runs
  // synchronously, so a shell that died during our boot may call shutdown before
  // this binding is set. That is safe: the watch clears its own timer when it
  // fires, so the `?.()` in shutdown has nothing left to do.
  let stopSupervisorWatch: (() => void) | undefined
  const shutdown = async (): Promise<void> => {
    if (shuttingDown) return
    shuttingDown = true
    // exit(0) lives in `finally`: a throwing stopWatchdog() or a
    // throwing/rejecting close() would otherwise get swallowed by
    // `void shutdown()` + the crash net and leave the process alive after
    // SIGTERM (with `shuttingDown` already latched, so even a second signal
    // couldn't recover it).
    let closeTimer: ReturnType<typeof setTimeout> | undefined
    try {
      stopWatchdog?.()
      stopSupervisorWatch?.()
      await Promise.race([
        (async () => handle.close())(),
        new Promise((r) => {
          closeTimer = setTimeout(r, closeTimeoutMs)
        }),
      ])
    } catch (err) {
      proc.error('close() failed during shutdown', { role: spec.name, err })
    } finally {
      if (closeTimer !== undefined) clearTimeout(closeTimer)
      // Drain LAST, after the close-failure record above has been emitted, and
      // inside the finally so a failed close still gets its logs to disk. Both
      // steps are best-effort: a sink that cannot be drained must not be the
      // reason a SIGTERM'd process fails to exit.
      try {
        await logging?.flush()
      } catch {
        // Nothing left to report it to — the sink is what broke.
      }
      try {
        logging?.close()
      } catch {
        // As above.
      }
      proc.exit(0)
    }
  }
  proc.onSignal('SIGINT', () => void shutdown())
  proc.onSignal('SIGTERM', () => void shutdown())
  // A dead supervising shell means the same thing a SIGTERM does, and takes the
  // same route out — the point is that the orphan leaves, not that it dies harder.
  stopSupervisorWatch = proc.watchSupervisor(() => void shutdown())

  // Stay alive until a signal arrives.
  await proc.stayAlive()
}
