/**
 * THE WARM SET, AS A PROPERTY (POD-7161 acceptance 1, 2 and 3).
 *
 * The planner over random disk indexes: it never names a pinned (always or
 * held) instance, it unloads the warm instances released longest ago first,
 * no more than it must, and leaves the warm set within its budget unless
 * only instances within the grace are left to unload.
 *
 * The Replica over random sequences of opening and closing screens, time
 * passing, idle ticks, the background and memory warnings, at a random
 * budget: an instance a view holds is never unloaded, and after an idle tick
 * past the grace the warm set is within its budget. Without a signal,
 * nothing leaves memory.
 */

import { describe, expect, it, vi } from 'vitest'
import { CollectionServer, issue, WORLD_NOW, WORLD_POLICY } from '../conformance/collection-server'
import { inMemoryInstantiation } from '../conformance/in-memory'
import { instanceKey } from './cache-state'
import {
  COMES_WITH_HOLDER,
  type DiskIndexReader,
  type InstanceState,
  type RecordEntry,
} from './disk-index'
import {
  browserMemorySignals,
  IDLE_FALLBACK_MS,
  manualMemorySignals,
  memoryFactorOf,
  planUnload,
  WARM_GRACE_MS,
  type WarmBudget,
} from './memory'
import { Replica } from './replica'
import type { InstanceSpec } from './types'

const ISSUE = 'issueProjection'

/** mulberry32: a small seeded generator, so a failing case can be replayed by its seed. */
function random(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296
  }
}

const rowKey = (id: string) => `${ISSUE}\u0000${id}`

/** A disk index of the shape the planner reads: records with sizes, instances with members. */
class FakeIndex implements DiskIndexReader {
  readonly version = 1
  readonly bucketCount = 1
  readonly entries = new Map<string, RecordEntry>()
  readonly members = new Map<string, Set<string>>()
  readonly memory = new Set<string>()
  get recordCount() {
    return this.entries.size
  }
  get bytes() {
    let sum = 0
    for (const entry of this.entries.values()) sum += entry.bytes
    return sum
  }
  record(key: string) {
    return this.entries.get(key)
  }
  records() {
    return this.entries.entries()
  }
  membersOf(key: string): ReadonlySet<string> {
    return this.members.get(key) ?? new Set()
  }
  pointedBy(): ReadonlySet<string> {
    return new Set()
  }
  instance(): InstanceState | undefined {
    return undefined
  }
  instanceKeys(): IterableIterator<string> {
    return new Set<string>().values()
  }
  inMemory(key: string) {
    return this.memory.has(key)
  }
  memoryInstances(): ReadonlySet<string> {
    return this.memory
  }
}

interface PlanCase {
  readonly index: FakeIndex
  readonly resident: Set<string>
  readonly pinned: Set<string>
  readonly released: Map<string, number>
  readonly now: number
  readonly budget: WarmBudget
  readonly grace: boolean
}

function planCase(seed: number): PlanCase {
  const next = random(seed)
  const index = new FakeIndex()
  const rows: string[] = []
  const resident = new Set<string>()
  for (let i = 0; i < 5 + Math.floor(next() * 40); i += 1) {
    const key = rowKey(`R${i}`)
    rows.push(key)
    index.entries.set(key, {
      seq: 1,
      level: 'main',
      bytes: 100 + Math.floor(next() * 2_000),
      holders: [],
      cw: [],
      pt: [],
    })
    if (next() < 0.9) resident.add(key)
  }
  const pick = () => rows[Math.floor(next() * rows.length)] as string
  const instances: string[] = []
  for (let i = 0; i < 1 + Math.floor(next() * 10); i += 1) {
    const key = `instance-${i}`
    instances.push(key)
    const members = new Set<string>()
    for (let m = 0; m < Math.floor(next() * 8); m += 1) members.add(pick())
    index.members.set(key, members)
    if (next() < 0.85) index.memory.add(key)
  }
  // What some records come with: rows held by a record (`^` + its key).
  for (let i = 0; i < Math.floor(next() * 6); i += 1) {
    const holder = `${COMES_WITH_HOLDER}${pick()}`
    const members = index.members.get(holder) ?? new Set<string>()
    members.add(pick())
    index.members.set(holder, members)
  }
  const pinned = new Set(instances.filter(() => next() < 0.3))
  const now = WORLD_NOW
  const released = new Map(
    instances.map((key) => [key, now - Math.floor(next() * 3 * WARM_GRACE_MS)] as const),
  )
  const budget: WarmBudget =
    next() < 0.5
      ? { instances: Math.floor(next() * 4) }
      : { bytes: Math.floor(next() * 40_000 * memoryFactorOf(ISSUE)) }
  return { index, resident, pinned, released, now, budget, grace: next() < 0.6 }
}

