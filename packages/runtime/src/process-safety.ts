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
 *
 * The net reports through `@podium/logger`, so a survived crash is a structured
 * record with a serialized `err` in the same rotated file as everything else,
 * rather than a `console.error` whose stack was only ever readable by eye.
 */
import { createLogger } from '@podium/logger'

export interface SafetyHandlers {
  onUnhandledRejection(reason: unknown): void
  onUncaughtException(err: unknown): void
}

/** The one logger method the net uses. Narrow, so a test can pass a spy. */
export interface SafetyLog {
  error(msg: string, fields?: Record<string, unknown>): void
}

/**
 * Pure handler pair, injected logger — kept out of `process.on` so it's unit-testable.
 *
 * The label lives in the logger's NAMESPACE rather than in the message: the
 * caller builds `createLogger('<label>:safety-net')`, so every record is already
 * attributed and a query can group by it.
 */
export function makeSafetyHandlers(log: SafetyLog): SafetyHandlers {
  const safelyLog = (msg: string, err: unknown): void => {
    try {
      log.error(msg, { err })
    } catch {
      // A broken log sink must never become the fatal error we were trying to swallow.
    }
  }
  return {
    onUnhandledRejection: (reason) => safelyLog('unhandledRejection (surviving)', reason),
    onUncaughtException: (err) => safelyLog('uncaughtException (surviving)', err),
  }
}

/** Wire the crash net onto the live process. Call once at entrypoint startup. */
export function installProcessSafetyNet(label: string): void {
  const { onUnhandledRejection, onUncaughtException } = makeSafetyHandlers(
    createLogger(`${label}:safety-net`),
  )
  process.on('unhandledRejection', onUnhandledRejection)
  process.on('uncaughtException', onUncaughtException)
}
