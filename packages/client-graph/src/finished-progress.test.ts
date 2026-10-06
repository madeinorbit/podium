import { sidebarView } from './worklist/sidebar'
import { autorun, runInAction } from 'mobx'
import { expect, it } from 'vitest'
import { issueClosed, missionRollup, type IssueNavigationModel } from '@podium/client-core/values'
import { isFinished as modelFinished } from '@podium/model/browser'
import { createHeaderViews } from './header-views'
import { createIssueBoardSource } from './issue-board-source'
import { missionView } from './mission-view'
import { MISSION_VIEW_SUMMARIES } from './mission-view-schema'
import { MobxPool } from './pool'
import { isClosed, isFinished } from './shared/predicates'
import { LOADING } from './worklist/rollup'

const stamp = '2026-10-01T12:00:00Z'
const issue = (id: string, patch: object = {}) => ({
  id, seq: 1, title: id, description: '', stage: 'planning', audience: 'human',
  deps: [], parentId: id === 'root' ? null : 'root', repoPath: '/synthetic',
  createdAt: stamp, updatedAt: stamp, readAt: stamp, ...patch,
}) as unknown as IssueNavigationModel
function tracked<T>(read: () => T): T {
  let value!: T
  const stop = autorun(() => { value = read() })
  stop()
  return value
}

it('mission header, mission pane and sidebar agree on empty, absent and legacy reasons, including cold children', () => {
  const rows = [issue('root'),
    issue('open-null', { closedReason: null }),
    issue('open-undefined', { stage: 'backlog', closedReason: undefined }),
    issue('reason-empty', { stage: 'in_progress', closedReason: '' }),
    issue('done-null', { stage: 'done', closedReason: null }),
    issue('done-undefined', { stage: 'done', closedReason: undefined }),
    issue('cold-empty', { stage: 'done', closedReason: '', closedAt: '2026-09-01T12:00:00Z',
      updatedAt: '2026-09-01T12:00:00Z', readAt: '2026-09-01T12:00:00Z' }),
    issue('reason-text', { stage: 'review', closedReason: 'merged' }),
    issue('cancelled', { stage: 'done', closedReason: 'wontfix' }),
    issue('duplicate', { stage: 'done', closedReason: 'dupe' }),
    issue('superseded', { stage: 'done', closedReason: 'superseded' }),
    issue('proposed', { stage: 'proposed' }),
  ]
  const byId = new Map<string, IssueNavigationModel>(rows.map(row => [row.id, row]))
  const pool = new MobxPool({ selectedIssueId: 'root', coarseNow: Date.parse(stamp) }, undefined, {
    load: (_entity, id) => byId.get(id), summaries: MISSION_VIEW_SUMMARIES, schedule: () => () => {},
  })
  const header = createHeaderViews(pool)
  const pane = missionView(pool)
  const board = createIssueBoardSource(pool)
  try {
    expect(isFinished).toBe(modelFinished)
    expect(issueClosed).toBe(isFinished)
    expect(isClosed(rows[3]!)).toBe(true)
    pool.apply({ type: 'replace', rows: rows.map(value => ({ kind: 'issue' as const, id: value.id, value })) })
    expect(pool.tables.issue.has('cold-empty')).toBe(false)
    const read = () => ({ header: header.folded(), pane: pane.values('root', 'full'), sidebar: sidebarView(pool).row('root') } as const)
    const openIds = () => {
      const result = board.queryIds({ kind: 'board', filter: { status: 'open' } })
      if (!result || result === LOADING) throw new Error('Unsettled board filter')
      return result.ids
    }
    let result = tracked(read)
    for (let attempt = 0; attempt < 3; attempt++) {
      if (!pool.hydrate()) break
      result = tracked(read)
    }
    expect(result.header.loading).toBe(false)
    expect(result.pane).not.toBe(LOADING)
    expect(result.sidebar).not.toBe(LOADING)
    if (result.pane === LOADING || !result.sidebar || result.sidebar === LOADING) throw new Error('Unsettled fixture')
    expect(result.header.progress).toEqual({ total: 7, done: 5, stall: 1, wait: 1, run: 0, block: 0, review: 0 })
    expect(result.pane.progress).toEqual(result.header.progress)
    expect(result.sidebar.progress).toEqual(result.header.progress)
    expect(missionRollup(rows, [], 'root').progress).toEqual(result.header.progress)
    expect(tracked(() => board.issue('reason-empty'))).toMatchObject({ ready: false })
    expect(tracked(openIds)).not.toContain('reason-empty')

    // A reason-only reopen must invalidate progress and membership on every surface.
    const reopened = issue('reason-empty', { stage: 'in_progress', closedReason: null })
    runInAction(() => pool.apply({ type: 'update', rows: [{ kind: 'issue', id: reopened.id, value: reopened }] }))
    const next = tracked(read)
    if (next.pane === LOADING || !next.sidebar || next.sidebar === LOADING) throw new Error('Unsettled update')
    expect(next.header.progress).toMatchObject({ total: 7, done: 4, stall: 2 })
    expect(next.pane.progress).toEqual(next.header.progress)
    expect(next.sidebar.progress).toEqual(next.header.progress)
    expect(tracked(openIds)).toContain('reason-empty')
  } finally {
    board.dispose()
    header.clear()
    pool.dispose()
  }
})
