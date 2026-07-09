/**
 * One boot kernel for the long-running Podium processes (server / daemon / host).
 * Each entrypoint in scripts/ is a thin composition over `bootProcess`; the shared
 * boot/shutdown semantics live here so the three processes can't silently diverge
 * (the combined dev host went without a crash net for a while purely through
 * divergence). What the kernel guarantees, in order:
 *
 *  - Crash net FIRST (installProcessSafetyNet, audit P0-1): an un-caught rejection
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
 *  - Bounded close on SIGINT/SIGTERM: Bun's node:http `close()` can wait on
 *    lingering keep-alive sockets that Node drains promptly, which would stall
 *    SIGTERM until systemd SIGKILLs. Racing `close()` against `closeTimeoutMs`
 *    keeps shutdown prompt; on Node the close resolves first, so it's a no-op.
 *  - Stays alive (`await new Promise(() => {})`) until a signal arrives.
 */
import { installProcessSafetyNet } from './process-safety'
import { startWatchdog } from './sd-notify'

export interface BootHandle {
  close: () => Promise<void> | void
}

export interface BootSpec<H extends BootHandle = BootHandle> {
  /** 'server' | 'daemon' | 'host' — used in log prefixes. */
  name: string
  /** Default true: installProcessSafetyNet(name) FIRST, before anything else. */
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
  installSafetyNet: (name: string) => void
  startWatchdog: () => (() => void) | undefined
  log: (msg: string) => void
  error: (msg: string) => void
  /** Never resolves in production — the entrypoint stays alive until a signal. */
  stayAlive: () => Promise<void>
}

const realProc: BootProc = {
  exit: (code) => process.exit(code),
  onSignal: (signal, handler) => {
    process.on(signal, handler)
  },
  installSafetyNet: installProcessSafetyNet,
  startWatchdog,
  log: (msg) => console.log(msg),
  error: (msg) => console.error(msg),
  stayAlive: () => new Promise<void>(() => {}),
}

export async function bootProcess<H extends BootHandle>(
  spec: BootSpec<H>,
  proc: BootProc = realProc,
): Promise<void> {
  // Crash net BEFORE anything else — even the boot watchdog setup.
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
            `[podium:${spec.name}] boot did not complete within ${bootTimeoutMs}ms (host memory pressure?) — exiting for systemd to retry`,
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
        let detail: string
        try {
          detail = err instanceof Error ? (err.stack ?? err.message) : String(err)
        } catch {
          detail = '<unprintable error>'
        }
        proc.error(`[podium:${spec.name}] boot failed: ${detail}`)
      } finally {
        proc.exit(1)
      }
    }
    return
  }
  if (bootWatchdog !== undefined) clearTimeout(bootWatchdog)
  if (bootTimedOut) return
  if (spec.readyMessage) proc.log(spec.readyMessage(handle))

  const stopWatchdog = spec.watchdog !== false ? proc.startWatchdog() : undefined

  const closeTimeoutMs = spec.closeTimeoutMs ?? 4000
  let shuttingDown = false
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
      await Promise.race([
        (async () => handle.close())(),
        new Promise((r) => {
          closeTimer = setTimeout(r, closeTimeoutMs)
        }),
      ])
    } catch (err) {
      proc.error(`[podium:${spec.name}] close() failed during shutdown: ${String(err)}`)
    } finally {
      if (closeTimer !== undefined) clearTimeout(closeTimer)
      proc.exit(0)
    }
  }
  proc.onSignal('SIGINT', () => void shutdown())
  proc.onSignal('SIGTERM', () => void shutdown())

  // Stay alive until a signal arrives.
  await proc.stayAlive()
}
