/**
 * THE WARM SET (POD-7161, design POD-7157 "Layer 2: memory", "Decisions").
 *
 * Memory holds three kinds of instances:
 *  - ALWAYS: the policy collections and the stub table, bounded by active
 *    work, never unloaded;
 *  - HELD: every instance a view reads (holding follows reading, POD-7158),
 *    and every instance a fetch or a disk load is filling; never unloaded;
 *  - WARM: instances whose last reader went away, ordered by when they were
 *    released. Going back to a screen just left costs nothing.
 *
 * The warm set has a budget in estimated MB per client type (the policy's
 * `memoryBudgetMb`): the sum of the warm rows' sizes from the disk index,
 * times a per-kind memory factor (POD-7164 measures it). It shrinks only on
 * an idle tick, when the page or app goes to the background, or on a
 * platform memory warning; never inside a fetch completion, a feed apply or
 * a render. It unloads warm instances, released longest ago first, until it
 * is under budget, and never one released less than {@link WARM_GRACE_MS}
 * ago, unless the platform warns of low memory.
 *
 * Leaving memory is not leaving the device: an unloaded instance keeps its
 * marker and its rows on disk, and a reader gets LOADING and a disk load,
 * never a server request (POD-7159's `unload`). Only pruning (POD-7162)
 * removes data from the device.
 *
 * This file is the planner and the signal port. The Replica owns when it
 * runs (its holds, fetches and disk loads are what is held).
 */

import { comesWithHolderKey, type DiskIndexReader, splitRowKey } from './disk-index'

/** An instance released less than this long ago survives the budget, except on a memory warning. */
export const WARM_GRACE_MS = 60_000

/**
 * Estimated bytes in memory per byte on disk, per record kind: the row as
 * objects, plus the pool's models and indexes over it. A constant until
 * POD-7164 measures it (POD-7095 measured about 5 KB per record in memory).
 */
export const DEFAULT_MEMORY_FACTOR = 4
export const MEMORY_FACTORS: Readonly<Record<string, number>> = {}

export const memoryFactorOf = (kind: string): number =>
  MEMORY_FACTORS[kind] ?? DEFAULT_MEMORY_FACTOR

const MB = 1024 * 1024

/**
 * The warm set's budget: estimated bytes in memory (from the policy's
 * `memoryBudgetMb`), or, for tests, a number of warm instances.
 */
export type WarmBudget = { readonly bytes: number } | { readonly instances: number }

export const warmBudgetOfMb = (mb: number): WarmBudget => ({ bytes: mb * MB })

/** Why memory shrinks now. */
export type ShrinkReason = 'idle' | 'background' | 'memoryWarning'

/**
 * Where the platform tells memory it may shrink. The web: `requestIdleCallback`
 * and `visibilitychange`; the phone: an idle timer after interactions, and
 * AppState's `background` and `memoryWarning`. Without it nothing shrinks.
 */
export interface MemorySignals {
  /** Run `run` once at the next idle moment; returns its cancel. */
  requestIdle(run: () => void): () => void
  /** The app went to the background, or the platform warned of low memory. */
  subscribe(listener: (reason: 'background' | 'memoryWarning') => void): () => void
}

export interface UnloadPlanInput {
  readonly index: DiskIndexReader
  /** Whether a record's row is whole in memory. */
  resident(rowKey: string): boolean
  /** Always and held: the policy's instances, the views' holds, fetches and disk loads in flight. */
  readonly pinned: ReadonlySet<string>
  /** When a warm instance was released. */
  releasedAt(instanceKey: string): number
  readonly now: number
  readonly budget: WarmBudget
  /** Keep instances released less than {@link WARM_GRACE_MS} ago (false on a memory warning). */
  readonly grace: boolean
}

export interface UnloadPlan {
  /** The warm instances to unload, released longest ago first. */
  readonly unload: readonly string[]
  /** The warm set before and after, in estimated bytes and instances. */
  readonly before: { readonly bytes: number; readonly instances: number }
  readonly after: { readonly bytes: number; readonly instances: number }
  /** Still over budget only because of the grace: when the oldest kept instance leaves it. */
  readonly graceEndsAt?: number
}

/** The rows an instance keeps in memory: its members, and what each of them comes with. */
function footprint(
  index: DiskIndexReader,
  resident: (rowKey: string) => boolean,
  key: string,
  into: Set<string>,
): void {
  const queue: string[] = []
  const add = (row: string): void => {
    if (into.has(row) || !resident(row)) return
    into.add(row)
    queue.push(row)
  }
  for (const member of index.membersOf(key)) add(member)
  for (let at = 0; at < queue.length; at += 1)
    for (const member of index.membersOf(comesWithHolderKey(queue[at] as string))) add(member)
}

