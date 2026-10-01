/** Passive sidebar telemetry. No pool, replica, selectors, or React imports.
 * Sources push facts from OUTSIDE the pool; reading this report runs no app work. */
export interface SidebarWork {
  rows: number
  derivations: number
  mainThreadMs: number
}
export type SidebarCheckState = 'off' | 'waiting' | 'checking' | 'match' | 'different' | 'error'
export interface SidebarCheckReport {
  state: SidebarCheckState
  differences: number
  checkedAt: number | null
}
interface WorkEntry {
  at: number
  start: number
  end: number
  rows: number
  derivations: number
  idle: boolean
  update: number | null
  check: boolean
}
const WINDOW_MS = 60_000
const MAX_ENTRIES = 20_000
const emptyWork = (): SidebarWork => ({ rows: 0, derivations: 0, mainThreadMs: 0 })

/** Sum the UNION of measured intervals: nested selectors/row bodies count CPU once. */
function workOf(entries: readonly WorkEntry[]): SidebarWork {
  const result = emptyWork()
  const intervals: Array<[number, number]> = []
  for (const entry of entries) {
    result.rows += entry.rows
    result.derivations += entry.derivations
    if (entry.end > entry.start) intervals.push([entry.start, entry.end])
  }
  intervals.sort((a, b) => a[0] - b[0])
  let end = -Infinity
  for (const interval of intervals) {
    result.mainThreadMs += Math.max(0, interval[1] - Math.max(end, interval[0]))
    end = Math.max(end, interval[1])
  }
  return result
}

export function createSidebarPerf(clock: () => number = () => performance.now()) {
  let openedAt = clock()
  let entries: WorkEntry[] = []
  let overflowAt = -Infinity
  let nextToken = 0
  const inputs = new Set<number>()
  const updates = new Set<number>()
  let lastUpdate: { token: number; changed: string[]; at: number; work: SidebarWork } | null = null
  let lastInputMs: number | null = null
  let inputCount = 0
  // Session-wide percentiles at the displayed 0.1 ms resolution, not a rolling sample ring.
  const inputHistogram = new Map<number, number>()
  let poolRows: number | null = null
  let poolConnected = false
  let check: SidebarCheckReport = { state: 'off', differences: 0, checkedAt: null }
  let checking = 0

  function prune(at: number): void {
    const cutoff = at - WINDOW_MS
    let first = 0
    while (first < entries.length && (entries[first]?.at ?? Infinity) <= cutoff) first++
    if (first > 0) entries = entries.slice(first)
  }
  function percentile(q: number): number | null {
    if (inputCount === 0) return null
    const rank = Math.max(1, Math.ceil(q * inputCount))
    let seen = 0
    for (const [ms, count] of [...inputHistogram].sort((a, b) => a[0] - b[0])) {
      seen += count
      if (seen >= rank) return ms / 10
    }
    return null
  }

  return {
    /** Called after a real body/commit, never by the report reader. */
    record(work: { rows?: number; derivations?: number; start?: number; end?: number }): void {
      const at = clock()
      prune(at)
      const entry: WorkEntry = {
        at,
        start: work.start ?? at,
        end: work.end ?? at,
        rows: work.rows ?? 0,
        derivations: work.derivations ?? 0,
        idle: inputs.size === 0 && updates.size === 0,
        update: lastUpdate && updates.has(lastUpdate.token) ? lastUpdate.token : null,
        check: checking > 0,
      }
      entries.push(entry)
      if (entries.length > MAX_ENTRIES) {
        entries.shift()
        overflowAt = at
      }
    },
    /** Input attribution lasts through the paint boundary, including deferred React work. */
    beginInput(): number {
      const token = ++nextToken
      inputs.add(token)
      return token
    },
    endInput(token: number, inputAt: number, sidebar: boolean): void {
      if (!inputs.delete(token) || !sidebar) return
      const ms = Math.max(0, clock() - inputAt)
      lastInputMs = ms
      inputCount++
      const bucket = Math.round(ms * 10)
      inputHistogram.set(bucket, (inputHistogram.get(bucket) ?? 0) + 1)
    },
    /** Only table/field names; never ids, titles, row values, or an app snapshot. */
    beginUpdate(changed: readonly string[]): number {
      const token = ++nextToken
      updates.add(token)
      lastUpdate = {
        token,
        changed: changed.slice(0, 32).map((name) => name.slice(0, 80)),
        at: clock(),
        work: emptyWork(),
      }
      return token
    },
    endUpdate(token: number): void {
      if (!updates.delete(token) || lastUpdate?.token !== token) return
      lastUpdate.work = workOf(entries.filter((entry) => entry.update === token && !entry.check))
    },
    /** The bridge maintains this scalar from residency changes. The panel never counts tables. */
    pool(connected: boolean, rows: number | null): void {
      poolConnected = connected
      poolRows = rows
    },
    check(report: SidebarCheckReport): void {
      check = { ...report }
    },
    /** S5's deliberate comparison work has its own counter, even when it reads the pool. */
    beginCheck(): () => void {
      checking++
      let ended = false
      return () => {
        if (!ended) {
          ended = true
          checking--
        }
      }
    },
    read() {
      const at = clock()
      prune(at)
      const update = lastUpdate
      return {
        observedMs: at - openedAt,
        windowMs: Math.min(WINDOW_MS, at - openedAt),
        complete: at - overflowAt >= WINDOW_MS,
        idle: workOf(entries.filter((entry) => entry.idle && !entry.check)),
        checkWork: workOf(entries.filter((entry) => entry.check)),
        lastUpdate: update
          ? {
              changed: [...update.changed],
              at: update.at,
              pending: updates.has(update.token),
              work: updates.has(update.token)
                ? workOf(entries.filter((entry) => entry.update === update.token && !entry.check))
                : { ...update.work },
            }
          : null,
        input: {
          lastMs: lastInputMs,
          p50: percentile(0.5),
          p95: percentile(0.95),
          count: inputCount,
        },
        pool: { connected: poolConnected, rows: poolRows },
        check: { ...check },
      }
    },
    reset(): void {
      openedAt = clock()
      entries = []
      overflowAt = -Infinity
      inputs.clear()
      updates.clear()
      lastUpdate = null
      lastInputMs = null
      inputCount = 0
      inputHistogram.clear()
      poolConnected = false
      poolRows = null
      check = { state: 'off', differences: 0, checkedAt: null }
      checking = 0
    },
  }
}
export type SidebarPerf = ReturnType<typeof createSidebarPerf>
export type SidebarPerfSnapshot = ReturnType<SidebarPerf['read']>

