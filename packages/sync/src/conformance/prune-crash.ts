/**
 * POD-7162 — a prune slice killed mid-transaction, for the durable adapters'
 * crash cases (IndexedDB and SQLite reopen the same physical store; the
 * collection conformance suite covers all three adapters by discarding the
 * kernels instead).
 *
 * Three trees on the device, out of memory, each with four issues, and a
 * session the first tree's second issue brings. A slice cut after two rows
 * drops nothing whole and marks the oldest tree as being pruned. Killed at
 * any of its writes, the store reopens on the rows and index of before;
 * completed, on those of after; in both, every index entry has its row at
 * its feed number and level, and nothing else does.
 */

import { expect } from 'vitest'
import { instanceKey } from '../replica/cache-state'
import { approxBytes, rowKeyOf, splitRowKey } from '../replica/disk-index'
import { DAY_MS, type PrunePlan, planPrune, pruneMutation } from '../replica/disk-prune'
import type { CacheOperation, InstanceOperation, ReplicaCacheStore } from '../replica/ports'
import { type Cursor, rowAsOf } from '../replica/types'
import { policyBudgets } from './test-budgets'

const ISSUE = 'issueProjection'
const SESSION = 'session'
const ROOTS = ['A', 'B', 'C']
const CURSOR: Cursor = { feedId: 'feed', epoch: 'e1', seq: 1 }

const treeKey = (root: string): string =>
  instanceKey({ collection: 'issueProjection.tree', args: { root: `${root}0` }, part: 'main' })
const issueIds = (root: string): string[] => [0, 1, 2, 3].map((n) => `${root}${n}`)

/** Every record the world can hold, by row key. */
export const PRUNE_WORLD_KEYS: readonly string[] = [
  ...ROOTS.flatMap((root) => issueIds(root).map((id) => rowKeyOf(ISSUE, id))),
  rowKeyOf(SESSION, 'SA'),
]

/** Write the world: rows, the trees' markers with their members, what A1 brings, a policy. */
export function seedPruneWorld(cache: ReplicaCacheStore): void {
  const operations: CacheOperation[] = []
  const instances: InstanceOperation[] = []
  for (const [n, root] of ROOTS.entries()) {
    const members: string[] = []
    for (const [at, id] of issueIds(root).entries()) {
      operations.push({
        kind: 'upsert',
        entity: ISSUE,
        entityId: id,
        value: {
          id,
          repoId: 'repo-1',
          seq: 100 * (n + 1) + at,
          title: `Issue ${id} with a title long enough to be worth pruning`,
          stage: 'done',
          parentId: at === 0 ? null : `${root}0`,
        },
        provenance: { seq: 1 },
        asOf: 1,
      })
      members.push(rowKeyOf(ISSUE, id))
    }
    instances.push({
      kind: 'mark',
      instance: {
        key: treeKey(root),
        collection: 'issueProjection.tree',
        args: { root: `${root}0` },
        part: 'main',
        completeAt: CURSOR,
      },
      members,
      at: 1_000 * (n + 1),
    })
  }
  operations.push({
    kind: 'upsert',
    entity: SESSION,
    entityId: 'SA',
    value: { id: 'SA', issueId: 'A1', status: 'ended' },
    provenance: { seq: 1 },
    asOf: 1,
  })
  cache.applyAtomic({
    operations,
    cursor: CURSOR,
    instances,
    comesWith: [{ kind: 'held', member: rowKeyOf(SESSION, 'SA'), holder: rowKeyOf(ISSUE, 'A1') }],
    // A policy with no collections: the trees are on disk, not in memory, after a reopen.
    policy: { clientType: 'browser', steps: [], recentDays: 30, ...policyBudgets() },
  })
}

