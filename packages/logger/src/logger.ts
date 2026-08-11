import { resetLevels, resolveLevel } from './level-control'
import { type LogLevel, meetsThreshold } from './levels'
import type { Fields, ProcessContext } from './record'
import { buildRecord } from './record'
import { clearSinks, dispatch, emissionGate, loggingEpoch } from './sinks'

/**
 * A namespaced logger. `ns` formalizes the `[podium:x]` prefix convention the
 * codebase already had, except that now something can filter on it.
 */
export interface Logger {
  readonly ns: string
  error(msg: string, fields?: Fields): void
  warn(msg: string, fields?: Fields): void
  info(msg: string, fields?: Fields): void
  debug(msg: string, fields?: Fields): void
  trace(msg: string, fields?: Fields): void
  /** Bind context onto every record this logger's descendants emit. */
  child(fields: Fields): Logger
  /**
   * Would a record at this level reach ANY sink? Guard genuinely expensive
   * field construction with it — not ordinary logging, which is already gated.
   *
   * CAREFUL in a hot path: a ring buffer pinned at `trace` makes this `true`
   * for every level, forever, because the flight recorder genuinely does want
   * every level. Guarding a per-frame call on this does not make it free —
   * that is what {@link isLevelRequested} is for.
   */
  isLevelEnabled(level: LogLevel): boolean
  /**
   * Did CONFIGURATION ask for this level in this namespace — `PODIUM_LOG`,
   * `PODIUM_LOG_LEVEL`, or the programmatic setter — ignoring sinks that pin
   * their own threshold?
   *
   * The predicate for a genuinely hot path (per PTY frame, per row of a feed
   * rebuild), where a record costs about a microsecond and the volume makes
   * that matter. It answers "did an operator turn this namespace up?", so the
   * default is `false` and the cost is only paid when someone is looking.
   *
   * The trade is deliberate and belongs to the CALL SITE: guarding on this
   * keeps the records out of the flight recorder too, so a crash on that path
   * arrives without per-frame context. Use it where the volume is real; prefer
   * an unguarded `trace` everywhere else, so the buffer stays worth shipping.
   */
  isLevelRequested(level: LogLevel): boolean
}

let processContext: ProcessContext = {}

/**
 * Attach the process-bound context once at boot: app version, role, platform,
 * instance. Merges, so a boot sequence can fill it in as facts become known.
 */
export function setProcessContext(context: ProcessContext): void {
  processContext = { ...processContext, ...context }
}

export function getProcessContext(): Readonly<ProcessContext> {
  return processContext
}

/** Drop every sink, all level configuration, and the process context. */
export function resetLogging(): void {
  clearSinks()
  resetLevels()
  processContext = {}
}

export function createLogger(ns: string): Logger {
  return makeLogger(ns, {})
}

function makeLogger(ns: string, bound: Fields): Logger {
  // The gate is derived from the namespace level and every sink's threshold,
  // both of which move at runtime. Caching it against the config version keeps
  // a `trace` call in a hot loop from re-deriving the answer every time,
  // without the staleness a plain cache would have.
  let cached: { gate: LogLevel; nsLevel: LogLevel } | null = null
  let cachedEpoch = -1

  function resolved(): { gate: LogLevel; nsLevel: LogLevel } {
    const epoch = loggingEpoch()
    if (cached === null || epoch !== cachedEpoch) {
      const nsLevel = resolveLevel(ns)
      cached = { nsLevel, gate: emissionGate(nsLevel) }
      cachedEpoch = epoch
    }
    return cached
  }

  function emit(level: LogLevel, msg: string, fields?: Fields): void {
    const { gate, nsLevel } = resolved()
    if (!meetsThreshold(level, gate)) return
    const record = buildRecord({
      level,
      ns,
      msg,
      fields: fields ? { ...bound, ...fields } : bound,
      context: processContext,
    })
    dispatch(record, nsLevel)
  }

  return {
    ns,
    error: (msg, fields) => emit('error', msg, fields),
    warn: (msg, fields) => emit('warn', msg, fields),
    info: (msg, fields) => emit('info', msg, fields),
    debug: (msg, fields) => emit('debug', msg, fields),
    trace: (msg, fields) => emit('trace', msg, fields),
    child: (fields) => makeLogger(ns, { ...bound, ...fields }),
    isLevelEnabled: (level) => meetsThreshold(level, resolved().gate),
    isLevelRequested: (level) => meetsThreshold(level, resolved().nsLevel),
  }
}
