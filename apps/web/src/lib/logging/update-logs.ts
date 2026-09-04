import { createLogger, type LogLevel } from '@podium/logger'

/**
 * THE UPDATE PATH'S LOGGERS, AND WHY THEY ARE THEIR OWN NAMESPACES (POD-3224).
 *
 * Everything a client can be asked about an update — what it thought it was
 * running, what the browser told it about a service worker, what a Reload click
 * actually did, why it navigated — is asked AFTER the fact, by an operator, from
 * `~/.podium/logs/clients/<origin>.ndjson`. That is a different reader from the
 * one every other `web:*` namespace is written for, and it needs a different
 * default: a client boots at `warn`, so before this the whole trace was written
 * at `info` into a console nobody was watching and forwarded nowhere.
 *
 * FOUR NAMESPACES RATHER THAN ONE, because they answer four different questions
 * and an operator narrowing a raise should be able to ask just one of them:
 *
 *  - `web:updates` — the panel's inputs, the actions, the poll. "What did the
 *    app believe, and what did the user press?"
 *  - `web:sw`      — registration and the browser's own service-worker
 *    lifecycle. "What did the browser say?"
 *  - `web:reload`  — the reload handshake and every navigation this app triggers
 *    itself. "What did it DO about it, and did it work?"
 *  - `web:boot`    — the surface, build and platform this page is. Already
 *    exists; floored here because a boot line nobody kept cannot identify the
 *    page every other line is about.
 *
 * All four are FLOORED at `info` by {@link UPDATE_LOG_FLOORS}, which lifts what
 * is forwarded and what is printed together (the forwarding sink pins no
 * threshold of its own). That makes the level a call-site obligation rather than
 * a configuration one:
 *
 *   info   — a transition or an outcome. Bounded by the update itself: a page
 *            that is not updating emits none of them.
 *   debug  — anything on a timer. The 1 s poll, the 60 s check, per-tick panel
 *            inputs. These reach the flight recorder and the console under a
 *            raise, and never the wire.
 *   warn+  — an anomaly: a registration that failed, a handshake that found no
 *            replacement, a navigation that threw.
 *
 * A `web:updates` line at `info` on every poll would put a record a second on
 * the wire for the whole of an update, which is the one way this design fails.
 * `debug` is the answer, not a smaller floor.
 */

/** The panel's inputs, the actions it dispatches, and the poll behind them. */
export const updatesLog = createLogger('web:updates')

/** Registration, and the service-worker lifecycle events the page observes. */
export const swLog = createLogger('web:sw')

/** The reload handshake, and every navigation this app triggers itself. */
export const reloadLog = createLogger('web:reload')

/**
 * The namespaces whose records must reach the coordinator without anybody
 * asking, and the level at which they must.
 *
 * Handed to `installClientLogging({ floors })` at boot. A floor rather than an
 * override, so an operator raising the whole client to `debug` still gets
 * `debug` here — see `setNamespaceFloor`.
 */
export const UPDATE_LOG_FLOORS: Readonly<Record<string, LogLevel>> = {
  'web:updates': 'info',
  'web:sw': 'info',
  'web:reload': 'info',
  'web:version-guard': 'info',
  'web:chunk-recovery': 'info',
  'web:boot': 'info',
}
