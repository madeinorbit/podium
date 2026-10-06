import { autorun } from 'mobx'
import { expect, it, vi } from 'vitest'
import { issueBoardStats } from '../../../tests/worklist/harness/src/perf/issue-board'
import { ISSUE_BOARD_SUMMARIES } from './issue-board-schema'
import { createIssueBoardSource } from './issue-board-source'
import { MobxPool } from './pool'
import { LOADING } from './worklist/rollup'

const old = '2026-01-01T00:00:00Z'
const row = (id: string, patch: object = {}) => ({ id, seq: 1, title: id,
  stage: 'in_progress', priority: 2, type: 'task', audience: 'human',
  repoPath: '/explorer', labels: [], deps: [], createdAt: old, updatedAt: old,
  ...patch })
function fixture(values: ReturnType<typeof row>[]) {
  const load = vi.fn()
  const pool = new MobxPool({ selectedIssueId: null, coarseNow: Date.parse(old) }, undefined, {
    summaries: ISSUE_BOARD_SUMMARIES, load, schedule: () => () => {},
  })
  const publish = (value: ReturnType<typeof row>) => pool.apply({ type: 'update',
    rows: [{ kind: 'issue', id: value.id, value }] })
  pool.apply({ type: 'replace', rows: values.map(value => ({ kind: 'issue', id: value.id, value })) })
  const source = createIssueBoardSource(pool)
  return { pool, source, load, publish, dispose() { source.dispose(); pool.dispose() } }
}

it('publishes full recency order without materializing offscreen cards at 1x/4x', () => {
  for (const scale of [1, 4]) {
    const f = fixture(Array.from({ length: 128 * scale }, (_, n) => row(`task-${String(n).padStart(4, '0')}`)))
    let value: ReturnType<typeof f.source.explorer>
    issueBoardStats.enable()
    issueBoardStats.reset()
    const stop = autorun(() => { value = f.source.explorer({ tab: 'in_progress', query: '', windowed: true }) })
    try {
      if (!value || value === LOADING) throw new Error('Explorer is loading')
      expect(value.ids).toHaveLength(128 * scale)
      expect(value.ids[0]).toBe('task-0000')
      expect(value.rows).toEqual([])
      expect(value.byId.size).toBe(0)
      expect(value.rowSessions.size).toBe(0)
      expect(issueBoardStats.read().rowModels ?? 0).toBe(0)
      const before = value.ids
      f.publish(row('task-0001', { title: 'Renamed without changing order' }))
      expect(value.ids).toBe(before)
      f.publish(row('task-0001', { updatedAt: '2026-02-01T00:00:00Z' }))
      expect(value.ids[0]).toBe('task-0001')
      // Previously published snapshots keep their original order.
      expect(before[0]).toBe('task-0000')
      f.publish(row('task-0001', { stage: 'planning' }))
      expect(value.ids).toHaveLength(128 * scale - 1)
      expect(value.ids.includes('task-0001')).toBe(false)
      expect(value.counts.planning).toBe(1)
      expect(f.source.card({ id: value.ids[0]! })).toMatchObject({ issue: { id: 'task-0000' } })
      expect(issueBoardStats.read().rowModels).toBe(1)
      expect(f.load).not.toHaveBeenCalled()
      stop()
      expect(f.source.stats()).toMatchObject({ cached: 0, demandKeys: 0, residentRows: 0 })
    } finally { stop(); issueBoardStats.disable(); f.dispose() }
  }
})

it('keeps attention, hidden exact refs and rich diagnostic output consistent', () => {
  const f = fixture([row('ordinary'), row('asking', { needsHuman: true }),
    row('hidden', { seq: 9, archived: true, title: 'Hidden task' }),
    row('internal', { seq: 10, audience: 'agent', title: 'Internal task' })])
  const stops: (() => void)[] = []
  let needs: ReturnType<typeof f.source.explorer>
  try {
    stops.push(autorun(() => { needs = f.source.explorer({ tab: 'needs', query: '', windowed: true }) }))
    expect(needs).toMatchObject({ counts: { needs: 1 }, ids: ['asking'] })
    f.publish(row('asking', { needsHuman: false }))
    expect(needs).toMatchObject({ counts: { needs: 0 }, ids: [] })
    for (const [query, expected] of [['hidden', []], ['#9', ['hidden']], ['#10', ['internal']]] as const) {
      const value = f.source.explorer({ tab: 'needs', query, windowed: true })
      expect(value).toMatchObject({ ids: expected })
    }
    const diagnostic = f.source.explorer({ tab: 'in_progress', query: '' })
    expect(diagnostic).toMatchObject({ ids: ['asking', 'ordinary'],
      rows: [{ id: 'asking' }, { id: 'ordinary' }] })
  } finally { for (const stop of stops) stop(); f.dispose() }
})
