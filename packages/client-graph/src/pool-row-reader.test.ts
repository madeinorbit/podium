import { omitGone } from './lookup'
import { types } from 'node:util'
import { expect, it } from 'vitest'
import { MobxPool } from './pool'
import { LOADING } from './worklist/rollup'

const now = Date.parse('2026-10-03T12:00:00Z')

// POD-5432: the one reader lays nothing over a row. Pending changes arrive as
// rows (the transaction log rebases a row and the feed applies it), so the
// reader hands out the table's own object: no Proxy, no per-read pending
// lookup, the same identity on every read until a new row is applied.
it('serves the applied row object itself, the same on every read', () => {
  const pool = new MobxPool({ selectedIssueId: null, coarseNow: now })
  const row = { id: 'issue', seq: 1, repoPath: '/synthetic', createdAt: new Date(now).toISOString(),
    stage: 'in_progress', title: 'server', updatedAt: new Date(now).toISOString() }
  try {
    pool.apply({ type: 'replace', rows: [{ kind: 'issue', id: row.id, value: row }] })
    expect(omitGone(pool.row('issue', row.id))).toBe(row)
    expect(omitGone(pool.row('issue', row.id))).toBe(row)
    expect(types.isProxy(omitGone(pool.row('issue', row.id)))).toBe(false)
    // A pending title, as the log paints it: a new visible row through the feed.
    const painted = { ...row, title: 'pending' }
    pool.apply({ type: 'update', rows: [{ kind: 'issue', id: row.id, value: painted }] })
    expect(omitGone(pool.row('issue', row.id))).toBe(painted)
    expect(omitGone(pool.row('issue', row.id))).toBe(painted)
    // Its rollback: the server row again.
    pool.apply({ type: 'update', rows: [{ kind: 'issue', id: row.id, value: row }] })
    expect(omitGone(pool.row('issue', row.id))).toBe(row)
  } finally { pool.dispose() }
})

