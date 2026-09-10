/**
 * Attribution layer for the daemon event loop, paired with `@podium/runtime`'s
 * `startLoopAccounting`. When the accounting probe detects a long tick it calls
 * {@link reportLongTick}, which dumps WHAT the loop was busy with in the ~1s
 * around the stall: per-window activity counters (PTY frames, control messages,
 * transcript-tail deltas, worker hand-backs) plus a heap/RSS snapshot. A stall
 * with no discrete cause in the mix but a large/growing heap implicates GC —
 * Bun does not emit GC PerformanceObserver entries, so we infer it.
 *
 * Everything here is a no-op below the `attribution` profile level.
 */
import { createLogger } from '@podium/logger'
import type { StallClassification } from '@podium/runtime/loop-metrics'
import { atLeast } from '@podium/runtime/loop-profile'
import {
  attributeTasks,
  formatTopTasks,
  measureTask,
  resetTaskAttribution,
  taskAttributionCoverage,
  taskAttributionTotals,
} from '@podium/runtime/task-attribution'

const log = createLogger('daemon:loop')

const ENABLED = atLeast('attribution')
export const loopProfileEnabled = ENABLED

const ctr = { frames: 0, frameBytes: 0, control: 0, tails: 0, worker: 0 }
interface ControlCost {
  count: number
  wallMs: number
  heapBytes: number
}
const controlCosts = new Map<string, ControlCost>()
/**
 * Lifetime control-type costs, deliberately NOT cleared by the per-second reset.
 *
 * The same two-retention split the query and task instruments already have: the
 * window above exists so a stall line describes the second that stalled, and
 * that is exactly the wrong retention for "what has this daemon been spending
 * control time on since boot", which is the question {@link dumpLoopTotals}
 * answers out of a live process. One recording path, two retentions.
 */
const controlTotals = new Map<string, ControlCost>()

export function countFrame(bytes: number): void {
  if (ENABLED) {
    ctr.frames++
    ctr.frameBytes += bytes
  }
}

/** [spec:SP-c29e] Attribute one complete synchronous control-frame turn (decode + dispatch).
 * Returns a finisher because the message type is only known after decoding.
 * Positive heap deltas are a deliberately cheap allocation-pressure proxy; a
 * GC during the turn contributes zero rather than hiding allocations elsewhere. */
export function beginControlTurn(): (type: string) => void {
  if (!ENABLED) return () => {}
  ctr.control++
  const startedAt = performance.now()
  const heapBefore = process.memoryUsage().heapUsed
  return (type) => {
    const wallMs = performance.now() - startedAt
    const heapBytes = Math.max(0, process.memoryUsage().heapUsed - heapBefore)
    for (const map of [controlCosts, controlTotals]) {
      const cost = map.get(type) ?? { count: 0, wallMs: 0, heapBytes: 0 }
      cost.count++
      cost.wallMs += wallMs
      cost.heapBytes += heapBytes
      map.set(type, cost)
    }
    // NO `attribute('control', …)` HERE, and that is the point of the comment.
    // This turn CONTAINS the `controlParse` and `controlDispatch*` regions that
    // `timeTask` already bills to `control`; adding the turn itself would count
    // the same milliseconds a second time and put the daemon's coverage above 1
    // with nothing declared nested to explain it. This map is the per-type
    // DETAIL — which control message is expensive — not a bucket feed.
  }
}
export function countTail(): void {
  if (ENABLED) ctr.tails++
}
export function countWorker(): void {
  if (ENABLED) ctr.worker++
}

/**
 * Time a labeled synchronous task; log if it blocks the loop > thresholdMs.
 *
 * The timing and the recording are the runtime's `measureTask` now, not a second
 * copy of it (§6.1). The daemon used to time its own regions with its own pair
 * of `performance.now()` calls and keep the numbers to itself, which meant two
 * implementations of one idea and two label conventions — and only one of them
 * could ever reach a cost bucket. What stays daemon-specific is the budget WARN
 * below: the server has no equivalent, and it is the line that turns a slow
 * control dispatch into something a log query can find.
 */
export function timeTask<T>(label: string, fn: () => T, thresholdMs = 50): T {
  if (!ENABLED) return fn()
  const t = performance.now()
  try {
    return measureTask(label, fn)
  } finally {
    const ms = performance.now() - t
    // `durationMs` from a monotonic clock, never a timestamp subtraction —
    // and as a NUMBER, so a query can threshold on it.
    if (ms > thresholdMs) log.warn('daemon task exceeded its budget', { task: label, durationMs: ms })
  }
}

/** Hand this to `startLoopAccounting({ onLongTick })`. Reports the current
 *  window's activity mix + heap; the per-second reset keeps the mix scoped to
 *  the stall. The starved-vs-busy classification (POD-600) rides along when the
 *  probe could compute one (Linux schedstat available), and `utilizationPct` is
 *  how busy the loop was in the second before it — the difference between a
 *  spike on an idle loop and one more block on a saturated one. */
