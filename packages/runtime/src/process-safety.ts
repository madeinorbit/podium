/**
 * Process-level crash net (audit P0-1). Neither split entrypoint installed
 * `unhandledRejection`/`uncaughtException` handlers, so ANY escaped throw or
 * un-`.catch`'d rejection — a dead socket's send, a file-RPC reject, a throw from a
 * PTY data callback — terminated the whole process, taking down every session on
 * that machine. The goal of the audit is that one misbehaving agent cannot take down
 * all of Podium, so the default here is LOG AND SURVIVE: the fault is almost always
 * one bad frame/session, not global corruption. A genuinely wedged process is the
 * job of the systemd watchdog (Type=notify + WatchdogSec, see sd-notify.ts), not of
 * tearing everyone down on the first stray throw.
 */

export interface SafetyHandlers {
  onUnhandledRejection(reason: unknown): void
  onUncaughtException(err: unknown): void
}

/** Pure handler pair, injected logger — kept out of `process.on` so it's unit-testable. */
export function makeSafetyHandlers(
  label: string,
  log: (msg: string, err: unknown) => void,
): SafetyHandlers {
  const safelyLog = (msg: string, err: unknown): void => {
    try {
      log(msg, err)
    } catch {
      // A broken log sink must never become the fatal error we were trying to swallow.
    }
  }
  return {
    onUnhandledRejection: (reason) =>
      safelyLog(`[podium:${label}] unhandledRejection (surviving)`, reason),
    onUncaughtException: (err) => safelyLog(`[podium:${label}] uncaughtException (surviving)`, err),
  }
}

/** Wire the crash net onto the live process. Call once at entrypoint startup. */
export function installProcessSafetyNet(label: string): void {
  const { onUnhandledRejection, onUncaughtException } = makeSafetyHandlers(label, (msg, err) =>
    console.error(msg, err),
  )
  process.on('unhandledRejection', onUnhandledRejection)
  process.on('uncaughtException', onUncaughtException)
}
