import { types } from 'node:util'
import { runInAction } from 'mobx'
import { expect, it } from 'vitest'
import { MobxPool } from './pool'
import { PendingOverlay } from './write/overlay'
import { LOADING } from './worklist/rollup'

const now = Date.parse('2026-10-03T12:00:00Z')

it('reuses pending reads and invalidates both row and pending identities', () => {
  const pending = new PendingOverlay()
  const pool = new MobxPool({ selectedIssueId: null, coarseNow: now }, undefined, undefined, pending)
  const row = { id: 'issue', seq: 1, repoPath: '/synthetic', createdAt: new Date(now).toISOString(),
    stage: 'in_progress', title: 'server', updatedAt: new Date(now).toISOString() }
  try {
    pool.apply({ type: 'replace', rows: [{ kind: 'issue', id: row.id, value: row }] })
    expect(pool.row('issue', row.id)).toBe(row)
    runInAction(() => pending.set(row.id, { title: 'first' }))
    const first = pool.row('issue', row.id)
    expect(pool.row('issue', row.id)).toBe(first)
    expect(types.isProxy(first)).toBe(false)
    expect(Object.isFrozen(first)).toBe(true)
    runInAction(() => pending.set(row.id, { title: 'second' }))
    const second = pool.row('issue', row.id)
    expect(second).not.toBe(first)
    expect(second).toMatchObject({ title: 'second' })
    const next = { ...row, stage: 'review' }
    pool.apply({ type: 'update', rows: [{ kind: 'issue', id: row.id, value: next }] })
    expect(pool.row('issue', row.id)).not.toBe(second)
    expect(pool.row('issue', row.id)).toMatchObject({ title: 'second', stage: 'review' })
    expect(first).toMatchObject({ title: 'first', stage: 'in_progress' })
    runInAction(() => pending.delete(row.id))
    expect(pool.row('issue', row.id)).toBe(next)
  } finally { pool.dispose() }
})

it('merges only the declared cold summary on demand, then the hydrated row', () => {
  const pending = new PendingOverlay()
  const row = { id: 'cold', seq: 1, repoPath: '/synthetic', createdAt: '2020-01-01T00:00:00Z',
    stage: 'done', closedAt: '2020-01-01T00:00:00Z', updatedAt: '2020-01-01T00:00:00Z',
    title: 'server', description: 'cold payload' }
  const pool = new MobxPool({ selectedIssueId: null, coarseNow: now }, undefined,
    { load: () => row, schedule: () => () => {} }, pending)
  try {
    pool.apply({ type: 'replace', rows: [{ kind: 'issue', id: row.id, value: row }] })
    runInAction(() => pending.set(row.id, { title: 'pending' }))
    expect(pool.row('issue', row.id, 'mark')).toBe(LOADING)
    const summary = pool.row('issue', row.id, 'summary-fields')
    expect(summary).toMatchObject({ title: 'pending' })
    expect(summary).not.toHaveProperty('description')
    expect(Object.isFrozen(summary)).toBe(true)
    expect(pool.row('issue', row.id, 'summary-fields')).toBe(summary)
    expect(pool.tables.issue.has(row.id)).toBe(false)
    expect(pool.row('issue', row.id)).toBe(LOADING)
    expect(pool.hydrate()).toBe(1)
    expect(pool.row('issue', row.id)).toMatchObject({ title: 'pending', description: 'cold payload' })
    expect(pool.row('issue', row.id)).not.toBe(summary)
  } finally { pool.dispose() }
})