export function reportLongTick(
  ms: number,
  classification?: StallClassification,
  utilizationPct?: number,
): void {
  if (!ENABLED) return
  const mu = process.memoryUsage()
  const controlDetail = formatControlCosts(controlCosts)
  // What the SCHEDULER patch saw, and how much of this stall it explains. Both
  // halves or neither: reporting the top tasks alone invites exactly the mistake
  // POD-1931 was — reading the largest named thing as the cause when the named
  // things together sum to a fraction of the tick.
  const tasks = formatTopTasks()
  const taskCoverage = taskAttributionCoverage(ms)
  // Every number stays a NUMBER and every count its own field: this record
  // exists to be compared across stalls, and the old single formatted string
  // could only be read by eye, one occurrence at a time. It is also the ONLY
  // record of the stall — the runtime probe reports here and logs nothing of
  // its own, which is what stopped every stall being written twice (POD-1932).
  log.warn('daemon event-loop stall', {
    durationMs: ms,
    frames: ctr.frames,
    frameBytes: ctr.frameBytes,
    control: ctr.control,
    tails: ctr.tails,
    worker: ctr.worker,
    heapUsedBytes: mu.heapUsed,
    rssBytes: mu.rss,
    ...(utilizationPct === undefined ? {} : { utilizationPct }),
    ...(controlDetail ? { controlTypes: controlDetail } : {}),
    ...(tasks ? { tasks, taskCoverage } : {}),
    ...(classification
      ? {
          ownCpuMs: classification.ownCpuMs,
          runqueueWaitMs: classification.runqueueWaitMs,
          stallVerdict: classification.verdict,
        }
      : {}),
  })
}

export function formatControlCosts(costs: ReadonlyMap<string, ControlCost>): string {
  return [...costs]
    .sort((a, b) => b[1].wallMs - a[1].wallMs || a[0].localeCompare(b[0]))
    .map(
      ([type, cost]) =>
        type +
        ':' +
        cost.count +
        '/' +
        cost.wallMs.toFixed(0) +
        'ms/+' +
        (cost.heapBytes / 1048576).toFixed(1) +
        'MB',
    )
    .join(',')
}

/** Just the one method the dump needs, so a test can hand it a spy. */
export interface LoopDumpLog {
  warn(message: string, fields?: Record<string, unknown>): void
}

/** How many entries a dumped total list carries. Bounds the log line, not the map. */
const DUMP_LIMIT = 20

/**
 * Dump the daemon's LIFETIME attribution out of a live process — the daemon half
 * of the server's `SIGUSR2` reader (§6.3).
 *
 * The per-second window answers "what stalled this second" and is the only thing
 * the stall line could ever show. The opposite question — "what has this daemon
 * spent its loop on since boot" — is the one you ask of a process that has been
 * up for a week and is not stalling right now, and until this existed nothing
 * could read the totals that were already being kept. It only prints.
 */
export function dumpLoopTotals(target: LoopDumpLog = log): void {
  target.warn('task totals', {
    totals: [...taskAttributionTotals()]
      .sort((a, b) => b[1].wallMs - a[1].wallMs)
      .slice(0, DUMP_LIMIT)
      .map(
        ([label, c]) => `${c.count}x/${c.wallMs.toFixed(0)}ms/max${c.maxMs.toFixed(0)} ${label}`,
      ),
  })
  target.warn('control type costs', { types: formatControlCosts(controlTotals) })
}

let resetTimer: ReturnType<typeof setInterval> | undefined

/**
 * Install the daemon's attribution: the scheduler patch, the per-second window
 * reset, and the `SIGUSR2` reader.
 *
 * `attributeTasks()` goes on FIRST and before the subsystems schedule anything,
 * because the patch wraps a timer at the moment it is CREATED — a sweep whose
 * `setInterval` ran before this is never measured, however long it blocks for.
 * That is also why the daemon was missing this instrument entirely: the server
 * installed it at boot and the daemon never did, so every daemon stall was
 * reported with its timer costs simply absent rather than zero.
 *
 * Returns a stop function. `enabled` is a parameter rather than read from the
 * environment so a caller — and a test — can state the answer.
 *
 * It registers NO signal handler. `SIGUSR2` is one process-wide slot that several
 * dumps want to write to, so the daemon's composition root owns the single
 * `process.on` and calls {@link dumpLoopTotals} from it, next to whatever else it
 * dumps (POD-3819 adds to that same handler). A leaf module that registered its
 * own would make the LAST one installed the only one a reader ever sees.
 */
export function startLoopAttribution(enabled: boolean = ENABLED): () => void {
  if (!enabled || resetTimer) return () => {}
  const restoreSchedulers = attributeTasks(enabled)
  resetTimer = setInterval(() => {
    ctr.frames = 0
    ctr.frameBytes = 0
    ctr.control = 0
    ctr.tails = 0
    ctr.worker = 0
    controlCosts.clear()
    // The task window rides the SAME cadence, so the tasks a stall line names
    // are the tasks of the second it stalled in. A second timer would have been
    // a second answer to "which second is this".
    resetTaskAttribution()
  }, 1000)
  resetTimer.unref?.()
  return () => {
    if (resetTimer) clearInterval(resetTimer)
    resetTimer = undefined
    restoreSchedulers()
  }
}