/** Estimated bytes in memory of one record on the device. */
function estimatedBytes(index: DiskIndexReader, rowKey: string): number {
  const bytes = index.record(rowKey)?.bytes ?? 0
  return bytes * memoryFactorOf(splitRowKey(rowKey).entity)
}

/**
 * Plan a shrink: which warm instances leave memory so the warm set is within
 * its budget. Never a pinned instance, whatever the budget. A row several
 * warm instances keep counts once, and leaves the estimate with the last of
 * them; a row an always or held instance keeps is not warm.
 */
export function planUnload(input: UnloadPlanInput): UnloadPlan {
  const { index, resident } = input
  const pinnedRows = new Set<string>()
  for (const key of input.pinned) footprint(index, resident, key, pinnedRows)
  const warm = [...index.memoryInstances()]
    .filter((key) => !input.pinned.has(key))
    .map((key) => ({ key, at: input.releasedAt(key) }))
    .sort((a, b) => a.at - b.at || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
  /** Warm row → how many warm instances keep it. */
  const keptBy = new Map<string, number>()
  const rowsOf = new Map<string, readonly string[]>()
  let bytes = 0
  for (const { key } of warm) {
    const rows = new Set<string>()
    footprint(index, resident, key, rows)
    const own: string[] = []
    for (const row of rows) {
      if (pinnedRows.has(row)) continue
      own.push(row)
      const count = keptBy.get(row) ?? 0
      if (count === 0) bytes += estimatedBytes(index, row)
      keptBy.set(row, count + 1)
    }
    rowsOf.set(key, own)
  }
  const before = { bytes, instances: warm.length }
  let instances = warm.length
  const over = (): boolean =>
    'bytes' in input.budget ? bytes > input.budget.bytes : instances > input.budget.instances
  const unload: string[] = []
  let graceEndsAt: number | undefined
  for (const { key, at } of warm) {
    if (!over()) break
    // Released in order: this one and every later one are within the grace.
    if (input.grace && input.now - at < WARM_GRACE_MS) {
      graceEndsAt = at + WARM_GRACE_MS
      break
    }
    unload.push(key)
    instances -= 1
    for (const row of rowsOf.get(key) ?? []) {
      const count = (keptBy.get(row) ?? 1) - 1
      keptBy.set(row, count)
      if (count === 0) bytes -= estimatedBytes(index, row)
    }
  }
  return {
    unload,
    before,
    after: { bytes, instances },
    ...(graceEndsAt === undefined ? {} : { graceEndsAt }),
  }
}

/**
 * Signals a test drives by hand: `idle()` runs the idle callbacks memory asked
 * for, `background()` and `memoryWarning()` tell it what the platform would.
 */
export function manualMemorySignals(): MemorySignals & {
  /** Run every idle callback asked for so far; returns how many ran. */
  idle(): number
  background(): void
  memoryWarning(): void
  /** Idle callbacks asked for and not yet run. */
  readonly pendingIdle: number
} {
  const idle = new Set<() => void>()
  const listeners = new Set<(reason: 'background' | 'memoryWarning') => void>()
  return {
    requestIdle(run) {
      const entry = () => run()
      idle.add(entry)
      return () => {
        idle.delete(entry)
      }
    },
    subscribe(listener) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    idle() {
      const due = [...idle]
      idle.clear()
      for (const run of due) run()
      return due.length
    },
    background() {
      for (const listener of [...listeners]) listener('background')
    },
    memoryWarning() {
      for (const listener of [...listeners]) listener('memoryWarning')
    },
    get pendingIdle() {
      return idle.size
    },
  }
}

/**
 * The browser's signals: `requestIdleCallback` (a timer where the host has
 * none, as Safari), and the page going hidden. A browser has no memory
 * warning.
 */
export function browserMemorySignals(
  host: {
    readonly requestIdleCallback?: (run: () => void, options?: { timeout: number }) => number
    readonly cancelIdleCallback?: (id: number) => void
    readonly document?: {
      readonly visibilityState?: string
      addEventListener(type: 'visibilitychange', listener: () => void): void
      removeEventListener(type: 'visibilitychange', listener: () => void): void
    }
  } = globalThis as never,
): MemorySignals {
  return {
    requestIdle(run) {
      if (typeof host.requestIdleCallback === 'function') {
        const id = host.requestIdleCallback(run)
        return () => host.cancelIdleCallback?.(id)
      }
      const timer = setTimeout(run, IDLE_FALLBACK_MS)
      ;(timer as { unref?: () => void }).unref?.()
      return () => clearTimeout(timer)
    },
    subscribe(listener) {
      const document = host.document
      if (document === undefined) return () => {}
      const onChange = (): void => {
        if (document.visibilityState === 'hidden') listener('background')
      }
      document.addEventListener('visibilitychange', onChange)
      return () => document.removeEventListener('visibilitychange', onChange)
    },
  }
}

/** Where the host has no idle callback: a quiet moment after this long. */
export const IDLE_FALLBACK_MS = 2_000
