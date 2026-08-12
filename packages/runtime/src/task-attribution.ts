/**
 * Per-callback attribution for SCHEDULED work, the counterpart to the SQLite
 * seam's `attributeQueries`.
 *
 * WHY THIS EXISTS (POD-1931). Query attribution answered "which statement" and
 * closed one gap; it cannot close the other. Measured on the live server after
 * the query-shaped costs were fixed: the loop was blocked 19.4s over five
 * minutes while every instrumented phase summed to ~2s and the top statements to
 * ~4s. So ~70% of the remaining stall was work that runs no SQL and sits inside
 * no `perf.record` — and nothing in the process could name it. A stall reporter
 * that can only describe the costs it already knows about will keep confirming
 * them; it took a wrong conclusion on a live incident to notice.
 *
 * Almost all of that work is SCHEDULED: sweeps on `setInterval`, deferred
 * flushes on `setTimeout(fn, 0)`, coalescing hops through `queueMicrotask`. This
 * times the callback itself, so a slow sweep is attributed to the site that
 * scheduled it rather than to whatever unlucky frame it landed in.
 *
 * NOT COVERED, deliberately: completions of async I/O (fs, net, child process).
 * Instrumenting those means `async_hooks`, whose per-resource cost is a
 * different order of magnitude from the two `performance.now()` calls here. If
 * the gap survives this instrument, that absence is the next hypothesis rather
 * than a reason to distrust the numbers — see `taskAttributionCoverage`.
 *
 * Like `attributeQueries`, this is a diagnostic and never a budget: with the
 * flag unset `attributeTasks` is a no-op and the process carries no cost.
 */

const ENABLED = !!process.env.PODIUM_LOOP_PROFILE
export const taskAttributionEnabled = ENABLED

/**
 * Creation-site labels, one level deeper than the callback name (mirrors
 * `PODIUM_LOOP_PROFILE_STACKS` on the query side). A stack capture at SCHEDULING
 * time is what turns `<anonymous>` into a file and line, and it is far more
 * expensive than the timing pair — a hot `setTimeout(fn, 0)` path would pay it
 * on every hop. So it sits behind its own flag, and even then only the first
 * capture per callback identity is kept.
 */
const STACKS = ENABLED && !!process.env.PODIUM_LOOP_PROFILE_STACKS

export interface TaskCost {
  /** Callback invocations in the current window. */
  count: number
  /** Summed wall time of those invocations, ms. */
  wallMs: number
  /** The single slowest invocation in the window, ms. */
  maxMs: number
}

const costs = new Map<string, TaskCost>()
const totals = new Map<string, TaskCost>()

/**
 * Labels are cached per callback IDENTITY, so a `setInterval` sweep pays for its
 * stack once for the life of the process rather than once per fire. A callsite
 * that allocates a fresh closure per schedule defeats the cache by construction;
 * that is what the capture cap below is for.
 */
const labels = new WeakMap<object, string>()
let capturesLeft = 2000

const site = (fn: object, kind: string, delayMs?: number): string => {
  const cached = labels.get(fn)
  if (cached !== undefined) return cached
  const named = typeof fn === 'function' && fn.name ? fn.name : '<anonymous>'
  let label = delayMs === undefined ? `${kind} ${named}` : `${kind}(${delayMs}) ${named}`
  if (STACKS && capturesLeft > 0) {
    capturesLeft--
    const frame = (new Error().stack ?? '')
      .split('\n')
      .slice(1)
      .map((line) => line.trim())
      // Drop this module's frames so the top one is the code that scheduled it.
      .find((line) => !line.includes('task-attribution'))
    if (frame) label = `${label} @ ${frame}`
  }
  labels.set(fn, label)
  return label
}

/** Record one callback invocation under `label`. */
export function recordTask(label: string, wallMs: number): void {
  const cost = costs.get(label) ?? { count: 0, wallMs: 0, maxMs: 0 }
  cost.count++
  cost.wallMs += wallMs
  if (wallMs > cost.maxMs) cost.maxMs = wallMs
  costs.set(label, cost)
  const total = totals.get(label) ?? { count: 0, wallMs: 0, maxMs: 0 }
  total.count++
  total.wallMs += wallMs
  if (wallMs > total.maxMs) total.maxMs = wallMs
  totals.set(label, total)
}

