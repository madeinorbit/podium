/**
 * DISK PRUNING, AS A PROPERTY (POD-7162 acceptance 1, 2, 3, 4 and 6).
 *
 * The planner over random disk indexes (random sizes, reads, members,
 * comes-with edges, pointer edges (POD-7186: parents, a session's issue),
 * holds and records in memory), run slice by slice
 * at a random slice size until it is done, against an independent model: a
 * forward mark from everything kept. The instances removed are exactly the
 * least recently read prefix that brings the disk within budget and past the
 * age limit; the records removed are exactly those nothing kept holds or comes
 * with; nothing pinned, in memory, kept or a stub is removed.
 *
 * The Replica over the collection server: an instance unread past the age
 * limit leaves on the next idle slice even under budget, a read just before
 * the limit keeps it; a prune over budget runs in several slices and only on
 * idle moments; a pruned instance read again is fetched from the server as a
 * new instance and marked again.
 */

import { describe, expect, it } from 'vitest'
import { CollectionServer, issue, WORLD_NOW, WORLD_POLICY } from '../conformance/collection-server'
import { inMemoryInstantiation } from '../conformance/in-memory'
import { instanceKey } from './cache-state'
import {
  approxBytes,
  comesWithHolderKey,
  DiskIndex,
  DiskIndexDraft,
  type RecordEntry,
} from './disk-index'
import {
  DAY_MS,
  type DiskBudget,
  type PruneFallback,
  type PrunePlan,
  planPrune,
  pruneCandidates,
} from './disk-prune'
import { manualMemorySignals, WARM_GRACE_MS } from './memory'
import { Replica } from './replica'
import type { EntityRecord, InstanceSpec, ReplicaEvent } from './types'

const ISSUE = 'issueProjection'
const SESSION = 'session'

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

const key = (entity: string, id: string): string => `${entity}\u0000${id}`
const STUB_BYTES = 40

/** A random device: its index, and what the planner is told about it. */
interface World {
  readonly index: DiskIndex
  readonly pinned: Set<string>
  readonly resident: Set<string>
  /** Records whose stub cannot be built. */
  readonly noStub: Set<string>
  /**
   * What a record points to, as its index entry says (POD-7186): an issue its
   * parent, a session its issue (any issue, a cycle now and then).
   */
  readonly points: Map<string, string[]>
  readonly stubRows: readonly string[]
  readonly now: number
  readonly budget: DiskBudget
}

function world(seed: number): World {
  const next = random(seed)
  const index = new DiskIndex()
  const now = WORLD_NOW
  const maxIdleMs = 30 * DAY_MS
  const instances: string[] = []
  for (let n = 0; n < 3 + Math.floor(next() * 12); n += 1) instances.push(`tree:${n}`)
  const rows: string[] = []
  const holders = new Map<string, string[]>()
  const stubRows: string[] = []
  const points = new Map<string, string[]>()
  const count = 10 + Math.floor(next() * 60)
  for (let n = 0; n < count; n += 1) {
    const isSession = next() < 0.3
    const row = key(isSession ? SESSION : ISSUE, `R${n}`)
    rows.push(row)
    const list: string[] = []
    for (const instance of instances) if (next() < 0.15) list.push(instance)
    // Brought by an earlier record (what it comes with), now and then by a later one (a cycle).
    if (n > 0 && next() < 0.35)
      list.push(comesWithHolderKey(rows[Math.floor(next() * n)] as string))
    // A holder whose marker is gone (an instance dropped before), as the index keeps it.
    if (next() < 0.1) list.push('gone:instance')
    holders.set(row, list)
    // Some issues point to an earlier issue as their parent.
    if (!isSession && n > 0 && next() < 0.4) {
      const up = rows[Math.floor(next() * n)] as string
      if (up.startsWith(ISSUE)) points.set(row, [up])
    }
  }
  // A session points to its issue, wherever it is in the index.
  const issues = rows.filter((row) => row.startsWith(ISSUE))
  for (const row of rows)
    if (row.startsWith(SESSION) && issues.length > 0 && next() < 0.6)
      points.set(row, [issues[Math.floor(next() * issues.length)] as string])
  for (let n = 0; n < count; n += 1) {
    if (next() < 0.1) {
      const later = rows[n + 1 + Math.floor(next() * Math.max(1, count - n - 1))]
      if (later !== undefined) holders.get(rows[n] as string)?.push(comesWithHolderKey(later))
    }
  }
  const resident = new Set<string>()
  const noStub = new Set<string>()
  for (const row of rows) {
    const stub = row.startsWith(ISSUE) && next() < 0.1
    if (stub) stubRows.push(row)
    index.putRecord(row, {
      seq: 1,
      level: stub ? 'stub' : 'main',
      bytes: stub ? STUB_BYTES : 200 + Math.floor(next() * 3_000),
      holders: stub ? [] : (holders.get(row) ?? []),
      cw: [],
      pt: stub ? [] : (points.get(row) ?? []),
    })
    if (!stub && next() < 0.08) resident.add(row)
    if (!stub && row.startsWith(ISSUE) && next() < 0.03) noStub.add(row)
  }
  const pinned = new Set<string>()
  const inMemory: string[] = []
  for (const instance of instances) {
    // Read between 60 days ago and now: some past the age limit.
    const at = now - Math.floor(next() * 60 * DAY_MS)
    index.putInstance(instance, { lastReadAt: at, stale: next() < 0.1, indexed: true })
    const roll = next()
    if (roll < 0.12) pinned.add(instance)
    else if (roll < 0.22) inMemory.push(instance)
  }
  index.setInMemory(inMemory, true)
  const budget = { bytes: Math.floor(next() * index.bytes * 1.1), maxIdleMs }
  return { index, pinned, resident, noStub, points, stubRows, now, budget }
}

