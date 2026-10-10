import { expect, it, vi } from 'vitest'
import { COMMAND_SUMMARIES } from './command-launch-schema'
import { here } from './lookup'
import { MobxPool } from './pool'
import { worklistView } from './worklist/view-model'

it('selects a cold issue before its contextual payload arrives, then loads only that issue', () => {
  const stamp = '2020-01-01T00:00:00Z'
  const row = { id: 'cold-selected', seq: 1, title: 'Historical task', stage: 'done',
    audience: 'human', archived: false, createdAt: stamp, updatedAt: stamp,
    closedAt: stamp, repoPath: '/fixture', description: 'Selected contextual detail' }
  const load = vi.fn((_kind: string, id: string) => id === row.id ? row : undefined)
  const pool = new MobxPool({ selectedIssueId: null, coarseNow: Date.parse('2026-10-10') },
    undefined, { load, summaries: COMMAND_SUMMARIES, schedule: () => () => {} })
  pool.apply({ type: 'replace', rows: [{ kind: 'issue', id: row.id, value: row }] })
  const view = worklistView(pool)
  try {
    expect(pool.tables.issue.has(row.id)).toBe(false)
    expect(load).not.toHaveBeenCalled()
    expect(() => view.select(row.id)).not.toThrow()
    expect(view.selectedId).toBe(row.id)
    expect(view.selectedWasFolded).toBe(false)
    expect(load).not.toHaveBeenCalled()
    expect(pool.hydrate()).toBe(1)
    expect(load).toHaveBeenCalledExactlyOnceWith('issue', row.id)
    expect(here(pool.row('issue', row.id))).toMatchObject({ description: row.description })
    expect(view.selectedId).toBe(row.id)
  } finally { pool.dispose() }
})

it('keeps the clicked fold state for a resident issue and allows a missing selection', () => {
  const pool = new MobxPool({ selectedIssueId: null, coarseNow: Date.parse('2026-10-10') })
  const view = worklistView(pool)
  pool.apply({ type: 'replace', rows: [{ kind: 'issue', id: 'folded', value: {
    id: 'folded', seq: 1, title: 'Folded task', stage: 'done', audience: 'human',
    createdAt: '2020-01-01T00:00:00Z', updatedAt: '2020-01-01T00:00:00Z',
    closedAt: '2020-01-01T00:00:00Z', closedReason: 'completed', repoPath: '/fixture',
  } }] })
  try {
    view.select('folded')
    expect(view.selectedWasFolded).toBe(true)
    expect(() => view.select('missing')).not.toThrow()
    expect(view.selectedId).toBe('missing')
    expect(view.selectedWasFolded).toBe(false)
    view.select(null)
    expect(view.selectedId).toBeNull()
  } finally { pool.dispose() }
})
