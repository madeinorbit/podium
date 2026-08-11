import { levelConfigVersion } from './level-control'
import { type LogLevel, meetsThreshold, moreVerbose } from './levels'
import type { LogRecord } from './record'

/**
 * A sink receives every record the emission gate lets through and applies its
 * OWN threshold. That independence is the whole design: the console sink at
 * `warn` and the ring buffer at `trace` see the same stream and disagree about
 * what is worth keeping, which is what makes `debug` context available for the
 * minute that mattered without printing it.
 */
export interface Sink {
  /** Names the sink in the one local warning a failure is allowed to produce. */
  name: string
  /**
   * This sink's threshold. ABSENT means "follow the namespace's configured
   * level" — the right default for a console sink, which is what
   * `PODIUM_LOG_LEVEL` is expected to move.
   */
  minLevel?: LogLevel
  write(record: LogRecord): void
}

const sinks: Sink[] = []
let registryVersion = 0

/** Register a sink. Returns a disposer. */
export function addSink(sink: Sink): () => void {
  sinks.push(sink)
  registryVersion += 1
  return () => removeSink(sink)
}

export function removeSink(sink: Sink): void {
  const index = sinks.indexOf(sink)
  if (index !== -1) sinks.splice(index, 1)
  registryVersion += 1
}

export function clearSinks(): void {
  sinks.length = 0
  registryVersion += 1
}

export function getSinks(): readonly Sink[] {
  return sinks
}

/**
 * One number that moves whenever anything a cached emission gate was derived
 * from moves — the level configuration OR the sink registry. A gate cached
 * against the level version alone survived `addSink`, and a ring buffer
 * registered after the first log call would have been starved by a gate
 * computed when it did not exist.
 */
export function loggingEpoch(): number {
  return levelConfigVersion() + registryVersion
}

const gateCache = new Map<LogLevel, LogLevel>()
let gateCacheVersion = -1

/**
 * The loosest threshold any sink would accept for a namespace at `nsLevel` —
 * the level a logger must build records down to. A logger that gated on
 * `nsLevel` alone would starve a ring buffer pinned at `trace`, and the flight
 * recorder would hold exactly the records nobody needed.
 */
export function emissionGate(nsLevel: LogLevel): LogLevel {
  const version = loggingEpoch()
  if (version !== gateCacheVersion) {
    gateCache.clear()
    gateCacheVersion = version
  }
  const cached = gateCache.get(nsLevel)
  if (cached) return cached
  let gate: LogLevel = nsLevel
  for (const sink of sinks) {
    gate = moreVerbose(gate, sink.minLevel ?? nsLevel)
  }
  gateCache.set(nsLevel, gate)
  return gate
}

/**
 * Fan one record out. FAIL-OPEN, per spec: a throwing sink is unregistered
 * after a single local warning and never again touched, and the throw never
 * reaches the `log.warn()` call site that produced the record. Logging must not
 * be able to break the app it is describing.
 */
export function dispatch(record: LogRecord, nsLevel: LogLevel): void {
  // Snapshot: a failing sink unregisters itself mid-iteration.
  for (const sink of [...sinks]) {
    if (!meetsThreshold(record.level, sink.minLevel ?? nsLevel)) continue
    try {
      sink.write(record)
    } catch (err) {
      removeSink(sink)
      warnOnce(sink, err)
    }
  }
}

function warnOnce(sink: Sink, err: unknown): void {
  // console directly, not the logger: a sink failure reported THROUGH the
  // logger is a log-about-logging loop, and this is the one place in the
  // package that is allowed to talk to the console unconditionally.
  try {
    console.warn(
      `[podium:logger] sink '${sink.name}' threw and has been disabled: ${
        err instanceof Error ? err.message : String(err)
      }`,
    )
  } catch {
    // Even the warning is best-effort. There is nowhere left to report to.
  }
}