const fallbackIn =
  (w: World) =>
  (row: string): PruneFallback =>
    w.noStub.has(row) ? 'keep' : row.startsWith(ISSUE) ? STUB_BYTES : 'gone'

/** Apply a slice's plan to the index, as a store's transaction would. */
function commit(index: DiskIndex, plan: PrunePlan): void {
  const draft = new DiskIndexDraft(index)
  for (const row of plan.stub) {
    const { entity, entityId } = splitKey(row)
    const stub: EntityRecord = {
      entity,
      entityId,
      value: {},
      provenance: { seq: 1 },
      part: 'stub',
      asOf: 1,
    }
    draft.row(row, stub, undefined, STUB_BYTES)
  }
  for (const row of plan.remove) draft.row(row, null)
  for (const instance of plan.drop) draft.drop(instance)
  if (plan.pruning !== undefined) draft.pruning(plan.pruning.key, plan.pruning.kept)
  index.publish(draft)
}

function splitKey(row: string): { entity: string; entityId: string } {
  const at = row.indexOf('\u0000')
  return { entity: row.slice(0, at), entityId: row.slice(at + 1) }
}

/**
 * THE MODEL: with `dropped` gone, what is kept is everything reachable from a
 * live instance's members, a record in memory or one with no stub to fall to,
 * through what each kept record brings and what it points to. What
 * leaves is what the dropped instances reach, through records not kept, that
 * is not kept itself.
 */
function model(
  w: World,
  entries: ReadonlyMap<string, RecordEntry>,
  dropped: ReadonlySet<string>,
): { kept: Set<string>; pruned: Set<string>; bytes: number } {
  const instances = new Set([...w.index.instanceKeys()].filter((key) => !dropped.has(key)))
  const main = (row: string) => entries.get(row)?.level === 'main'
  const brings = new Map<string, string[]>()
  for (const [row, entry] of entries)
    for (const holder of entry.holders)
      if (holder.startsWith('^')) {
        const from = holder.slice(1)
        brings.set(from, [...(brings.get(from) ?? []), row])
      }
  const edges = (row: string): string[] => [
    ...(brings.get(row) ?? []),
    ...(w.points.get(row) ?? []),
  ]
  const kept = new Set<string>()
  const work: string[] = []
  const keep = (row: string) => {
    if (!main(row) || kept.has(row)) return
    kept.add(row)
    work.push(row)
  }
  for (const [row, entry] of entries) {
    if (!main(row)) continue
    if (w.resident.has(row) || w.noStub.has(row)) keep(row)
    for (const holder of entry.holders) if (instances.has(holder)) keep(row)
  }
  while (work.length > 0) for (const to of edges(work.pop() as string)) keep(to)
  const pruned = new Set<string>()
  const seen = new Set<string>()
  const walk: string[] = []
  for (const instance of dropped)
    for (const [row, entry] of entries) if (entry.holders.includes(instance)) walk.push(row)
  while (walk.length > 0) {
    const row = walk.pop() as string
    if (seen.has(row)) continue
    seen.add(row)
    if (!main(row) || kept.has(row)) continue
    pruned.add(row)
    walk.push(...edges(row))
  }
  let bytes = 0
  for (const [row, entry] of entries)
    bytes += pruned.has(row) ? (row.startsWith(ISSUE) ? STUB_BYTES : 0) : entry.bytes
  return { kept, pruned, bytes }
}

