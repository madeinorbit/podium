import '@podium/client-graph/synced-models'
import { autorun, runInAction } from 'mobx'
import { describe, expect, it } from 'vitest'
import { MobxPool } from '../pool'
import type { RowRecord } from '../shared/source'
import { LOADING } from './rollup'
import { sidebarView } from './sidebar'

/**
 * POD-7173 — a drawn root over a flat tree does work in proportion to what a
 * burst moved, not to the tree. The operator's large deck is one root with
 * 969 children; each burst of its answer used to re-read every child's row in
 * every one of the root's progress fields (about six walks of the whole tree
 * per burst, and as many again for attention). Counted here as the pool's row
 * reads while one burst is published, at two tree sizes with the same burst.
 */
const stamp = '2026-11-18T12:00:00Z'
const longAgo = '2025-10-14T12:00:00Z'
const OPEN = 3

function rows(children: number): RowRecord[] {
  const issue = (id: string, seq: number, patch: object): RowRecord => ({
    kind: 'issue',
    id,
    value: {
      id,
      seq,
      title: id,
      audience: 'human',
      repoPath: '/synthetic/flat',
      createdAt: '2025-01-01T00:00:00Z',
      updatedAt: stamp,
      ...patch,
    } as never,
  })
  const out = [issue('flat-root', 1, { stage: 'in_progress', parentId: null })]
  for (let n = 0; n < children; n += 1) {
    const open = n < OPEN
    out.push(
      issue(`child-${n}`, n + 2, {
        parentId: 'flat-root',
        stage: open ? 'in_progress' : 'done',
        ...(open ? {} : { closedReason: 'completed', closedAt: longAgo, updatedAt: longAgo }),
      }),
    )
  }
  return out
}

/** Publish `burst` into a pool holding the tree, with the root's sidebar row drawn; count the row reads. */
function rowReads(
  children: number,
  burst: (all: RowRecord[]) => RowRecord[],
): { reads: number; total: number } {
  const all = rows(children)
  const pool = new MobxPool({ selectedIssueId: null, coarseNow: Date.parse(stamp) })
  pool.apply({ type: 'replace', rows: all })
  let total = 0
  const stop = autorun(() => {
    const row = sidebarView(pool).row('flat-root')
    if (row === undefined || row === LOADING) return
    const progress = row.progress
    total = progress === LOADING ? -1 : progress.total
    void [
      row.visibleWorking,
      row.waitingCount,
      row.visibleFleet,
      row.timing,
      row.visibleActivityAt,
      row.visibleChildIds,
      row.statusWord,
    ]
  })
  const read = pool.row.bind(pool)
  let reads = 0
  Object.defineProperty(pool, 'row', {
    configurable: true,
    value: (...args: Parameters<typeof read>) => {
      reads += 1
      return read(...args)
    },
  })
  try {
    runInAction(() => pool.apply({ type: 'update', rows: burst(all) }))
    return { reads, total }
  } finally {
    stop()
    pool.dispose()
  }
}

/** A done child's title, or its readAt, moves: nothing any roll-up reads. */
const retitle = (count: number) => (all: RowRecord[]) =>
  all.slice(1 + OPEN, 1 + OPEN + count).map((record) => ({
    ...record,
    value: { ...(record.value as object), title: 'moved' } as never,
  }))

/** Done children reopen: their progress moves. */
const reopen = (count: number) => (all: RowRecord[]) =>
  all.slice(1 + OPEN, 1 + OPEN + count).map((record) => ({
    ...record,
    value: {
      ...(record.value as object),
      stage: 'in_progress',
      closedReason: null,
      closedAt: null,
    } as never,
  }))

describe('a drawn root over a flat tree works in proportion to the burst (POD-7173)', () => {
  it('one child that moves reads as many rows under 400 children as under 100', () => {
    const small = rowReads(100, retitle(1))
    const large = rowReads(400, retitle(1))
    expect(small.total).toBe(100)
    expect(large.total).toBe(400)
    expect(large.reads).toBe(small.reads)
  })

  it('a burst of 20 children whose progress moves reads rows by the burst, not the tree', () => {
    const small = rowReads(100, reopen(20))
    const large = rowReads(400, reopen(20))
    expect(large.total).toBe(400)
    // Each moved child reads its own row a few times; the root's folds read
    // each child's cached record, never its row.
    expect(large.reads).toBe(small.reads)
  })
})
