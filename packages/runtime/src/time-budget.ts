/**
 * Cooperative time slicing for synchronous, already-bounded job units
 * [spec:SP-c29e]. The helper owns scheduling and measurement only: callers
 * choose the unit boundary and own any serialization between jobs.
 */

export const DEFAULT_TIME_SLICE_BUDGET_MS = 12
export const DEFAULT_JOB_PLACEMENT_THRESHOLD_MS = 50

export type TimeBudgetedJobOutcome = 'completed' | 'cancelled' | 'failed'
export type TimeBudgetedJobUnitResult = 'continue' | 'done'

export interface TimeBudgetedJobMetrics {
  outcome: TimeBudgetedJobOutcome
  units: number
  yields: number
  /** Wall-clock duration, including time spent yielded to other macrotasks. */
  totalDurationMs: number
  /** Longest measured span between macrotask yields. */
  maxUninterruptedSliceMs: number
  /** Placement signal: this job should move to a worker/janitor when practical. */
  exceededPlacementThreshold: boolean
}

export interface TimeBudgetedJobOptions {
  /** Target uninterrupted slice. Defaults to 12ms (the specified 8–16ms band). */
  sliceBudgetMs?: number
  /** Total-duration threshold for worker/janitor placement. Defaults to 50ms. */
  placementThresholdMs?: number
  /** Checked before every bounded unit and after every macrotask yield. */
  signal?: AbortSignal
  /** Monotonic clock seam. Defaults to performance.now(). */
  now?: () => number
  /** Called once for every outcome, including a thrown unit. Callback errors are ignored. */
  onMetrics?: (metrics: TimeBudgetedJobMetrics) => void
}

function macrotask(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0))
}

function positiveFinite(name: string, value: number): number {
  if (!Number.isFinite(value) || value <= 0) {
    throw new RangeError(`${name} must be a positive finite number`)
  }
  return value
}

/**
 * Run synchronous bounded units until done, cancellation, or failure.
 *
 * Once the current slice consumes its budget, the helper yields via a timer
 * macrotask BEFORE invoking the next potentially expensive unit. A unit may
 * overshoot the target, so callers must keep each individual unit bounded.
 */
export async function runTimeBudgetedJob(
  runUnit: () => TimeBudgetedJobUnitResult,
  options: TimeBudgetedJobOptions = {},
): Promise<TimeBudgetedJobMetrics> {
  const sliceBudgetMs = positiveFinite(
    'sliceBudgetMs',
    options.sliceBudgetMs ?? DEFAULT_TIME_SLICE_BUDGET_MS,
  )
  const placementThresholdMs = positiveFinite(
    'placementThresholdMs',
    options.placementThresholdMs ?? DEFAULT_JOB_PLACEMENT_THRESHOLD_MS,
  )
  const now = options.now ?? (() => globalThis.performance.now())
  const startedAt = now()
  let sliceStartedAt = startedAt
  let maxUninterruptedSliceMs = 0
  let units = 0
  let yields = 0
  let outcome: TimeBudgetedJobOutcome = 'failed'
  let failure: unknown

  try {
    while (!options.signal?.aborted) {
      const beforeUnit = now()
      const sliceDuration = beforeUnit - sliceStartedAt
      if (units > 0 && sliceDuration >= sliceBudgetMs) {
        maxUninterruptedSliceMs = Math.max(maxUninterruptedSliceMs, sliceDuration)
        await macrotask()
        yields++
        sliceStartedAt = now()
        if (options.signal?.aborted) break
      }

      units++
      const result = runUnit()
      if (result === 'done') {
        outcome = 'completed'
        break
      }
      if (result !== 'continue') {
        throw new TypeError(`runUnit returned ${String(result)}; expected "continue" or "done"`)
      }
    }
    if (outcome !== 'completed') outcome = 'cancelled'
  } catch (err) {
    failure = err
    outcome = 'failed'
  }

  const finishedAt = now()
  maxUninterruptedSliceMs = Math.max(
    maxUninterruptedSliceMs,
    Math.max(0, finishedAt - sliceStartedAt),
  )
  const totalDurationMs = Math.max(0, finishedAt - startedAt)
  const metrics: TimeBudgetedJobMetrics = {
    outcome,
    units,
    yields,
    totalDurationMs,
    maxUninterruptedSliceMs,
    exceededPlacementThreshold: totalDurationMs > placementThresholdMs,
  }
  try {
    options.onMetrics?.(metrics)
  } catch {
    // Measurement must never replace the maintenance job's result or error.
  }
  if (failure !== undefined) throw failure
  return metrics
}