/**
 * Run slices until the planner says done. A slice stops at the first member
 * boundary past `maxRows`; an instance it did not finish is the next one's
 * first, and no other instance starts meanwhile.
 */
function prune(w: World, maxRows: number): { drops: string[]; slices: number } {
  const drops: string[] = []
  let unfinished: string | undefined
  for (let slice = 1; slice <= 10_000; slice += 1) {
    const plan = planPrune({
      index: w.index,
      pinned: w.pinned,
      resident: (row) => w.resident.has(row),
      fallback: fallbackIn(w),
      now: w.now,
      budget: w.budget,
      maxRows,
    })
    if (unfinished !== undefined) expect(plan.drop[0] ?? plan.pruning?.key).toBe(unfinished)
    if (plan.pruning !== undefined) expect(plan.done).toBe(false)
    commit(w.index, plan)
    drops.push(...plan.drop)
    unfinished = plan.pruning?.key
    if (plan.done) return { drops, slices: slice }
  }
  throw new Error('the prune did not finish')
}

describe('the disk planner, over random disk indexes (POD-7162)', () => {
  it('removes exactly the least recently read instances it must, and exactly what nothing kept holds', () => {
    let overBudget = 0
    let aged = 0
    let sliced = 0
    for (let seed = 1; seed <= 300; seed += 1) {
      const w = world(seed)
      const next = random(seed * 7919)
      const entries = new Map(w.index.records())
      const candidates = pruneCandidates(w.index, w.pinned)
      const maxRows = 1 + Math.floor(next() * 12)
      if (w.index.bytes > w.budget.bytes) overBudget += 1
      if (candidates.some((c) => w.now - c.at > w.budget.maxIdleMs)) aged += 1
      // The model's answer: the shortest prefix past every aged instance that fits the budget.
      const mustAge = candidates.filter((c) => w.now - c.at > w.budget.maxIdleMs).length
      let expected = candidates.length
      for (let k = mustAge; k <= candidates.length; k += 1) {
        const dropped = new Set(candidates.slice(0, k).map((c) => c.key))
        if (model(w, entries, dropped).bytes <= w.budget.bytes) {
          expected = k
          break
        }
      }
      const droppedModel = new Set(candidates.slice(0, expected).map((c) => c.key))
      const { kept, pruned } = model(w, entries, droppedModel)
      const { drops, slices } = prune(w, maxRows)
      if (slices > 1) sliced += 1
      const label = `seed ${seed}`
      expect(drops, `${label}: the least recently read first`).toEqual(
        candidates.slice(0, expected).map((c) => c.key),
      )
      const fits = model(w, entries, droppedModel).bytes <= w.budget.bytes
      if (fits) expect(w.index.bytes, `${label}: within budget`).toBeLessThanOrEqual(w.budget.bytes)
      for (const [row, entry] of entries) {
        if (entry.level === 'stub') {
          expect(w.index.record(row)?.level, `${label}: stub ${row} stays`).toBe('stub')
          continue
        }
        const now = w.index.record(row)
        if (pruned.has(row))
          expect(now?.level ?? 'gone', `${label}: ${row} leaves`).toBe(
            row.startsWith(ISSUE) ? 'stub' : 'gone',
          )
        else expect(now?.level, `${label}: ${row} stays whole`).toBe('main')
        if (kept.has(row)) expect(now?.level, `${label}: kept ${row}`).toBe('main')
        if (w.resident.has(row)) expect(now?.level, `${label}: in memory ${row}`).toBe('main')
      }
      for (const instance of [...w.pinned, ...w.index.memoryInstances()])
        expect(w.index.instance(instance), `${label}: ${instance} never removed`).toBeDefined()
      // A kept record's comes-with and what it points to are whole too.
      for (const row of kept) {
        for (const [other, entry] of entries)
          if (entry.holders.includes(comesWithHolderKey(row)) && entry.level === 'main')
            expect(w.index.record(other)?.level, `${label}: ${row} brings ${other}`).toBe('main')
        for (const to of w.points.get(row) ?? [])
          if (entries.get(to)?.level === 'main')
            expect(w.index.record(to)?.level, `${label}: ${row} points to ${to}`).toBe('main')
      }
    }
    // The cases reach what they claim to.
    expect(overBudget).toBeGreaterThan(100)
    expect(aged).toBeGreaterThan(100)
    expect(sliced).toBeGreaterThan(50)
  })

  it('within budget with nothing past its age, removes nothing', () => {
    const w = world(11)
    const budget = { bytes: w.index.bytes, maxIdleMs: 365 * DAY_MS }
    const plan = planPrune({
      index: w.index,
      pinned: w.pinned,
      resident: () => false,
      fallback: () => 'gone',
      now: w.now,
      budget,
    })
    expect(plan).toMatchObject({ drop: [], stub: [], remove: [], done: true, stuck: false })
  })

  it('stops a slice at its time limit, after its first member, and finishes the instance first next time', () => {
    const index = new DiskIndex()
    for (const id of ['A', 'B', 'C'])
      index.putRecord(key(SESSION, id), {
        seq: 1,
        level: 'main',
        bytes: 1_000,
        holders: ['tree:1'],
        cw: [],
        pt: [],
      })
    index.putInstance('tree:1', { lastReadAt: 0, stale: false, indexed: true })
    const input = {
      index,
      pinned: new Set<string>(),
      resident: () => false,
      fallback: (): PruneFallback => 'gone',
      now: WORLD_NOW,
      budget: { bytes: 0, maxIdleMs: DAY_MS },
      overTime: () => true,
    }
    const first = planPrune(input)
    expect(first).toMatchObject({ drop: [], pruning: { key: 'tree:1', kept: [] }, done: false })
    expect(first.remove).toHaveLength(1)
    commit(index, first)
    // Being pruned: a disk load cannot answer it, and it is finished first.
    expect(index.instance('tree:1')?.indexed).toBe(false)
    expect(index.membersOf('tree:1').size).toBe(2)
    const second = planPrune(input)
    expect(second).toMatchObject({ drop: [], pruning: { key: 'tree:1', kept: [] }, done: false })
    expect(second.remove).toHaveLength(1)
    commit(index, second)
    const third = planPrune(input)
    expect(third.remove).toHaveLength(1)
    expect(third).toMatchObject({ drop: ['tree:1'], done: true, stuck: false })
    commit(index, third)
    expect(index.instance('tree:1')).toBeUndefined()
    expect(index.bytes).toBe(0)
  })
})

