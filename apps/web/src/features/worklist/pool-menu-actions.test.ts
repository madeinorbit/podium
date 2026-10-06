import { sidebarView } from '@podium/client-graph/worklist/sidebar'
import { headerView } from '@podium/client-graph/header-views'
import { configureDevelopmentChecks } from '@podium/mobx-helpers'
import { configure } from 'mobx'
import { LOADING } from '@podium/client-graph'
import { MobxPool } from '@podium/client-graph/pool'
import type { SliceIssue, SliceSession } from '@podium/client-graph/shared/slice-types'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createPoolWorkActions } from './use-pool-unified-work'

it('resolves one sidebar menu with equal first/repeated row work at 1x/4x unrelated history', () => {
  const work: number[] = [],
    stamp = '2026-10-05T00:00:00Z'
  for (const size of [64, 256]) {
    const issue = {
      id: 'own',
      seq: 1,
      title: 'Own',
      repoPath: '/synthetic',
      stage: 'in_progress',
      createdAt: stamp,
      updatedAt: stamp,
    } satisfies SliceIssue
    const session = {
      sessionId: 'own-seat',
      issueId: issue.id,
      cwd: '/synthetic',
      status: 'live',
      agentKind: 'codex',
      harnessHandoff: true,
      createdAt: stamp,
      lastActiveAt: stamp,
    } satisfies SliceSession
    const pool = new MobxPool({ selectedIssueId: null, coarseNow: Date.parse(stamp) })
    pool.apply({
      type: 'replace',
      rows: [
        { kind: 'issue', id: issue.id, value: issue },
        {
          kind: 'issue',
          id: 'child',
          value: { ...issue, id: 'child', parentId: issue.id, stage: 'done', archived: true },
        },
        { kind: 'session', id: session.sessionId, value: session },
        {
          kind: 'session',
          id: 'shell',
          value: { ...session, sessionId: 'shell', agentKind: 'shell' },
        },
        ...Array.from({ length: size }, (_, i) => [
          { kind: 'issue' as const, id: `other-${i}`, value: { ...issue, id: `other-${i}` } },
          {
            kind: 'session' as const,
            id: `other-seat-${i}`,
            value: { ...session, sessionId: `other-seat-${i}`, issueId: `other-${i}` },
          },
        ]).flat(),
      ],
    })
    const sidebar = vi
      .spyOn(sidebarView(pool), 'row')
      .mockReturnValue({ issue, deferred: false } as never)
    vi.spyOn(headerView(pool), 'ids').mockReturnValue([])
    vi.spyOn(headerView(pool), 'machines').mockReturnValue([])
    vi.spyOn(pool.tables.issue, 'keys').mockImplementation(() => {
      throw new Error('all issues')
    })
    vi.spyOn(pool.tables.session, 'keys').mockImplementation(() => {
      throw new Error('all sessions')
    })
    const rows = vi.spyOn(pool, 'row')
    try {
      const actions = createPoolWorkActions(pool, { access: {} } as never, () => {})
      for (let n = 0; n < 2; n++) {
        rows.mockClear()
        sidebar.mockClear()
        const menu = actions.resolveMenuData(issue.id)
        expect(sidebar).not.toHaveBeenCalled()
        expect(menu.single).toMatchObject([
          {
            id: 'own',
            sessionSummary: { total: 1 },
            childCount: 1,
            childDoneCount: 1,
          },
        ])
        expect(menu.all.map((issue) => issue.id)).toEqual(['own'])
        expect(menu.poolInputs).toMatchObject({ sessions: [{ sessionId: 'own-seat' }] })
        expect(rows.mock.calls.some(([, id]) => id.startsWith('other-'))).toBe(false)
        work.push(rows.mock.calls.length)
      }
    } finally {
      vi.restoreAllMocks()
      pool.dispose()
    }
  }
  expect(work[2]).toBe(work[0])
  expect(work[3]).toBe(work[1])
  console.info('POD-5569 sidebar menu row reads [1x first,repeat;4x first,repeat]', work)
})

it('keeps an addressed pending member in the sidebar menu until its payload settles', () => {
  const stamp = '2026-10-05T00:00:00Z'
  const issue = {
    id: 'own',
    seq: 1,
    title: 'Own',
    repoPath: '/synthetic',
    stage: 'in_progress',
    createdAt: stamp,
    updatedAt: stamp,
  } satisfies SliceIssue
  const session = {
    sessionId: 'own-seat',
    issueId: issue.id,
    cwd: '/synthetic',
    agentKind: 'codex',
    harnessHandoff: true,
    status: 'live',
    createdAt: stamp,
    lastActiveAt: stamp,
  } satisfies SliceSession
  const pool = new MobxPool({ selectedIssueId: null, coarseNow: Date.parse(stamp) })
  pool.apply({
    type: 'replace',
    rows: [
      { kind: 'issue', id: issue.id, value: issue },
      { kind: 'session', id: session.sessionId, value: session },
    ],
  })
  vi.spyOn(sidebarView(pool), 'row').mockReturnValue({ issue, deferred: false } as never)
  const row = pool.row.bind(pool)
  vi.spyOn(pool, 'row').mockImplementation((...args) =>
    args[0] === 'session' && args[1] === 'own-seat' ? LOADING : row(...args),
  )
  try {
    const menu = createPoolWorkActions(pool, { access: {} } as never, () => {}).resolveMenuData(
      issue.id,
    )
    expect(menu.single).toEqual([])
    expect(menu.poolInputs).toBe(LOADING)
  } finally {
    pool.dispose()
    vi.restoreAllMocks()
  }
})

let warnings: unknown[][] = []
beforeEach(() => {
  warnings = []
  vi.spyOn(console, 'warn').mockImplementation((...args) => { warnings.push(args) })
  configureDevelopmentChecks(true)
})
afterEach(() => {
  try { expect(warnings.filter(args => String(args[0]).startsWith('[mobx]'))).toEqual([]) }
  finally {
    configure({ enforceActions: 'never', computedRequiresReaction: false,
      reactionRequiresObservable: false, observableRequiresReaction: false })
    vi.restoreAllMocks()
  }
})
