/**
 * THE PRUNE-LAG GAUGE (POD-7035, audit guard 4).
 *
 * Every retention job reports, after it runs, how many rows are still past its
 * cutoff. A job keeping up reports zero, or a number that falls. A job that
 * cannot keep up, or that deletes nothing at all (a missing index, a fence that
 * never clears, a batch too small for the inflow), reports a number that does
 * not fall. That is the signal the audit wanted: the 47k ended scans of
 * POD-7031 sat behind a 100-row-a-minute purge for hours with nothing in the
 * logs to say so.
 *
 * Each report is a debug line and the latest number per job ({@link snapshot}),
 * which the janitor's counters expose. The gauge warns when the backlog was
 * above zero and did not shrink across
 * {@link STALL_RUNS} consecutive runs, then repeats the warning at most once per
 * {@link REPEAT_WARN_MS} while the stall lasts, and says once when it drains
 * again. A backlog that shrinks, however slowly, is draining: the gauge stays
 * quiet about it and only reports the number.
 */

/** Runs in a row whose backlog did not shrink before the gauge warns. */
export const STALL_RUNS = 3

/** The shortest gap between two warnings about one job's stalled backlog. */
export const REPEAT_WARN_MS = 60 * 60 * 1000

export interface RetentionBacklogLog {
  debug(message: string, fields?: Record<string, unknown>): void
  info(message: string, fields?: Record<string, unknown>): void
  warn(message: string, fields?: Record<string, unknown>): void
}

interface JobState {
  /** The backlog after each of the most recent runs, oldest first. */
  readonly recent: number[]
  stalledSince: number | undefined
  lastWarnAt: number | undefined
}

export class RetentionBacklog {
  private readonly jobs = new Map<string, JobState>()

  constructor(
    private readonly log: RetentionBacklogLog,
    private readonly now: () => number = Date.now,
  ) {}

  /** The last backlog each job reported, for health and metrics surfaces. */
  snapshot(): Record<string, number> {
    const out: Record<string, number> = {}
    for (const [job, state] of this.jobs) {
      const last = state.recent.at(-1)
      if (last !== undefined) out[job] = last
    }
    return out
  }

  /** Whether `job` is stalled now: its last {@link STALL_RUNS} backlogs never fell. */
  stalled(job: string): boolean {
    return this.jobs.get(job)?.stalledSince !== undefined
  }

  /**
   * Record the rows past `job`'s cutoff left after one run of it. `detail`
   * rides on the log lines (the cutoff, the rows the run deleted).
   */
  report(job: string, pastCutoff: number, detail: Record<string, unknown> = {}): void {
    const state = this.jobs.get(job) ?? {
      recent: [],
      stalledSince: undefined,
      lastWarnAt: undefined,
    }
    this.jobs.set(job, state)
    state.recent.push(pastCutoff)
    if (state.recent.length > STALL_RUNS) state.recent.shift()
    const fields = { job, pastCutoff, ...detail }
    if (pastCutoff === 0) {
      if (state.stalledSince !== undefined) {
        this.log.info('retention backlog drained', fields)
      } else {
        this.log.debug('retention backlog', fields)
      }
      state.stalledSince = undefined
      state.lastWarnAt = undefined
      return
    }
    this.log.debug('retention backlog', fields)
    const at = this.now()
    if (!isStalled(state.recent)) {
      if (state.stalledSince !== undefined)
        this.log.info('retention backlog draining again', fields)
      state.stalledSince = undefined
      state.lastWarnAt = undefined
      return
    }
    state.stalledSince ??= at
    if (state.lastWarnAt !== undefined && at - state.lastWarnAt < REPEAT_WARN_MS) return
    state.lastWarnAt = at
    this.log.warn('retention backlog is not shrinking', {
      ...fields,
      runs: STALL_RUNS,
      recent: [...state.recent],
      stalledForMs: at - state.stalledSince,
    })
  }
}

/** A full window of runs, all above zero, none smaller than the run before it. */
function isStalled(recent: readonly number[]): boolean {
  if (recent.length < STALL_RUNS) return false
  for (let i = 0; i < recent.length; i += 1) {
    if (recent[i]! <= 0) return false
    if (i > 0 && recent[i]! < recent[i - 1]!) return false
  }
  return true
}