// ─── The Replica ─────────────────────────────────────────────────────────────

const tree = (root: string): InstanceSpec => ({
  collection: 'issueProjection.tree',
  args: { root },
  part: 'main',
})
const ROOTS = ['T', 'U', 'V', 'W', 'X', 'Y']

const ticks = async (count = 5): Promise<void> => {
  for (let i = 0; i < count; i += 1) await new Promise((resolve) => setTimeout(resolve, 0))
}

async function device(options: { diskBytes?: number; pruneSliceRows?: number } = {}) {
  const server = new CollectionServer()
  server.policy = WORLD_POLICY
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
  const events: ReplicaEvent[] = []
  const replica = new Replica({
    store: cache,
    authority: server,
    now: () => clock.now,
    memory: { signals, warmInstances: 0, ...options },
    onEvent: (event) => events.push(event),
  })
  replica.connect()
  await replica.settled()
  await ticks()
  await replica.settled()
  /** Open a tree, read it, leave it at `at`, and let memory unload it (on the device still). */
  const visit = async (root: string, at: number) => {
    clock.now = at
    const release = replica.hold(tree(root))
    await replica.load([tree(root)])
    await replica.settled()
    release()
    await replica.settled()
    await replica.unload(instanceKey(tree(root)))
  }
  const onDisk = (root: string) => cache.readInstances().has(instanceKey(tree(root)))
  const whole = (id: string) => cache.readDiskIndex().record(key(ISSUE, id))?.level === 'main'
  const idle = async () => {
    signals.idle()
    await replica.settled()
    await ticks()
    await replica.settled()
  }
  return { server, cache, replica, clock, signals, events, visit, onDisk, whole, idle }
}

