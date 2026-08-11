/**
 * The five levels, and the only two comparisons anything in this package makes
 * of them.
 *
 * Severity is an ATTENTION axis, not a category (spec: Non-goals) — there is no
 * `perf` level, and there never will be one. Performance rides as a `durationMs`
 * field on a normal record, at `warn` when it overran a budget.
 */
export type LogLevel = 'error' | 'warn' | 'info' | 'debug' | 'trace'

/** Most severe first. Index IS the severity rank, which is why order matters. */
export const LEVELS: readonly LogLevel[] = ['error', 'warn', 'info', 'debug', 'trace'] as const

const RANK: Readonly<Record<LogLevel, number>> = {
  error: 0,
  warn: 1,
  info: 2,
  debug: 3,
  trace: 4,
}

/** Severity rank: 0 is `error`, 4 is `trace`. Lower is more severe. */
export function levelRank(level: LogLevel): number {
  return RANK[level]
}

export function isLevel(value: unknown): value is LogLevel {
  return typeof value === 'string' && value in RANK
}

/**
 * A level name from an env var or a settings field, or null if it is not one.
 * Tolerant of case and surrounding space because these arrive from humans.
 */
export function parseLevel(value: string | undefined | null): LogLevel | null {
  if (typeof value !== 'string') return null
  const normalized = value.trim().toLowerCase()
  return isLevel(normalized) ? normalized : null
}

/** Does a record at `level` clear a sink whose threshold is `threshold`? */
export function meetsThreshold(level: LogLevel, threshold: LogLevel): boolean {
  return RANK[level] <= RANK[threshold]
}

/**
 * The more verbose of two thresholds — the operation the emission gate is built
 * from. A logger must produce whatever its LOOSEST sink would accept, which is
 * how a ring buffer pinned at `trace` keeps flight-recorder detail that the
 * console sink at `warn` never prints.
 */
export function moreVerbose(a: LogLevel, b: LogLevel): LogLevel {
  return RANK[a] >= RANK[b] ? a : b
}
