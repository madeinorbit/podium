import type { CostModelTotalWire, TaskCostRowWire } from '@podium/model'
import { autorun } from 'mobx'
import { expect, it } from 'vitest'
import { MobxPool } from './pool'
import { TaskCostView } from './task-cost-view'

const stamp = () => new Date(0).toISOString()
const usd = (dollars: number): CostModelTotalWire => ({
  model: 'claude-opus-5',
  inputTokens: dollars * 200_000, // $5/MTok input
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheCreationTokens: 0,
  cacheCreation1hTokens: 0,
  messages: 1,
})
const row = (id: string, windowUsd: number): TaskCostRowWire =>
  ({
    issueId: id,
    seq: 1,
    title: id,
    stage: 'in_progress',
    models: [usd(windowUsd)],
    messages: 1,
    windowModels: windowUsd > 0 ? [usd(windowUsd)] : [],
    windowMessages: 1,
    rollupModels: [usd(windowUsd)],
    rollupMessages: 1,
    sessionCount: 1,
    floor: 'none',
    harnesses: ['claude-code'],
    uncostedSessionCount: 0,
  }) as TaskCostRowWire
const issue = (id: string, repoName: string) => ({
  id,
  seq: 1,
  title: id,
  stage: 'in_progress',
  repoName,
  repoPath: `/src/${repoName}`,
  parentId: null,
  deps: [],
  archived: false,
  createdAt: stamp(),
  updatedAt: stamp(),
})

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((r) => {
    resolve = r
  })
  return { promise, resolve }
}

it('keeps the newer answer when an older poll settles last', async () => {
  const view = new TaskCostView(new MobxPool({ selectedIssueId: null, coarseNow: 0 }))
  const older = deferred<TaskCostRowWire[]>()
  const newer = deferred<TaskCostRowWire[]>()
  const first = view.read(() => older.promise)
  const second = view.read(() => newer.promise)
  newer.resolve([row('new', 10)])
  await second
  older.resolve([row('old', 99)])
  await first
  expect(view.topTasks?.map((t) => t.issueId)).toEqual(['new'])
  view.dispose()
})

it('prices once per answer and groups by the pool issue project', async () => {
  const pool = new MobxPool({ selectedIssueId: null, coarseNow: 0 })
  pool.apply({
    type: 'update',
    rows: [
      { kind: 'issue', id: 'a', value: issue('a', 'podium') },
      { kind: 'issue', id: 'b', value: issue('b', 'podium') },
    ],
  } as never)
  const view = new TaskCostView(pool)
  await view.read(() => Promise.resolve([row('a', 10), row('b', 20), row('idle', 0)]))
  let tasks: unknown
  let reruns = 0
  const stop = autorun(() => {
    tasks = view.topTasks
    view.projectGroups
    reruns++
  })
  const before = tasks
  expect(view.topTasks?.map((t) => t.issueId)).toEqual(['b', 'a'])
  expect(view.projectGroups?.rows.map((g) => [g.project, g.taskCount])).toEqual([['podium', 2]])
  // Reading again without a new answer hands back the same cached rows.
  expect(view.topTasks).toBe(before)
  expect(reruns).toBe(1)
  stop()
  view.dispose()
})
