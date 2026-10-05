import { MobxPool } from '@podium/client-graph/pool'
import type { SliceIssue, SliceSession } from '@podium/client-graph/shared/slice-types'
import { expect, it, vi } from 'vitest'
import { createPoolWorkActions } from './use-pool-unified-work'

it('resolves one sidebar menu with equal first/repeated row work at 1x/4x unrelated history', () => {
  const work: number[] = [], stamp = '2026-10-05T00:00:00Z'
  for (const size of [64, 256]) {
    const issue = { id: 'own', seq: 1, title: 'Own', repoPath: '/synthetic', stage: 'in_progress',
      createdAt: stamp, updatedAt: stamp } satisfies SliceIssue
    const session = { sessionId: 'own-seat', issueId: issue.id, cwd: '/synthetic', status: 'live', agentKind: 'codex',
      createdAt: stamp, lastActiveAt: stamp } satisfies SliceSession
    const pool = new MobxPool({ selectedIssueId: null, coarseNow: Date.parse(stamp) })
    pool.apply({ type: 'replace', rows: [
      { kind: 'issue', id: issue.id, value: issue },
      { kind: 'issue', id: 'child', value: { ...issue, id: 'child', parentId: issue.id, stage: 'done', archived: true } },
      { kind: 'session', id: session.sessionId, value: session },
      { kind: 'session', id: 'shell', value: { ...session, sessionId: 'shell', agentKind: 'shell' } },
      ...Array.from({ length: size }, (_, i) => [
        { kind: 'issue' as const, id: `other-${i}`, value: { ...issue, id: `other-${i}` } },
        { kind: 'session' as const, id: `other-seat-${i}`, value: { ...session, sessionId: `other-seat-${i}`, issueId: `other-${i}` } },
      ]).flat(),
    ] })
    const sidebar = vi.spyOn(pool.sidebar, 'row').mockReturnValue({ issue, deferred: false } as never)
    vi.spyOn(pool.headerViews, 'ids').mockReturnValue([])
    vi.spyOn(pool.headerViews, 'machines').mockReturnValue([])
    vi.spyOn(pool.tables.issue, 'keys').mockImplementation(() => { throw new Error('all issues') })
    vi.spyOn(pool.tables.session, 'keys').mockImplementation(() => { throw new Error('all sessions') })
    const rows = vi.spyOn(pool, 'row')
    try {
      const actions = createPoolWorkActions(pool, { access: {} } as never, () => {})
      for (let n = 0; n < 2; n++) {
        rows.mockClear(); sidebar.mockClear()
        const menu = actions.resolveMenuData(issue.id)
        expect(sidebar.mock.calls).toEqual([['own']])
        expect(menu.single).toMatchObject([{ id: 'own', memberSessionIds: ['own-seat'], childIds: ['child'], childCount: 1, childDoneCount: 1 }])
        expect(menu.all.map(issue => issue.id)).toEqual(['own'])
        expect(menu.poolInputs).toMatchObject({ sessions: [{ sessionId: 'own-seat' }] })
        expect(rows.mock.calls.some(([, id]) => id.startsWith('other-'))).toBe(false)
        work.push(rows.mock.calls.length)
      }
    } finally { pool.dispose(); vi.restoreAllMocks() }
  }
  expect(work[2]).toBe(work[0]); expect(work[3]).toBe(work[1])
  console.info('POD-5569 sidebar menu row reads [1x first,repeat;4x first,repeat]', work)
})