/** The oracle: the warm set's estimated bytes and instances, recomputed from scratch. */
function warmOf(c: PlanCase, unloaded: ReadonlySet<string>) {
  const closure = (keys: Iterable<string>) => {
    const out = new Set<string>()
    const queue: string[] = []
    const add = (row: string) => {
      if (out.has(row) || !c.resident.has(row)) return
      out.add(row)
      queue.push(row)
    }
    for (const key of keys) for (const row of c.index.membersOf(key)) add(row)
    for (let at = 0; at < queue.length; at += 1)
      for (const row of c.index.membersOf(`${COMES_WITH_HOLDER}${queue[at]}`)) add(row)
    return out
  }
  const pinnedRows = closure(c.pinned)
  const warm = [...c.index.memory].filter((key) => !c.pinned.has(key) && !unloaded.has(key))
  let bytes = 0
  for (const row of closure(warm))
    if (!pinnedRows.has(row)) bytes += (c.index.record(row)?.bytes ?? 0) * memoryFactorOf(ISSUE)
  return { bytes, instances: warm.length, warm }
}

const within = (budget: WarmBudget, warm: { bytes: number; instances: number }) =>
  'bytes' in budget ? warm.bytes <= budget.bytes : warm.instances <= budget.instances

describe('the warm set planner, over random disk indexes', () => {
  it('never names a pinned instance; leaves the warm set within budget, oldest first, no more than it must', () => {
    let unloadedAny = 0
    let graceStops = 0
    for (let seed = 1; seed <= 2_000; seed += 1) {
      const c = planCase(seed)
      const plan = planUnload({
        index: c.index,
        resident: (key) => c.resident.has(key),
        pinned: c.pinned,
        releasedAt: (key) => c.released.get(key) ?? c.now,
        now: c.now,
        budget: c.budget,
        grace: c.grace,
      })
      const at = `seed ${seed}`
      const unloaded = new Set(plan.unload)
      // Acceptance 1: nothing pinned, at any budget, with or without the grace.
      for (const key of plan.unload) expect(c.pinned.has(key), at).toBe(false)
      const before = warmOf(c, new Set())
      const after = warmOf(c, unloaded)
      expect(plan.before, at).toEqual({ bytes: before.bytes, instances: before.instances })
      expect(plan.after, at).toEqual({ bytes: after.bytes, instances: after.instances })
      // Oldest first: everything unloaded was released no later than everything kept.
      const newestUnloaded = Math.max(...plan.unload.map((key) => c.released.get(key) ?? 0))
      for (const key of after.warm)
        if (plan.unload.length > 0)
          expect(c.released.get(key)!, at).toBeGreaterThanOrEqual(newestUnloaded)
      // The grace: nothing released less than 60 s ago, unless it is a warning.
      if (c.grace)
        for (const key of plan.unload)
          expect(c.now - (c.released.get(key) ?? c.now), at).toBeGreaterThanOrEqual(WARM_GRACE_MS)
      // Acceptance 2: within budget, unless only instances within the grace stand over it.
      if (!within(c.budget, after)) {
        expect(c.grace, at).toBe(true)
        const oldestKept = Math.min(...after.warm.map((key) => c.released.get(key) ?? c.now))
        expect(c.now - oldestKept, at).toBeLessThan(WARM_GRACE_MS)
        expect(plan.graceEndsAt, at).toBe(oldestKept + WARM_GRACE_MS)
        graceStops += 1
      }
      // No more than it must: without the last one unloaded, it was still over.
      if (plan.unload.length > 0) {
        const lessOne = new Set(plan.unload.slice(0, -1))
        expect(within(c.budget, warmOf(c, lessOne)), at).toBe(false)
        unloadedAny += 1
      }
    }
    // Not vacuous.
    expect(unloadedAny).toBeGreaterThan(300)
    expect(graceStops).toBeGreaterThan(50)
  })
})

// ---------------------------------------------------------------------------
// The Replica, over random sequences
// ---------------------------------------------------------------------------

