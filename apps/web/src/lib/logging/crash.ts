import type { ForwardedLogRecord } from '@podium/commands'
import { type Logger, type SerializedError, serializeError } from '@podium/logger'
import { toForwarded } from './forward-sink'

/**
 * THE CRASH PATH — the client half of `logs.crash`
 * [spec: docs/superpowers/specs/2026-08-11-logging-strategy-design.md,
 * "Crash capture (end-to-end)"].
 *
 * A crash always ships: the error, plus the WHOLE flight recorder, plus
 * whatever the producer knows that the error itself does not (a React component
 * stack, the route). The buffer is the reason this is worth doing — an error
 * message says what broke, and the fifty records before it say what the app was
 * doing when it broke.
 *
 * Three properties this file exists to hold:
 *
 * - **The error is LOGGED first, then the buffer is snapshotted.** So the crash
 *   itself is the last record of the payload it ships, and the payload reads as
 *   a narrative that ends where it should.
 * - **A crash loop is bounded.** React re-throwing into an update loop can fire
 *   this a thousand times a second; a client that answered every one would DDoS
 *   its own server with the reports rather than the crashes. Same error twice is
 *   one report (a boundary and `window.onerror` genuinely both see it), and a
 *   session ships at most `maxCrashes` in total.
 * - **Failure here is silent, locally.** Reporting a failed crash-ship through
 *   the logger would put a record into the buffer that the next crash ships,
 *   and hand the forwarding sink something to fail on in turn.
 */

export interface CrashPayload {
  err: SerializedError
  snapshot: ForwardedLogRecord[]
  context?: Record<string, unknown>
}

export interface CrashReporterOptions {
  /** The logger the crash is recorded through — never bypassed, so every sink
   *  (console, ring buffer, forwarding) sees the crash like any other record. */
  log: Logger
  /** The flight recorder, read AFTER the crash has been logged. */
  snapshot: () => Array<{ ts: string; level: string; ns: string; msg: string }>
  send(payload: CrashPayload): Promise<void> | void
  /** Reports shipped per page session before the reporter goes quiet. */
  maxCrashes?: number
  /** Where a failed ship is noted. Never the logger. */
  onDegraded?: (message: string) => void
}

export interface CrashReporter {
  /** Log and ship one crash. Never throws. */
  report(error: unknown, context?: Record<string, unknown>): void
  /** Wire `error` + `unhandledrejection`. Returns a disposer. */
  installGlobalHandlers(target: Window): () => void
}

const DEFAULT_MAX_CRASHES = 10

export function createCrashReporter(options: CrashReporterOptions): CrashReporter {
  const maxCrashes = options.maxCrashes ?? DEFAULT_MAX_CRASHES
  const onDegraded = options.onDegraded ?? defaultDegradedNotice
  let shipped = 0
  const seen = new WeakSet<object>()
  /** Set while a report is in progress, so a throw on the crash path — which
   *  `window.onerror` would see as another crash — cannot recurse. */
  let reporting = false

  function report(error: unknown, context?: Record<string, unknown>): void {
    if (reporting) return
    // Identity, not signature: the case worth deduplicating is the SAME error
    // object arriving twice (a boundary caught it and the runtime re-raised
    // it). Two distinct failures that happen to share a message are two
    // crashes, and collapsing them would hide the second one.
    if (typeof error === 'object' && error !== null) {
      if (seen.has(error)) return
      seen.add(error)
    }
    if (shipped >= maxCrashes) return
    shipped += 1
    reporting = true
    try {
      const message = error instanceof Error ? error.message : String(error)
      // Through the logger, so the console shows it and the buffer ends on it.
      options.log.error(message, { err: error, ...(context ?? {}) })
      const payload: CrashPayload = {
        err: serializeError(error),
        snapshot: options.snapshot().map((record) =>
          // Same clamping the forwarding sink applies: the crash endpoint
          // validates each snapshot record against the same schema, and one
          // oversized record would cost the entire crash report.
          toForwarded(record as Parameters<typeof toForwarded>[0]),
        ),
        ...(context ? { context } : {}),
      }
      void settle(options.send(payload))
    } catch (err) {
      note(err)
    } finally {
      reporting = false
    }
  }

  async function settle(sending: Promise<void> | void): Promise<void> {
    try {
      await sending
    } catch (err) {
      note(err)
    }
  }

  function note(err: unknown): void {
    try {
      onDegraded(
        `[podium] crash report could not be delivered: ${
          err instanceof Error ? err.message : String(err)
        }`,
      )
    } catch {
      // Nowhere left to report to.
    }
  }

  return {
    report,
    installGlobalHandlers(target: Window): () => void {
      const onError = (event: Event): void => {
        const errorEvent = event as ErrorEvent
        // `error` is absent for a cross-origin script error ("Script error."),
        // where the browser withholds the detail. Reporting the message alone
        // is still worth more than dropping it.
        report(errorEvent.error ?? new Error(errorEvent.message || 'uncaught error'), {
          source: 'window.onerror',
          ...(errorEvent.filename ? { filename: errorEvent.filename } : {}),
          ...(typeof errorEvent.lineno === 'number' ? { lineno: errorEvent.lineno } : {}),
        })
      }
      const onRejection = (event: Event): void => {
        const reason: unknown = (event as { reason?: unknown }).reason
        report(reason ?? new Error('unhandled rejection with no reason'), {
          source: 'unhandledrejection',
        })
      }
      target.addEventListener('error', onError)
      target.addEventListener('unhandledrejection', onRejection)
      return () => {
        target.removeEventListener('error', onError)
        target.removeEventListener('unhandledrejection', onRejection)
      }
    },
  }
}

function defaultDegradedNotice(message: string): void {
  try {
    console.warn(message)
  } catch {
    // Nowhere left to report to.
  }
}