/** Plan the slice the cases kill: budget 0, cut after `maxRows` rows. */
export function planPruneSlice(cache: ReplicaCacheStore, maxRows = 2): PrunePlan {
  const index = cache.readDiskIndex()
  return planPrune({
    index,
    pinned: new Set(),
    resident: (key) => {
      const { entity, entityId } = splitRowKey(key)
      return cache.read(entity, entityId) !== undefined
    },
    pointsTo: () => [],
    pointedBy: () => [],
    fallback: (key) => {
      const { entity, entityId } = splitRowKey(key)
      if (entity !== ISSUE) return 'gone'
      const stub = cache.readStubTable(entity)?.stubOf(entityId)
      return stub === undefined ? 'keep' : approxBytes({ value: stub })
    },
    now: 10_000,
    budget: { bytes: 0, maxIdleMs: DAY_MS },
    maxRows,
  })
}

/** Commit a planned slice, as the Replica does: one transaction. */
export function commitPruneSlice(cache: ReplicaCacheStore, plan: PrunePlan): void {
  cache.applyAtomic(
    pruneMutation(plan, cache.readDiskIndex(), (entity, entityId) =>
      cache.readStubTable(entity)?.stubOf(entityId),
    ),
  )
}

/** The rows and the index of a reopened store agree: each entry has its row, and only they do. */
export async function expectPruneWorldAgrees(
  cache: ReplicaCacheStore,
  label: string,
): Promise<void> {
  const index = cache.readDiskIndex()
  const rows = await cache.readDiskRows(PRUNE_WORLD_KEYS)
  const byKey = new Map(rows.map((row) => [rowKeyOf(row.entity, row.entityId), row]))
  for (const row of rows)
    expect(
      index.record(rowKeyOf(row.entity, row.entityId)),
      `${label}: ${row.entityId} has an entry`,
    ).toBeDefined()
  for (const [key, entry] of index.records()) {
    const row = byKey.get(key)
    const { entity, entityId } = splitRowKey(key)
    if (entry.level === 'main') {
      expect(
        row?.part ?? (row === undefined ? 'absent' : 'main'),
        `${label}: ${entityId} whole on disk`,
      ).toBe('main')
      expect(
        row === undefined ? undefined : rowAsOf(row),
        `${label}: ${entityId} feed number`,
      ).toBe(entry.seq)
      continue
    }
    // POD-7170: a durable store keeps a stub-level record in its index entry, not as a row.
    expect(row === undefined || row.part === 'stub', `${label}: ${entityId} no whole row`).toBe(
      true,
    )
    if (row !== undefined) expect(rowAsOf(row), `${label}: ${entityId} feed number`).toBe(entry.seq)
    expect(
      cache.readStubTable(entity)?.stubOf(entityId),
      `${label}: ${entityId} stub`,
    ).toBeDefined()
  }
  for (const key of cache.readInstances().keys())
    for (const member of index.membersOf(key))
      expect(index.record(member)?.level, `${label}: ${key} holds ${member} whole`).toBe('main')
}

/** What the store holds, to tell before from after: each record's level, and each tree's state. */
export function pruneWorldState(cache: ReplicaCacheStore): {
  readonly levels: Readonly<Record<string, string>>
  readonly trees: Readonly<Record<string, string>>
} {
  const index = cache.readDiskIndex()
  const levels: Record<string, string> = {}
  for (const key of PRUNE_WORLD_KEYS) levels[key] = index.record(key)?.level ?? 'gone'
  const trees: Record<string, string> = {}
  for (const root of ROOTS) {
    const state = index.instance(treeKey(root))
    trees[root] =
      state === undefined
        ? 'gone'
        : `${state.indexed ? 'indexed' : 'pruning'}:${index.membersOf(treeKey(root)).size}`
  }
  return { levels, trees }
}

/** The slice's own shape: it starts the oldest tree, cuts it, and drops nothing whole. */
export function expectCutSlice(plan: PrunePlan): void {
  expect(plan.drop).toEqual([])
  expect(plan.pruning?.key).toBe(treeKey('A'))
  expect(plan.stub.length + plan.remove.length).toBeGreaterThanOrEqual(2)
}
