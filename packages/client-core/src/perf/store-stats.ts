/** Opt-in local diagnostics. Never retains snapshots, listeners, or payloads. */
export const STORE_STATS_LIMITS = {
  runtimes: 32,
  windows: 32,
  publishes: 256,
  names: 64,
  marks: 64,
} as const
export interface StoreCounts {
  publishes: number
  nestedPublishes: number
  subscriberWakes: number
  selectorRuns: number
  selectorCacheMisses: number
  rowBuilds: number
  reactCommits: number
  slices: Record<string, number>
}
interface RuntimeCounts extends StoreCounts {
  runtime: number
}
interface PublishRecord {
  runtime: number
  window: number | null
  changedKeys: string[]
  nested: boolean
  subscriberWakes: number
}
interface CaptureWindow {
  id: number
  kind: 'gesture' | 'feed'
  switchId?: string
  ended: boolean
  runtimes: RuntimeCounts[]
  marks: Array<{ name: string; counts: Omit<StoreCounts, 'slices'> & { sliceDerivations: number } }>
}
const empty = (): StoreCounts => ({
  publishes: 0,
  nestedPublishes: 0,
  subscriberWakes: 0,
  selectorRuns: 0,
  selectorCacheMisses: 0,
  rowBuilds: 0,
  reactCommits: 0,
  slices: {},
})
let enabled = false
let ids = new WeakMap<object, number>()
const aliases = new WeakMap<object, object>()
let nextRuntime = 0
let nextWindow = 0
let active: CaptureWindow | undefined
const runtimes = new Map<number, RuntimeCounts>()
const windows: CaptureWindow[] = []
const publishes: PublishRecord[] = []
let dropped = 0

/** Weak association only; needed even when enabled after runtime construction. */
export function bindStoreStatsOwner(alias: object, owner: object): void {
  aliases.set(alias, owner)
}
function runtimeId(owner: object): number {
  owner = aliases.get(owner) ?? owner
  let id = ids.get(owner)
  if (id === undefined) {
    id = ++nextRuntime
    ids.set(owner, id)
  }
  return id
}
function counts(id: number): RuntimeCounts {
  let c = runtimes.get(id)
  if (!c) {
    if (runtimes.size === STORE_STATS_LIMITS.runtimes) {
      runtimes.delete(runtimes.keys().next().value!)
      dropped++
    }
    c = { runtime: id, ...empty() }
    runtimes.set(id, c)
  }
  return c
}
type Metric = keyof Omit<StoreCounts, 'slices'> | 'sliceDerivations'
function add(c: StoreCounts, metric: Metric, name?: string): void {
  if (metric !== 'sliceDerivations') {
    c[metric]++
    return
  }
  const key = (name ?? '').slice(0, 80)
  if (Object.hasOwn(c.slices, key)) c.slices[key] = (c.slices[key] ?? 0) + 1
  else if (Object.keys(c.slices).length < STORE_STATS_LIMITS.names)
    Object.defineProperty(c.slices, key, {
      value: 1,
      writable: true,
      enumerable: true,
      configurable: true,
    })
  else dropped++
}
function record(owner: object, metric: Metric, name?: string): void {
  if (!enabled) return
  const id = runtimeId(owner)
  add(counts(id), metric, name)
  if (active) {
    let c = active.runtimes.find((c) => c.runtime === id)
    if (!c && active.runtimes.length < STORE_STATS_LIMITS.runtimes) {
      c = { runtime: id, ...empty() }
      active.runtimes.push(c)
    }
    if (c) add(c, metric, name)
    else dropped++
  }
}
export function recordStoreSelector(owner: object): void {
  if (!enabled) return
  record(owner, 'selectorCacheMisses')
  record(owner, 'selectorRuns')
}
export function recordSliceDerivation(owner: object, name: string): void {
  if (enabled) record(owner, 'sliceDerivations', name)
}
export function recordIssueRowBuild(owner: object): void {
  if (enabled) record(owner, 'rowBuilds')
}
/** Pass this through a React Profiler onRender callback. Counts that subtree's commits, not renders. */
export function recordStoreReactCommit(owner: object): void {
  if (enabled) record(owner, 'reactCommits')
}
export function recordStorePublish(
  owner: object,
  changedKeys?: ReadonlySet<string>,
  nested = false,
): PublishRecord | undefined {
  if (!enabled) return
  record(owner, 'publishes')
  if (nested) record(owner, 'nestedPublishes')
  const entry = {
    runtime: runtimeId(owner),
    window: active?.id ?? null,
    changedKeys: changedKeys
      ? Array.from(changedKeys)
          .slice(0, 256)
          .map((key) => key.slice(0, 80))
      : [],
    nested,
    subscriberWakes: 0,
  }
  publishes.push(entry)
  if (publishes.length > STORE_STATS_LIMITS.publishes) {
    publishes.shift()
    dropped++
  }
  return entry
}
export function recordStoreSubscriber(owner: object, publish: PublishRecord | undefined): void {
  if (!enabled) return
  record(owner, 'subscriberWakes')
  if (publish) publish.subscriberWakes++
}
export function beginStoreStatsWindow(
  kind: 'gesture' | 'feed',
  switchId?: string,
): number | undefined {
  if (!enabled) return
  if (active) active.ended = true
  active = {
    id: ++nextWindow,
    kind,
    ...(switchId ? { switchId: switchId.slice(0, 80) } : {}),
    ended: false,
    runtimes: [],
    marks: [],
  }
  windows.push(active)
  if (windows.length > STORE_STATS_LIMITS.windows) {
    windows.shift()
    dropped++
  }
  return active.id
}
export function endStoreStatsWindow(id: number | undefined): void {
  if (active && active.id === id) {
    active.ended = true
    active = undefined
  }
}
/** Names only. Switch mark metadata can contain authored data and is never copied. */
export function markStoreStats(name: string): void {
  if (!enabled || !active) return
  if (active.marks.length >= STORE_STATS_LIMITS.marks) {
    dropped++
    return
  }
  const { slices: _, ...totals } = empty()
  let sliceDerivations = 0
  for (const c of active.runtimes) {
    for (const key of Object.keys(totals) as Array<keyof typeof totals>) totals[key] += c[key]
    for (const count of Object.values(c.slices)) sliceDerivations += count
  }
  active.marks.push({ name: name.slice(0, 80), counts: { ...totals, sliceDerivations } })
}
export function readStoreStats() {
  return structuredClone({ enabled, dropped, runtimes: [...runtimes.values()], windows, publishes })
}
/** Test-side reader scoped by the actual runtime/handle (or its bound replica). */
export function readRuntimeStoreStats(owner: object): RuntimeCounts | undefined {
  const id = ids.get(aliases.get(owner) ?? owner)
  const result = id === undefined ? undefined : runtimes.get(id)
  return result ? structuredClone(result) : undefined
}
export function resetStoreStats(): void {
  ids = new WeakMap()
  active = undefined
  runtimes.clear()
  windows.length = 0
  publishes.length = 0
  dropped = 0
}
export const storeStats = {
  snapshot: readStoreStats,
  reset: resetStoreStats,
  enable(value = true): void {
    enabled = value
    if (!value && active) {
      active.ended = true
      active = undefined
    }
  },
  begin: beginStoreStatsWindow,
  end: endStoreStatsWindow,
}
Object.defineProperty(globalThis, '__podiumStoreStats', { value: storeStats, configurable: true })
declare global {
  var __podiumStoreStats: typeof storeStats | undefined
}
