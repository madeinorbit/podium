import type { CostModelTotalWire, TaskCostRowWire } from '@podium/model'
import { autorun } from 'mobx'
import { expect, it, vi } from 'vitest'
import { ISSUE_PAGE_SUMMARIES } from './issue-page-schema'
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
  const pool = new MobxPool({ selectedIssueId: null, coarseNow: 0 })
  pool.apply({
    type: 'update',
    rows: ['old', 'new'].map((id) => ({ kind: 'issue', id, value: issue(id, 'project') as never })),
  })
  const view = new TaskCostView(pool)
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
  pool.apply({
    type: 'update',
    rows: [
      { kind: 'issue', id: 'a', value: { ...issue('a', 'podium'), title: 'Renamed' } as never },
    ],
  })
  expect(view.topTasks).toBe(before) // Metadata changes do not reprice the same candidates.
  stop()
  view.dispose()
})

it('separates equal repo labels, joins a shared repo id, and normalizes fallback paths', async () => {
  const pool = new MobxPool({ selectedIssueId: null, coarseNow: 0 })
  pool.apply({
    type: 'update',
    rows: [
      { kind: 'repo', id: 'r1', value: { id: 'r1', name: 'same', path: '/first/same' } },
      { kind: 'repo', id: 'r2', value: { id: 'r2', name: 'same', path: '/second/same' } },
      ...[
        { ...issue('a', 'same'), repoId: 'r1' },
        { ...issue('b', 'same'), repoId: 'r2' },
        { ...issue('c', 'same'), repoId: 'r1' },
        { ...issue('d', 'fallback'), repoPath: 'C:\\src\\fallback\\' },
        { ...issue('e', 'fallback'), repoPath: 'c:/src/fallback' },
      ].map((value) => ({ kind: 'issue', id: value.id, value })),
    ],
  } as never)
  const view = new TaskCostView(pool)
  await view.read(async () => ['a', 'b', 'c', 'd', 'e'].map((id) => row(id, 10)))
  expect(view.projectGroups?.rows.map((g) => [g.projectKey, g.project, g.taskCount])).toEqual([
    ['r1', 'same', 2],
    ['c:\\src\\fallback', 'fallback', 2],
    ['r2', 'same', 1],
  ])
})

it('groups cold task summaries without hydrating full issues', async () => {
  const cold = { ...issue('cold', 'project'), repoId: 'repo', stage: 'done', archived: true }
  const load = vi.fn(() => cold)
  const pool = new MobxPool(
    { selectedIssueId: null, coarseNow: Date.parse('2026-11-10') },
    undefined,
    { load, summaries: ISSUE_PAGE_SUMMARIES, schedule: () => () => {} },
  )
  pool.apply({
    type: 'replace',
    rows: [
      {
        kind: 'repo',
        id: 'repo',
        value: { id: 'repo', name: 'project', repoPath: '/project' } as never,
      },
      { kind: 'issue', id: cold.id, value: cold as never },
    ],
  })
  const view = new TaskCostView(pool)
  await view.read(async () => [row('cold', 10)])
  expect(pool.tables.issue.size).toBe(0)
  expect(view.topTasks).toEqual([{ issueId: 'cold', windowCostUsd: 10 }])
  expect(view.projectGroups?.rows[0]?.project).toBe('project')
  expect(pool.hydrate()).toBe(0)
  expect(load).not.toHaveBeenCalled()
  // Positive control: a full record reader does request the cold payload.
  pool.row('issue', 'cold')
  expect(pool.hydrate()).toBe(1)
  expect(load).toHaveBeenCalledTimes(1)
  view.dispose()
  pool.dispose()
})

it('omits gone candidates before ranking and restores them only when the pool readmits them', async () => {
  const pool = new MobxPool({ selectedIssueId: null, coarseNow: 0 }, undefined, {
    load: () => undefined,
    summaries: ISSUE_PAGE_SUMMARIES,
    schedule: () => () => {},
  })
  const ids = ['a', 'b', 'c', 'd', 'e', 'f', 'removed']
  pool.apply({
    type: 'update',
    rows: ids.map((id) => ({ kind: 'issue', id, value: issue(id, 'project') as never })),
  })
  const view = new TaskCostView(pool)
  await view.read(async () => [
    row('removed', 100),
    row('invisible', 90),
    ...ids.slice(0, 6).map((id, i) => row(id, 6 - i)),
  ])
  let ranked: string[] = []
  const stop = autorun(() => {
    ranked = view.topTasks?.map((task) => task.issueId) ?? []
  })
  expect(ranked).toContain('removed') // Positive control: visible high spend does rank.
  pool.apply({ type: 'update', rows: [{ kind: 'issue', id: 'removed', value: undefined }] })
  pool.hydrate() // Settle the unknown/invisible task through the actual pool loader.
  expect(ranked).toEqual(['a', 'b', 'c', 'd', 'e'])
  expect(view.projectGroups?.attributedUsd).toBe(21)
  pool.apply({
    type: 'update',
    rows: [{ kind: 'issue', id: 'invisible', value: issue('invisible', 'project') as never }],
  })
  expect(ranked).toEqual(['invisible', 'a', 'b', 'c', 'd'])
  stop()
  view.dispose()
  pool.dispose()
})

it('reads only window folds for top tasks and projects; the full sheet still prices history on demand', async () => {
  const pool = new MobxPool({ selectedIssueId: null, coarseNow: 0 })
  pool.apply({
    type: 'update',
    rows: [{ kind: 'issue', id: 'a', value: issue('a', 'project') as never }],
  })
  const view = new TaskCostView(pool)
  const history = vi.fn(() => [usd(500)])
  const task = row('a', 10)
  Object.defineProperty(task, 'models', { get: history })
  Object.defineProperty(task, 'rollupModels', { get: history })
  await view.read(async () => [task])
  expect(view.topTasks).toEqual([{ issueId: 'a', windowCostUsd: 10 }])
  expect(view.projectGroups?.attributedUsd).toBe(10)
  expect(history).not.toHaveBeenCalled()
  // Positive control: all-time consumers retain their existing semantics.
  expect(view.rows?.[0]?.estCostUsd).toBe(500)
  expect(history).toHaveBeenCalled()
  view.dispose()
  pool.dispose()
})
