import { expect, it, vi } from 'vitest'
import { costRefresh } from './cost-refresh'
import { MobxPool } from './pool'
import type { RowRecord } from './shared/source'

it('refreshes related task and mission costs on turn end or stage change, without scans or a timer', () => {
  const pool = new MobxPool({ selectedIssueId: null, coarseNow: 0 })
  const issues = ['root', 'child', 'unrelated'].map(
    (id): RowRecord => ({
      kind: 'issue',
      id,
      value: {
        id,
        title: id,
        repoPath: '/repo',
        stage: 'in_progress',
        parentId: id === 'child' ? 'root' : null,
        deps: [],
        archived: false,
        deletedAt: null,
      } as RowRecord['value'],
    }),
  )
  const session = (id: string, issueId: string, phase: string): RowRecord => ({
    kind: 'session',
    id,
    value: {
      sessionId: id,
      issueId,
      status: 'live',
      agentKind: 'codex',
      cwd: '/repo',
      archived: false,
      agentState: { phase, since: '2026-11-08T00:00:00Z' },
      lastActiveAt: '2026-11-08T00:00:00Z',
    } as RowRecord['value'],
  })
  pool.apply({
    type: 'replace',
    rows: [
      ...issues,
      session('related', 'child', 'working'),
      session('other', 'unrelated', 'working'),
    ],
  })
  const refresh = vi.fn()
  const stop = costRefresh(pool, 'root')(refresh)
  const read = vi.spyOn(pool, 'row')
  try {
    pool.apply({ type: 'update', rows: [session('other', 'unrelated', 'idle')] })
    expect(refresh).not.toHaveBeenCalled()
    pool.apply({ type: 'update', rows: [session('related', 'child', 'idle')] })
    expect(refresh).toHaveBeenCalledTimes(1)
    pool.apply({
      type: 'update',
      rows: [{ ...issues[1]!, value: { ...issues[1]!.value, stage: 'review' } }],
    })
    expect(refresh).toHaveBeenCalledTimes(2)
    pool.apply({ type: 'update', rows: [session('related', 'child', 'working')] })
    expect(refresh).toHaveBeenCalledTimes(2)
    expect(
      read.mock.calls.filter(([kind]) => kind === 'session').map(([, id]) => id),
    ).not.toContain('historical')
    stop()
    pool.apply({ type: 'update', rows: [session('related', 'child', 'idle')] })
    expect(refresh).toHaveBeenCalledTimes(2)
  } finally {
    stop()
    pool.dispose()
  }
})