// One open panel, bound to the current StoreProvider owner. No source is retained after close.
let sink: { owner: object; perf: SidebarPerf; afterPaint: (done: () => void) => void } | null = null
const poolReports = new WeakMap<object, { rows: number | null; connected: boolean }>()
const checkReports = new WeakMap<object, SidebarCheckReport>()
const bindingListeners = new WeakMap<object, Set<(perf: SidebarPerf | null) => void>>()

/** An outside work meter lives only while this owner's panel is open. */
export function observeSidebarPerfBinding(
  owner: object,
  listener: (perf: SidebarPerf | null) => void,
): () => void {
  let listeners = bindingListeners.get(owner)
  if (!listeners) {
    listeners = new Set()
    bindingListeners.set(owner, listeners)
  }
  listener(sidebarPerfFor(owner))
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
    listener(null)
  }
}

function notifyBinding(owner: object, perf: SidebarPerf | null): void {
  for (const listener of bindingListeners.get(owner) ?? []) listener(perf)
}

export function bindSidebarPerf(
  owner: object,
  perf: SidebarPerf,
  afterPaint: (done: () => void) => void = queueMicrotask,
): () => void {
  if (sink) notifyBinding(sink.owner, null)
  const binding = { owner, perf, afterPaint }
  sink = binding
  const pool = poolReports.get(owner)
  if (pool) perf.pool(pool.connected, pool.rows)
  const check = checkReports.get(owner)
  if (check) perf.check(check)
  notifyBinding(owner, perf)
  return () => {
    if (sink === binding) {
      sink = null
      notifyBinding(owner, null)
    }
  }
}
export function sidebarPerfFor(owner: object): SidebarPerf | null {
  return sink?.owner === owner ? sink.perf : null
}
/** Bracket the existing replica publication, including its scheduled derivations
 * and row commits through paint. No snapshot or second feed subscription. */
export function beginSidebarUpdate(
  owner: object,
  changed: readonly string[] | ReadonlySet<string>,
): (() => void) | undefined {
  if (sink?.owner !== owner) return undefined
  const binding = sink
  const token = binding.perf.beginUpdate([...changed])
  const start = performance.now()
  return () => {
    binding.perf.record({ start, end: performance.now() })
    binding.afterPaint(() => binding.perf.endUpdate(token))
  }
}
/** Bridge-owned scalars only. Publishing these never reads or retains a pool. */
export function reportSidebarPool(owner: object, rows: number | null, connected = true): void {
  poolReports.set(owner, { rows, connected })
  sidebarPerfFor(owner)?.pool(connected, rows)
}
export function recordSidebarDerivation(owner: object, start: number, end: number): void {
  sidebarPerfFor(owner)?.record({ derivations: 1, start, end })
}
export function reportSidebarCheck(owner: object, report: SidebarCheckReport): void {
  checkReports.set(owner, { ...report })
  sidebarPerfFor(owner)?.check(report)
}
export function beginSidebarCheck(owner: object): () => void {
  return sidebarPerfFor(owner)?.beginCheck() ?? (() => {})
}
