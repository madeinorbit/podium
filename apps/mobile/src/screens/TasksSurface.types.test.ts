import { MissionScreen } from '@podium/client-graph/mission-screen'
import { attachMissionTestPreferences } from '@podium/client-graph/mission-screen.test.fixture'
import { attachMobileScreens } from '@podium/client-graph/mobile-screens'
import { MobileTasksBoard } from '@podium/client-graph/mobile-tasks'
import { MobxPool } from '@podium/client-graph/pool'
import { LOADING } from '@podium/client-graph/worklist/rollup'
import { autorun, runInAction } from 'mobx'
import { expect, it } from 'vitest'
import { compactAge, taskRowFigure, tasksSubtitle } from './TasksSurface.types'

const counts = { in_progress: 5, review: 11, planning: 0, backlog: 0, proposed: 0, done: 0 }

it('names the project scope and the In Progress and Review counts', () => {
  expect(tasksSubtitle(undefined, counts)).toEqual({
    project: 'All projects',
    counts: '5 in progress · 11 in review',
  })
  expect(tasksSubtitle(['/src/podium'], counts).project).toBe('podium')
  expect(tasksSubtitle(['/a', '/b'], null)).toEqual({ project: '2 projects', counts: '' })
})

it('formats shared progress without showing a stale count while loading, and a compact age otherwise', () => {
  expect(taskRowFigure({ total: 25, done: 21 }, '3d ago')).toBe('21/25')
  expect(taskRowFigure({ total: 0, done: 0 }, '3d ago')).toBe('0/0')
  expect(taskRowFigure(LOADING, '3d ago')).toBe('')
  expect(taskRowFigure(null, '6m ago')).toBe('6m')
  expect(compactAge('just now')).toBe('now')
})

it('matches desktop and deck leaf progress for a TFT-88-shaped task across live changes', async () => {
  const stamp = '2026-11-13T12:00:00Z'
  const issue = (id: string, parentId: string | null, patch: Record<string, unknown> = {}) => ({
    id,
    parentId,
    seq: id === 'audit' ? 88 : 1,
    title: id === 'audit' ? 'Dependency security audit' : id,
    type: 'task',
    stage: 'in_progress',
    audience: 'human',
    repoPath: '/fixture',
    deps: [],
    createdAt: stamp,
    updatedAt: stamp,
    ...patch,
  })
  const pool = new MobxPool({ selectedIssueId: null, coarseNow: Date.parse(stamp) })
  attachMissionTestPreferences(pool)
  pool.apply({
    type: 'replace',
    rows: [
      issue('audit', null),
      ...['inventory', 'patches', 'verification'].map((id) =>
        issue(id, 'audit', { type: 'phase' }),
      ),
      issue('nested-phase', 'patches', { type: 'phase' }),
      issue('empty-phase', 'nested-phase', { type: 'phase' }),
      issue('checks', 'verification'),
      ...['inventory', 'nested-phase', 'checks'].flatMap((parentId) =>
        [1, 2].map((n) => issue(`${parentId}-${n}`, parentId, { stage: 'done' })),
      ),
      issue('remaining', 'verification', { stage: 'backlog' }),
      issue('proposal', 'audit', { stage: 'proposed' }),
      issue('unaccepted', 'proposal', { stage: 'done' }),
      // TFT-95 has no seat and a discovered proposal (TFT-97). Desktop
      // excludes that vacated origin even while the proposal is unaccepted.
      issue('spin-off', null, {
        stage: 'proposed',
        deps: [{ type: 'discovered-from', id: 'checks-1' }],
      }),
      ...['cancelled', 'duplicate', 'superseded'].map((closedReason) =>
        issue(closedReason, 'verification', { stage: 'done', closedReason }),
      ),
    ].map((value) => ({ kind: 'issue' as const, id: value.id, value })),
  })
  await attachMobileScreens(pool)
  const board = new MobileTasksBoard(pool, {
    showDone: false,
    expanded: [],
    filter: {},
    ordering: 'priority',
    showAgentTasks: false,
  })
  const opening = new MissionScreen(pool, 'audit', { fullOnly: true })
  let figures: string[] = []
  const stop = autorun(() => {
    const desktop = pool.worklistRow('audit')?.progress
    if (!desktop || desktop === LOADING) throw new Error('Desktop progress must be loaded')
    const full = opening.full.buckets
    expect(full).toBe(desktop)
    const deck = opening.progress
    figures = [
      taskRowFigure(board.task('audit').progress, null),
      `${desktop.done}/${desktop.total}`,
      `${full.done}/${full.total}`,
      `${deck.done}/${deck.total}`,
    ]
  })
  try {
    expect(board.issue('audit').childCount).toBe(4)
    expect(board.issue('audit').childDoneCount).toBe(0)
    expect(figures).toEqual(['5/6', '5/6', '5/6', '5/6'])
    board.toggleExpanded('audit')
    board.setFilter({ text: 'remaining' })
    opening.full.setFilter('needs-you')
    opening.full.setShowDone(true)
    expect(figures).toEqual(['5/6', '5/6', '5/6', '5/6'])
    runInAction(() =>
      pool.apply({
        type: 'update',
        rows: [
          {
            kind: 'issue',
            id: 'remaining',
            value: issue('remaining', 'verification', { stage: 'done' }),
          },
        ],
      }),
    )
    expect(figures).toEqual(['6/6', '6/6', '6/6', '6/6'])
    runInAction(() =>
      pool.apply({
        type: 'update',
        rows: [
          {
            kind: 'issue',
            id: 'proposal',
            value: issue('proposal', 'audit', { stage: 'backlog' }),
          },
        ],
      }),
    )
    expect(figures).toEqual(['7/7', '7/7', '7/7', '7/7'])
    runInAction(() =>
      pool.apply({
        type: 'update',
        rows: [
          { kind: 'issue', id: 'spin-off', value: issue('spin-off', null, { stage: 'proposed' }) },
        ],
      }),
    )
    expect(figures).toEqual(['8/8', '8/8', '8/8', '8/8'])
  } finally {
    stop()
    opening.close()
    pool.dispose()
  }
})
