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
  /**
   * Accept one record. SYNCHRONOUS AND NEVER REJECTING — a sink OWNS its async
   * errors.
   *
   * A sink with real I/O behind it (file, network) buffers here and does the
   * write elsewhere; if that write fails, the sink handles it, because there is
   * no caller left to hand it to. `log.warn()` returned long ago and its call
   * site cannot be told that logging failed later.
   *
   * The contract is enforced, not merely documented: {@link dispatch} watches
   * for a thenable return and treats a rejection exactly like a synchronous
   * throw — one warning, then the sink is unregistered. Without that, an async
   * rejection escapes the fail-open try/catch entirely and surfaces as an
   * unhandledRejection, which is the one outcome this package exists to prevent.
   *
   * A sink must also not MUTATE the record it is given. Records are shared by
   * reference across every sink and with {@link RingBufferSink.snapshot}, so a
   * mutation here rewrites another sink's history.
   */
  write(record: LogRecord): void
  /**
   * Settle whatever is buffered, resolving when it is durable.
   *
   * Optional because a sink with no buffer has nothing to settle. Needed by
   * shutdown drain and by crash shipping: a process that exits between the
   * buffered write and the flush loses exactly the records explaining why.
   */
  flush?(): Promise<void>
  /**
   * Release the sink's resources. Implies a final flush — a caller that closes
   * should not have to flush first to avoid losing the tail.
   */
  close?(): Promise<void>
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

const gateCache = new Map<LogLevel, LogLevel | null>()
let gateCacheVersion = -1

/**
 * The loosest threshold any REGISTERED sink would accept for a namespace at
 * `nsLevel`, or `null` when no sink would accept anything — the level a logger
 * must build records down to, and `null` meaning "build nothing at all".
 *
 * Folded over the sinks ONLY. Seeding the fold with `nsLevel` instead left the
 * gate open with zero sinks registered, and open at `nsLevel` when every sink
 * was pinned STRICTER than it — so a record was constructed, and
 * `isLevelEnabled` answered `true`, for a fan-out that would then drop it. The
 * spec addendum is the authority here: a record is constructed when any
 * registered sink would accept it, which with no sinks is never.
 *
 * A logger that gated on `nsLevel` alone would make the opposite mistake and
 * starve a ring buffer pinned at `trace`, so the fold takes each sink's own
 * threshold, falling back to `nsLevel` only for the sinks that follow it.
 */
export function emissionGate(nsLevel: LogLevel): LogLevel | null {
  const version = loggingEpoch()
  if (version !== gateCacheVersion) {
    gateCache.clear()
    gateCacheVersion = version
  }
  // `has`, not a truthy check: `null` is a real cached answer — the closed gate
  // — and a truthy check would recompute it on every call in the common
  // no-sinks-registered case.
  if (gateCache.has(nsLevel)) return gateCache.get(nsLevel) ?? null
  let gate: LogLevel | null = null
  for (const sink of sinks) {
    const threshold = sink.minLevel ?? nsLevel
    gate = gate === null ? threshold : moreVerbose(gate, threshold)
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
      // `write` is typed `void`, but TypeScript accepts an async function
      // wherever a void-returning one is expected, so a sink CAN hand back a
      // promise. A try/catch cannot see that promise reject, so check for one.
      const returned: unknown = sink.write(record)
      if (isThenable(returned)) {
        returned.then(undefined, (err: unknown) => {
          // Same fail-open outcome as a synchronous throw, just later. Without
          // this the rejection becomes an unhandledRejection and the sink keeps
          // its registration, failing silently on every record from here on.
          removeSink(sink)
          warnOnce(sink, err)
        })
      }
    } catch (err) {
      removeSink(sink)
      warnOnce(sink, err)
    }
  }
}

function isThenable(value: unknown): value is PromiseLike<unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { then?: unknown }).then === 'function'
  )
}

/**
 * Settle every sink that buffers. Resolves when they all have, and NEVER
 * rejects — a failed flush is reported the same way a failed write is, because
 * a shutdown path that throws on its way out is worse than a lost record.
 *
 * Unlike a failed write, a failed flush does NOT unregister the sink: flush is
 * called at shutdown and at crash-ship time, and disabling a sink there would
 * discard the records the very next line is trying to save.
 */
export async function flushSinks(): Promise<void> {
  const pending = [...sinks].map(async (sink) => {
    try {
      await sink.flush?.()
    } catch (err) {
      warnOnce(sink, err, 'failed to flush')
    }
  })
  await Promise.all(pending)
}

/**
 * Flush and release every sink, then empty the registry. After this the logger
 * is inert until something registers again, which is what a process wants on
 * its way out — a sink whose file handle is closed must not still be receiving.
 */
export async function closeSinks(): Promise<void> {
  const closing = [...sinks].map(async (sink) => {
    try {
      await sink.close?.()
    } catch (err) {
      warnOnce(sink, err, 'failed to close')
    }
  })
  await Promise.all(closing)
  clearSinks()
}

function warnOnce(sink: Sink, err: unknown, what = 'threw and has been disabled'): void {
  // console directly, not the logger: a sink failure reported THROUGH the
  // logger is a log-about-logging loop, and this is the one place in the
  // package that is allowed to talk to the console unconditionally.
  try {
    console.warn(
      `[podium:logger] sink '${sink.name}' ${what}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    )
  } catch {
    // Even the warning is best-effort. There is nowhere left to report to.
  }
}