/** Lifetime per-callsite totals since process start. Never reset. */
export function taskAttributionTotals(): ReadonlyMap<string, TaskCost> {
  return new Map(totals)
}

/** Snapshot of the current window, for tests and callers that format their own. */
export function taskAttributionSnapshot(): ReadonlyMap<string, TaskCost> {
  return new Map(costs)
}

/**
 * The window's scheduled work, most expensive first by summed wall time.
 * `limit` bounds the log line, not the measurement.
 */
export function formatTopTasks(
  limit = 3,
  source: ReadonlyMap<string, TaskCost> = costs,
): string {
  return [...source]
    .sort((a, b) => b[1].wallMs - a[1].wallMs || a[0].localeCompare(b[0]))
    .slice(0, limit)
    .map(([label, c]) => `${c.count}x/${c.wallMs.toFixed(0)}ms/max${c.maxMs.toFixed(0)} ${label}`)
    .join(' | ')
}

/**
 * How much of a stall this instrument actually SAW.
 *
 * The honest reading of a stall line needs both halves: what was measured, and
 * how much of the tick is still unaccounted for. Reporting only the top tasks
 * invites the same mistake as before — treating the largest named thing as the
 * cause when the named things sum to a fraction of the total.
 */
export function taskAttributionCoverage(stallMs: number): number {
  let sum = 0
  for (const cost of costs.values()) sum += cost.wallMs
  return stallMs <= 0 ? 0 : sum / stallMs
}

/** Drop the window. The reset cadence is owned by the caller that reports stalls. */
export function resetTaskAttribution(): void {
  costs.clear()
}

type TimerFn = (...args: unknown[]) => void

/**
 * Patch the process's schedulers so every callback they run is timed.
 *
 * Returns a restore function, and is a NO-OP returning a no-op when attribution
 * is off — that is the whole cost model. `enabled` is a parameter rather than
 * read from the environment so a caller (and a test) can state the answer.
 *
 * The wrapping is per SCHEDULE, not per fire, for `setInterval`: one wrapper
 * closure serves every fire of that timer. The hot path a fire pays is two
 * `performance.now()` calls and a map update.
 */
export function attributeTasks(enabled: boolean = ENABLED): () => void {
  if (!enabled) return () => {}
  const g = globalThis as unknown as Record<string, unknown>
  const originals = {
    setTimeout: g.setTimeout,
    setInterval: g.setInterval,
    setImmediate: g.setImmediate,
    queueMicrotask: g.queueMicrotask,
  }

  const timed = (fn: TimerFn, label: string): TimerFn =>
    function (this: unknown, ...args: unknown[]) {
      const startedAt = performance.now()
      try {
        return fn.apply(this, args)
      } finally {
        recordTask(label, performance.now() - startedAt)
      }
    }

  const wrapScheduler = (name: 'setTimeout' | 'setInterval' | 'setImmediate'): void => {
    const original = originals[name] as (...a: unknown[]) => unknown
    if (typeof original !== 'function') return
    const patched = (handler: unknown, ...rest: unknown[]): unknown => {
      // A string handler is `eval`-shaped and has no identity to key on; pass it
      // through untouched rather than pretend to measure it.
      if (typeof handler !== 'function') return original(handler, ...rest)
      const delay = name === 'setImmediate' ? undefined : Number(rest[0] ?? 0)
      const label = site(handler as object, name, delay)
      return original(timed(handler as TimerFn, label), ...rest)
    }
    // Node hangs helpers off setTimeout/setInterval (`__promisify__`); carry them.
    Object.assign(patched, original)
    g[name] = patched
  }
  wrapScheduler('setTimeout')
  wrapScheduler('setInterval')
  wrapScheduler('setImmediate')

  const originalMicrotask = originals.queueMicrotask as ((cb: () => void) => void) | undefined
  if (typeof originalMicrotask === 'function') {
    g.queueMicrotask = (cb: () => void): void => {
      if (typeof cb !== 'function') return originalMicrotask(cb)
      originalMicrotask(timed(cb as TimerFn, site(cb, 'microtask')) as () => void)
    }
  }

  return () => {
    g.setTimeout = originals.setTimeout
    g.setInterval = originals.setInterval
    g.setImmediate = originals.setImmediate
    g.queueMicrotask = originals.queueMicrotask
  }
}
