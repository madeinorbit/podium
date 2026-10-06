import { MobxPool } from '@podium/client-graph/pool'
import { configureDevelopmentChecks } from '@podium/mobx-helpers'
import { configure } from 'mobx'
import { expect, it, vi } from 'vitest'
import { resolvePoolWorkMenu } from './pool-work-menu'

it('acquires an addressed phone menu as an imperative action under development checks', () => {
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
  configureDevelopmentChecks(true)
  const stamp = '2026-10-05T00:00:00Z'
  const pool = new MobxPool({ selectedIssueId: null, coarseNow: Date.parse(stamp) })
  try {
    pool.apply({ type: 'replace', rows: [{ kind: 'issue', id: 'selected', value: {
      id: 'selected', title: 'Selected', seq: 1, stage: 'in_progress', repoPath: '/synthetic',
      createdAt: stamp, updatedAt: stamp,
    } }] })
    expect(resolvePoolWorkMenu(pool, 'selected')).toMatchObject({
      target: { issue: { id: 'selected', title: 'Selected' }, lane: 'live', sessionCount: 0 },
      sessions: [],
    })
    expect(resolvePoolWorkMenu(pool, 'absent')).toBeNull()
    expect(warn).not.toHaveBeenCalled()
  } finally {
    pool.dispose()
    warn.mockRestore()
    configure({ enforceActions: 'never', computedRequiresReaction: false,
      reactionRequiresObservable: false, observableRequiresReaction: false })
  }
})

for (const history of [32, 128]) {
  it(`opens only menu demand with ${history} archived senders and cold children`, () => {
    const stamp = '2026-10-05T00:00:00Z'
    const pool = new MobxPool({ selectedIssueId: null, coarseNow: Date.parse(stamp) }, undefined,
      { load: vi.fn(), schedule: () => () => {} })
    const issue = (id: string, patch: object = {}) => ({ id, seq: 1, title: id,
      stage: 'planning', repoPath: '/synthetic', createdAt: stamp, updatedAt: stamp, ...patch })
    try {
      pool.apply({ type: 'replace', rows: [
        { kind: 'issue', id: 'root', value: issue('root') },
        ...Array.from({ length: history }, (_, index) => ({ kind: 'session' as const,
          id: `old-${index}`, value: { sessionId: `old-${index}`, issueId: 'root',
            cwd: '/synthetic', agentKind: 'codex', status: 'exited', archived: true,
            lastActiveAt: stamp } as never })),
        { kind: 'issue', id: 'child', value: issue('child', { parentId: 'root', stage: 'done',
          archived: true, closedAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z' }) },
      ] })
      const read = vi.spyOn(pool, 'row')
      const menu = resolvePoolWorkMenu(pool, 'root')!
      expect(menu.target).toMatchObject({ issue: { id: 'root', childCount: 1, childDoneCount: 1 }, sessionCount: history })
      expect(read.mock.calls.every(([kind, id]) => kind !== 'session' && id !== 'child')).toBe(true)
      // Menu opening must not warm subtree attention or queue a cold child.
      expect(pool.tables.issue.has('child')).toBe(false)
    } finally { pool.dispose() }
  })
}
