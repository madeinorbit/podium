import { CONFIRMED_AGENT_ACTIVITY_MAX_AGE_MS } from '@podium/model/browser'
import { autorun, runInAction } from 'mobx'
import { afterEach, expect, it, vi } from 'vitest'
import { attachMobileScreens } from './mobile-screens'
import { MOBILE_SCREEN_SUMMARIES, type MobileTasksOptions } from './mobile-screens-schema'
import { MobxPool } from './pool'
import { LOADING } from './worklist/rollup'
import { MobileTasksBoard } from './mobile-tasks'

const now = Date.parse('2026-10-05T12:00:00Z')
const options: MobileTasksOptions = {
  showDone: true,
  expanded: [],
  filter: {},
  ordering: 'priority',
  showAgentTasks: false,
}
const issue = (id: string, patch: object = {}) => ({
  id,
  seq: 1,
  title: id,
  description: { value: 'summary description' },
  stage: 'in_progress',
  priority: 2,
  type: 'task',
  audience: 'human' as const,
  repoPath: '/fixture',
  labels: [],
  deps: [],
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
  ...patch,
})
const disposals: (() => void)[] = []
afterEach(() => {
  for (const dispose of disposals.splice(0)) dispose()
})
async function setup(
  rows: ReturnType<typeof issue>[],
  sessions: Record<string, unknown>[] = [],
) {
  const pool = new MobxPool({ selectedIssueId: null, coarseNow: now }, undefined, {
    load: vi.fn(),
    summaries: MOBILE_SCREEN_SUMMARIES,
    schedule: () => () => {},
  })
  pool.apply({
    type: 'replace',
    rows: [
      ...rows.map((value) => ({ kind: 'issue' as const, id: value.id, value })),
      ...sessions.map((value) => ({
        kind: 'session' as const,
        id: (value as { sessionId: string }).sessionId,
        value,
      })),
    ],
  })
  await attachMobileScreens(pool)
  disposals.push(() => pool.dispose())
  const reader = pool.row('mobileScreenReader', 'reader')
  if (!reader || reader === LOADING) throw new Error('screen reader missing')
  return { pool, reader }
}

it('holds mobile tasks across an empty minute tick and expires the worker at its deadline', async () => {
  const liveAt = new Date(now - 60_000).toISOString()
  const { pool, reader } = await setup(
    [issue('root', { memberSessionIds: ['worker'] })],
    [{
      sessionId: 'worker', issueId: 'root', status: 'live', agentKind: 'codex',
      lastActiveAt: liveAt,
      agentState: { phase: 'working', since: liveAt, stateObservedAt: liveAt },
    }],
  )
  const board = new MobileTasksBoard(pool, options)
  const model = pool.issueObject('root')
  let tasks: MobileTasksBoard['sections'] | undefined
  let runs = 0, workers = 0
  const stop = autorun(() => { runs += 1; tasks = board.sections })
  disposals.push(autorun(() => { workers = model.confirmedWorkingAgents }))
  disposals.push(stop)
  expect(workers).toBe(1)
  const before = tasks!
  const observed = runs
  runInAction(() => pool.clock.advance(now + 60_000))
  expect(tasks).toBe(before)
  expect(runs).toBe(observed)
  runInAction(() => pool.clock.advance(now + CONFIRMED_AGENT_ACTIVITY_MAX_AGE_MS + 1))
  expect(tasks).toBe(before)
  expect(runs).toBe(observed)
  expect(workers).toBe(0)
})
