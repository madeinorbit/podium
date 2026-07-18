/**
 * Minimal systemd watchdog support (audit P0-3). With `Type=notify` +
 * `WatchdogSec=N` on the unit, systemd expects a periodic `WATCHDOG=1` and restarts
 * the service if one fails to arrive — which is what finally catches a wedged-but-
 * alive process (`Restart=always` only fires on EXIT, so a stalled event loop is
 * invisible to it). The pet rides a `setInterval`: if the event loop wedges (the
 * documented big-paste/sync-block incident), the interval stops firing, no pet is
 * sent, and systemd restarts the process. Best-effort and a no-op when not under a
 * notify unit (dev, tests, non-systemd hosts), so it's safe to call unconditionally.
 *
 * Node's `dgram` can't open the AF_UNIX SOCK_DGRAM that NOTIFY_SOCKET is, so we
 * shell out to `systemd-notify` (requires `NotifyAccess=all` on the unit, since the
 * notifier is a child pid). The call is async — it must never block the loop.
 */
import { execFile } from 'node:child_process'

/** Pet cadence = half the watchdog window (systemd's recommended margin), floored at
 *  1s. `WATCHDOG_USEC` is exported by systemd in microseconds. */
export function watchdogPetIntervalMs(
  watchdogUsec: string | undefined = process.env.WATCHDOG_USEC,
  fallbackMs = 15_000,
): number {
  const usec = Number(watchdogUsec)
  if (!Number.isFinite(usec) || usec <= 0) return fallbackMs
  return Math.max(1_000, Math.floor(usec / 1000 / 2))
}

/** Send one sd_notify status line. No-op when not under a Type=notify unit. */
export function sdNotify(state: string): void {
  if (!process.env.NOTIFY_SOCKET) return
  // Async + swallow: a missing/failed systemd-notify must never crash or block us.
  execFile('systemd-notify', [state], () => {})
}

export interface WatchdogOptions {
  /** When present, pets require a changed token. This lets state machines stop
   * a green event-loop timer from masking liveness-without-progress. */
  readProgress?: () => number
  /** Test seam; production uses {@link watchdogPetIntervalMs}. */
  intervalMs?: number
  /** Test seam; production sends through {@link sdNotify}. */
  notify?: (state: string) => void
}

/**
 * Signal READY and start petting the watchdog. Returns a stop fn (clears the timer);
 * returns undefined when there's no watchdog to pet, so callers can `?.()` on cleanup.
 *
 * A progress reader changes the contract from event-loop liveness to state-machine
 * progress [spec:SP-c29e]. The first scheduled pet consumes progress completed
 * before startup; later pets require the token to advance.
 */
export function startWatchdog(options: WatchdogOptions = {}): (() => void) | undefined {
  if (!process.env.NOTIFY_SOCKET) return undefined
  const notify = options.notify ?? sdNotify
  notify('READY=1')
  // First pet IMMEDIATELY, not at the first interval tick: a stall right after
  // boot (e.g. a daemon-reattach storm on redeploy) then has the full WatchdogSec
  // budget instead of WatchdogSec minus the first pet interval (~half the window).
  notify('WATCHDOG=1')
  let lastPetProgress: number | undefined
  const timer = setInterval(() => {
    if (options.readProgress) {
      const progress = options.readProgress()
      if (progress === lastPetProgress) return
      lastPetProgress = progress
    }
    notify('WATCHDOG=1')
  }, options.intervalMs ?? watchdogPetIntervalMs())
  timer.unref?.()
  return () => clearInterval(timer)
}