const ROOTS = ['A', 'B', 'C', 'D', 'E', 'F']
const tree = (root: string): InstanceSpec => ({
  collection: 'issueProjection.tree',
  args: { root },
  part: 'main',
})
const ticks = async (count = 5): Promise<void> => {
  for (let i = 0; i < count; i += 1) await new Promise((resolve) => setTimeout(resolve, 0))
}

async function device(warmInstances: number) {
  const server = new CollectionServer()
  for (const root of ROOTS) {
    server.put(ISSUE, root, issue(root, { stage: 'done', closedReason: 'completed' }))
    for (let n = 1; n <= 3; n += 1)
      server.put(
        ISSUE,
        `${root}${n}`,
        issue(`${root}${n}`, { stage: 'done', closedReason: 'completed', parentId: root }),
      )
  }
  const storage = await inMemoryInstantiation.open()
  const { cache } = storage.viewFor('u-ada')
  const clock = { now: WORLD_NOW }
  const signals = manualMemorySignals()
  const unloads: string[] = []
  const replica = new Replica({
    store: cache,
    authority: server,
    now: () => clock.now,
    memory: { signals, warmInstances },
    onEvent: (event) => {
      if (event.type === 'unloaded') unloads.push(event.entityId)
    },
  })
  replica.connect()
  await replica.settled()
  await ticks()
  await replica.settled()
  const policy = new Set(
    WORLD_POLICY.steps.flatMap((step) =>
      step.collections.map((id) =>
        instanceKey({ collection: id, part: id === 'issueProjection.stubs' ? 'stub' : 'main' }),
      ),
    ),
  )
  return { server, cache, replica, clock, signals, unloads, policy }
}

describe('the warm set in the Replica, over random open, close, time and signal sequences', () => {
  it('never unloads a held instance; after an idle tick past the grace the warm set is within budget', async () => {
    let checkedIdle = 0
    let unloadedSomething = 0
    for (let seed = 1; seed <= 40; seed += 1) {
      const next = random(seed)
      const budget = Math.floor(next() * 4)
      const d = await device(budget)
      const open = new Map<string, () => void>()
      const releasedAt = new Map<string, number>()
      const at = (step: number) => `seed ${seed} budget ${budget} step ${step}`
      const heldIntact = (step: number) => {
        for (const root of open.keys()) {
          expect(d.replica.isComplete(tree(root)), `${at(step)} ${root} held`).toBeDefined()
          for (const id of [root, `${root}1`, `${root}2`, `${root}3`]) {
            const row = d.cache.read(ISSUE, id)
            expect(row === undefined ? 'absent' : (row.part ?? 'main'), `${at(step)} ${id}`).toBe(
              'main',
            )
          }
        }
      }
      const warm = () =>
        [...d.cache.readDiskIndex().memoryInstances()].filter(
          (key) =>
            !d.policy.has(key) && ![...open.keys()].some((root) => instanceKey(tree(root)) === key),
        )
      for (let step = 0; step < 25; step += 1) {
        const roll = next()
        const root = ROOTS[Math.floor(next() * ROOTS.length)] as string
        const unloadsBefore = d.unloads.length
        const shrinksBefore = d.replica.stats().shrinks
        if (roll < 0.35) {
          if (!open.has(root)) {
            open.set(root, d.replica.hold(tree(root)))
            await d.replica.load([tree(root)])
            await d.replica.settled()
          }
          // Opening, a fetch and its install: never a reason to unload.
          expect(d.unloads.length, `${at(step)} unloaded while opening`).toBe(unloadsBefore)
        } else if (roll < 0.6) {
          const release = open.get(root)
          if (release !== undefined) {
            open.delete(root)
            release()
            releasedAt.set(instanceKey(tree(root)), d.clock.now)
            await d.replica.settled()
          }
          expect(d.unloads.length, `${at(step)} unloaded on release`).toBe(unloadsBefore)
        } else if (roll < 0.75) {
          d.clock.now += Math.floor(next() * 2 * WARM_GRACE_MS)
        } else if (roll < 0.88) {
          if (d.signals.idle() === 0) await d.replica.shrinkMemory('idle')
          await d.replica.settled()
          // Acceptance 2: within budget, unless what stands over it is within the grace.
          const left = warm()
          if (left.length > budget) {
            const oldest = Math.min(...left.map((key) => releasedAt.get(key) ?? d.clock.now))
            expect(d.clock.now - oldest, `${at(step)} over budget past the grace`).toBeLessThan(
              WARM_GRACE_MS,
            )
          }
          checkedIdle += 1
        } else if (roll < 0.94) {
          d.signals.background()
          await d.replica.settled()
        } else {
          d.signals.memoryWarning()
          await d.replica.settled()
          // A warning overrides the grace: within budget.
          expect(warm().length, `${at(step)} after a warning`).toBeLessThanOrEqual(budget)
        }
        // Acceptance 1, after every step.
        heldIntact(step)
        if (d.replica.stats().shrinks > shrinksBefore) unloadedSomething += 1
      }
      for (const release of open.values()) release()
      d.replica.disconnect()
    }
    expect(checkedIdle).toBeGreaterThan(50)
    // Coverage, not the property: the sequences do make memory unload (10 of
    // the 40 seeds' signal steps did in the first run), so the checks above
    // ran against real unloads.
    expect(unloadedSomething).toBeGreaterThanOrEqual(8)
  })

  it('without an idle tick, a background or a warning, nothing is unloaded, far over budget', async () => {
    const d = await device(0)
    for (const root of ROOTS) {
      const release = d.replica.hold(tree(root))
      await d.replica.load([tree(root)])
      await d.replica.settled()
      release()
      await d.replica.settled()
    }
    d.clock.now += 10 * WARM_GRACE_MS
    await ticks(20)
    await d.replica.settled()
    expect(d.unloads).toEqual([])
    for (const root of ROOTS) expect(d.replica.isComplete(tree(root)), root).toBeDefined()
    // Memory asked for an idle moment; given one, it shrinks.
    expect(d.signals.pendingIdle).toBe(1)
    d.signals.idle()
    await d.replica.settled()
    for (const root of ROOTS) expect(d.replica.isComplete(tree(root)), root).toBeUndefined()
    d.replica.disconnect()
  })

  it('a closed assembly stops listening: no signal unloads anything after stopMemory', async () => {
    const d = await device(0)
    for (const root of ROOTS) {
      const release = d.replica.hold(tree(root))
      await d.replica.load([tree(root)])
      await d.replica.settled()
      release()
      await d.replica.settled()
    }
    d.clock.now += 10 * WARM_GRACE_MS
    expect(d.signals.pendingIdle).toBe(1)
    d.replica.stopMemory()
    expect(d.signals.pendingIdle, 'the idle moment asked for is cancelled').toBe(0)
    d.signals.background()
    d.signals.memoryWarning()
    await d.replica.settled()
    expect(d.unloads).toEqual([])
    d.replica.disconnect()
  })
})

