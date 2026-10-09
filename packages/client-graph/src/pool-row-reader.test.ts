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

it('merges only the declared cold summary on demand, then the hydrated row', () => {
  const row = { id: 'cold', seq: 1, repoPath: '/synthetic', createdAt: '2020-01-01T00:00:00Z',
    stage: 'done', closedAt: '2020-01-01T00:00:00Z', updatedAt: '2020-01-01T00:00:00Z',
    title: 'pending', description: 'cold payload' }
  const pool = new MobxPool({ selectedIssueId: null, coarseNow: now }, undefined,
    { load: () => row, summaries: { issue: ['title'] }, schedule: () => () => {} })
  try {
    pool.apply({ type: 'replace', rows: [{ kind: 'issue', id: row.id, value: row }] })
    expect(omitGone(pool.row('issue', row.id, 'mark'))).toBe(LOADING)
    const summary = omitGone(pool.row('issue', row.id, 'summary-fields'))
    expect(summary).toMatchObject({ title: 'pending' })
    expect(summary).not.toHaveProperty('description')
    expect(omitGone(pool.row('issue', row.id, 'summary-fields'))).toBe(summary)
    expect(pool.tables.issue.has(row.id)).toBe(false)
    expect(omitGone(pool.row('issue', row.id))).toBe(LOADING)
    expect(pool.hydrate()).toBe(1)
    expect(omitGone(pool.row('issue', row.id))).toMatchObject({ title: 'pending', description: 'cold payload' })
    expect(omitGone(pool.row('issue', row.id))).not.toBe(summary)
  } finally { pool.dispose() }
})