describe('disk pruning in the Replica (POD-7162)', () => {
  const maxIdle = WORLD_POLICY.diskMaxIdleDays * DAY_MS

  it('an instance unread past the age limit leaves on the next idle slice, under budget; a read just before keeps it', async () => {
    const d = await device()
    expect(d.cache.readDiskIndex().bytes).toBeLessThan(WORLD_POLICY.diskBudgetMb * 1024 * 1024)
    await d.visit('T', WORLD_NOW)
    await d.visit('U', WORLD_NOW)
    // U is read again just before the limit; T is not.
    await d.visit('U', WORLD_NOW + maxIdle - 1)
    d.clock.now = WORLD_NOW + maxIdle + 1
    // Time alone prunes nothing: only an idle moment does.
    await ticks()
    expect(d.onDisk('T')).toBe(true)
    d.replica.hold(tree('V'))()
    await d.idle()
    expect(d.onDisk('T'), 'unread past the limit').toBe(false)
    for (const id of ['T1', 'T2', 'T3']) {
      expect(d.whole(id), id).toBe(false)
      expect(d.replica.stubOf(ISSUE, id), `${id} keeps its stub`).toBeDefined()
    }
    expect(d.onDisk('U'), 'read just before the limit').toBe(true)
    for (const id of ['U', 'U1', 'U2', 'U3']) expect(d.whole(id), id).toBe(true)
    expect(d.replica.stats().prunes).toBeGreaterThan(0)
    // The pool sees the device let the rows go: never REMOVED.
    expect(d.events.some((e) => e.type === 'released' && e.entityId === 'T1')).toBe(true)
    expect(d.events.some((e) => e.type === 'removed' || e.type === 'evicted')).toBe(false)
    expect(d.replica.exitKind(ISSUE, 'T1')).toBeUndefined()
    expect(d.replica.isUnloaded(ISSUE, 'T1')).toBe(false)
  })

  it('over budget: idle slices remove the least recently read instances until the disk is within it', async () => {
    const d = await device({ pruneSliceRows: 2 })
    for (const [n, root] of ROOTS.entries()) await d.visit(root, WORLD_NOW + n * 1000)
    const index = d.cache.readDiskIndex()
    // What a tree frees when its issues fall to their stubs.
    const frees = (root: string) =>
      [root, `${root}1`, `${root}2`, `${root}3`].reduce((sum, id) => {
        expect(d.whole(id), id).toBe(true)
        const bytes = index.record(key(ISSUE, id))?.bytes ?? 0
        return sum + bytes - approxBytes({ value: d.replica.stubOf(ISSUE, id) })
      }, 0)
    // A budget the oldest three trees must leave for, and the fourth need not.
    const budget = index.bytes - frees('T') - frees('U') - frees('V') + Math.floor(frees('W') / 2)
    const e = await device({ diskBytes: budget, pruneSliceRows: 2 })
    for (const [n, root] of ROOTS.entries()) await e.visit(root, WORLD_NOW + n * 1000)
    // Leaving memory never prunes: only idle moments do.
    expect(e.replica.stats().prunes).toBe(0)
    let slices = 0
    for (let i = 0; i < 50 && e.cache.readDiskIndex().bytes > budget; i += 1) {
      await e.idle()
      slices += 1
    }
    expect(e.cache.readDiskIndex().bytes).toBeLessThanOrEqual(budget)
    expect(slices, 'several slices').toBeGreaterThan(1)
    for (const root of ['T', 'U', 'V']) expect(e.onDisk(root), root).toBe(false)
    for (const root of ['W', 'X', 'Y']) expect(e.onDisk(root), root).toBe(true)
    // The policy's collections stay.
    for (const instance of WORLD_POLICY.steps.flatMap((step) => step.collections))
      expect(
        [...e.cache.readInstances().values()].some((marker) => marker.collection === instance),
        instance,
      ).toBe(true)
  })

  it('never prunes an instance a view holds, or one in memory, far over budget', async () => {
    const d = await device({ diskBytes: 1 })
    d.replica.hold(tree('T'))
    await d.replica.load([tree('T')])
    await d.replica.settled()
    d.clock.now = WORLD_NOW + 10 * maxIdle + WARM_GRACE_MS
    await d.idle()
    expect(d.onDisk('T')).toBe(true)
    expect(d.replica.isComplete(tree('T'))).toBeDefined()
    for (const id of ['T', 'T1', 'T2', 'T3']) expect(d.whole(id), id).toBe(true)
  })

  it('a pruned instance read again is fetched from the server as a new instance and marked again', async () => {
    const d = await device()
    await d.visit('T', WORLD_NOW)
    d.clock.now = WORLD_NOW + maxIdle + 1
    d.replica.hold(tree('V'))()
    await d.idle()
    expect(d.onDisk('T')).toBe(false)
    const fetched = d.server.fetches.length
    const release = d.replica.hold(tree('T'))
    await d.replica.load([tree('T')])
    await d.replica.settled()
    // Asked of the server first (what its records come with follows), never read from disk.
    expect(
      d.server.fetches
        .slice(fetched)[0]
        ?.some((request) => instanceKey(request) === instanceKey(tree('T'))),
    ).toBe(true)
    expect(d.onDisk('T'), 'its marker is written again').toBe(true)
    expect(d.replica.isComplete(tree('T'))).toBeDefined()
    for (const id of ['T', 'T1', 'T2', 'T3']) expect(d.whole(id), id).toBe(true)
    // Read now: its last-read time is now, so the age rule keeps it.
    expect(d.cache.readDiskIndex().instance(instanceKey(tree('T')))?.lastReadAt).toBe(d.clock.now)
    release()
  })
})