describe('the browser tells memory when it may shrink', () => {
  const page = () => {
    const listeners = new Set<() => void>()
    return {
      visibilityState: 'visible',
      addEventListener: (_: 'visibilitychange', listener: () => void) => listeners.add(listener),
      removeEventListener: (_: 'visibilitychange', listener: () => void) =>
        listeners.delete(listener),
      change(state: 'visible' | 'hidden') {
        this.visibilityState = state
        for (const listener of [...listeners]) listener()
      },
      get listening() {
        return listeners.size
      },
    }
  }

  it('an idle moment is requestIdleCallback, and its cancel cancels it', () => {
    const asked = new Map<number, () => void>()
    let id = 0
    const signals = browserMemorySignals({
      requestIdleCallback: (run) => {
        id += 1
        asked.set(id, run)
        return id
      },
      cancelIdleCallback: (cancelled) => asked.delete(cancelled),
    })
    let ran = 0
    signals.requestIdle(() => {
      ran += 1
    })
    const cancel = signals.requestIdle(() => {
      ran += 10
    })
    cancel()
    for (const run of asked.values()) run()
    expect(ran).toBe(1)
  })

  it('without requestIdleCallback (Safari), a quiet moment after a timer', () => {
    vi.useFakeTimers()
    try {
      const signals = browserMemorySignals({})
      let ran = 0
      signals.requestIdle(() => {
        ran += 1
      })
      vi.advanceTimersByTime(IDLE_FALLBACK_MS - 1)
      expect(ran).toBe(0)
      vi.advanceTimersByTime(1)
      expect(ran).toBe(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('the page going hidden is the background; becoming visible is nothing; unsubscribe stops it', () => {
    const document = page()
    const signals = browserMemorySignals({ document })
    const heard: string[] = []
    const stop = signals.subscribe((reason) => heard.push(reason))
    document.change('hidden')
    document.change('visible')
    expect(heard).toEqual(['background'])
    stop()
    expect(document.listening).toBe(0)
    document.change('hidden')
    expect(heard).toEqual(['background'])
  })
})
