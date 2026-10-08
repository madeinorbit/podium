import { autorun } from 'mobx'
import { expect, it, vi } from 'vitest'
import { headerView } from './header-views'
import { MobxPool } from './pool'

it('reads folded progress without the sidebar presentation and updates its formal units', () => {
  const stamp = '2026-10-01T12:00:00Z'
  const pool = new MobxPool({ selectedIssueId: 'root', coarseNow: Date.parse(stamp) })
  const root = { id: 'root', seq: 1, title: 'Mission', stage: 'in_progress', parentId: null, deps: [], archived: false,
    repoPath: '/mission', createdAt: stamp, updatedAt: stamp }
  const child = { ...root, id: 'child', seq: 2, parentId: 'root', stage: 'review' }
  const seat = { sessionId: 'seat', issueId: 'root', cwd: '/mission', title: 'Crew', agentKind: 'codex',
    status: 'live', archived: false, lastActiveAt: stamp }
  pool.apply({ type: 'replace', rows: [
    { kind: 'issue', id: 'root', value: root }, { kind: 'issue', id: 'child', value: child },
    { kind: 'session', id: 'seat', value: seat },
  ] })
  const model = pool.worklistRow('root')!
  const aggregate = vi.spyOn(model, 'aggregate', 'get')
  let folded: ReturnType<ReturnType<typeof headerView>['folded']> | undefined
  const stop = autorun(() => { folded = headerView(pool).folded() })
  try {
    expect(folded).toMatchObject({ root: { id: 'root' }, progress: { total: 1, review: 1, done: 0 }, live: 1, loading: false })
    pool.apply({ type: 'update', rows: [{ kind: 'session', id: 'seat', value: { ...seat, readAt: stamp } }] })
    expect(folded?.progress).toMatchObject({ total: 1, review: 1 })
    pool.apply({ type: 'update', rows: [{ kind: 'issue', id: 'child', value: { ...child, stage: 'done' } }] })
    expect(folded?.progress).toMatchObject({ total: 1, review: 0, done: 1 })
    expect(aggregate).not.toHaveBeenCalled()
  } finally { aggregate.mockRestore(); stop(); pool.dispose() }
})

it('keeps folded progress pending until a cold formal child is loaded', () => {
  const root = { id: 'root', seq: 1, title: 'Mission', stage: 'in_progress', parentId: null, deps: [], archived: false,
    repoPath: '/mission', createdAt: '2026-10-01T12:00:00Z', updatedAt: '2026-10-01T12:00:00Z' }
  const child = { ...root, id: 'child', seq: 2, parentId: 'root', stage: 'done',
    closedAt: '2026-09-01T12:00:00Z', updatedAt: '2026-09-01T12:00:00Z' }
  const pool = new MobxPool({ selectedIssueId: 'root', coarseNow: Date.parse('2026-10-01T12:00:00Z') }, undefined,
    { load: (kind, id) => kind === 'issue' && id === 'child' ? child : undefined, schedule: () => () => {} })
  pool.apply({ type: 'replace', rows: [
    { kind: 'issue', id: 'root', value: root }, { kind: 'issue', id: 'child', value: child },
  ] })
  let folded: ReturnType<ReturnType<typeof headerView>['folded']> | undefined
  const stop = autorun(() => { folded = headerView(pool).folded() })
  try {
    expect(pool.tables.issue.has('child')).toBe(false)
    expect(folded).toMatchObject({ loading: true, progress: { total: 0 } })
    pool.hydrate()
    expect(folded).toMatchObject({ loading: false, progress: { total: 1, done: 1 } })
  } finally { stop(); pool.dispose() }
})
