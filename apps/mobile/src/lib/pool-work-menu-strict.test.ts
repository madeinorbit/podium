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
