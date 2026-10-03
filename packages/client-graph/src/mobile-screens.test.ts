import { autorun, observable, runInAction } from 'mobx'
import { afterEach, expect, it, vi } from 'vitest'
import { attachMobileScreens } from './mobile-screens'
import { MOBILE_SCREEN_SUMMARIES, type MobileTasksOptions } from './mobile-screens-schema'
import { MobxPool } from './pool'
import { LOADING } from './worklist/rollup'

const now = Date.parse('2026-10-03T12:00:00Z')
const options: MobileTasksOptions = {
  showDone: true,
  expanded: ['root', 'proposal'],
  filter: { archived: true },
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
async function setup(rows: ReturnType<typeof issue>[]) {
  const load = vi.fn((_kind: string, id: string) => rows.find((row) => row.id === id))
  const pool = new MobxPool({ selectedIssueId: null, coarseNow: now }, undefined, {
    load,
    summaries: MOBILE_SCREEN_SUMMARIES,
    schedule: () => () => {},
  })
  pool.apply({
    type: 'replace',
    rows: rows.map((value) => ({ kind: 'issue' as const, id: value.id, value })),
  })
  const scans = vi.spyOn(pool.residency!, 'ids')
  await attachMobileScreens(pool)
  disposals.push(() => {
    scans.mockRestore()
    pool.dispose()
  })
  const reader = pool.row('mobileScreenReader', 'reader')
  if (!reader || reader === LOADING) throw new Error('screen reader missing')
  return { pool, reader, load, scans }
}
it('reads cold Tasks through declared summaries without promoting or loading them', async () => {
  const { pool, reader, load, scans } = await setup([
    issue('root'),
    issue('cold', { archived: true, stage: 'done' }),
  ])
  const row = vi.spyOn(pool, 'row')
  const stop = autorun(() => reader.tasks(options))
  disposals.push(stop)
  expect(reader.tasks(options)).toMatchObject({
    board: [
      { stage: 'in_progress', rows: [{ issue: { id: 'root' }, depth: 0 }] },
      { stage: 'done', rows: [{ issue: { id: 'cold', title: 'cold' }, depth: 0 }] },
    ],
  })
  expect(pool.tables.issue.has('cold')).toBe(false)
  expect(pool.hydrate()).toBe(0)
  expect(load).not.toHaveBeenCalled()
  expect(row.mock.calls.some(([, , purpose]) => String(purpose) === 'peek')).toBe(false)
  expect(scans).not.toHaveBeenCalled()
})
it('retains matching ancestors, promotes proposal blocks, and keeps collapsed child counts honest', async () => {
  const { reader } = await setup([
    issue('root', { seq: 10 }),
    issue('child', { seq: 11, parentId: 'root', stage: 'review' }),
    issue('proposal', { seq: 12, parentId: 'root', stage: 'proposed' }),
    issue('offered-child', { seq: 13, parentId: 'proposal', stage: 'backlog' }),
  ])
  const data = reader.tasks({ ...options, filter: {} })
  expect(data).toMatchObject({
    proposals: 1,
    board: [
      {
        stage: 'in_progress',
        rows: [
          { issue: { id: 'root' }, depth: 0, childCount: 1, expanded: true },
          { issue: { id: 'child' }, depth: 1, childCount: 0 },
        ],
      },
      {
        stage: 'proposed',
        rows: [
          { issue: { id: 'proposal' }, depth: 0, childCount: 1, expanded: true },
          { issue: { id: 'offered-child' }, depth: 1 },
        ],
      },
    ],
  })
  expect(reader.tasks({ ...options, filter: { text: 'child' }, expanded: [] })).toMatchObject({
    board: [{ stage: 'in_progress', rows: [{ issue: { id: 'root' }, depth: 0 }] }],
  })
})
it('a known cold mission remains LOADING until one batched load supplies its row', async () => {
  const { pool, reader, load } = await setup([issue('cold', { archived: true, stage: 'done' })])
  expect(reader.mission('cold')).toBe(LOADING)
  expect(reader.deck('cold', 'full')).toBe(LOADING)
  expect(reader.mission('cold')).toBe(LOADING)
  expect(load).not.toHaveBeenCalled()
  expect(pool.hydrate()).toBe(1)
  expect(load).toHaveBeenCalledTimes(1)
  expect(reader.mission('cold')).toMatchObject({
    root: { id: 'cold' },
    missionSessions: [],
    progress: { total: 0, done: 0 },
  })
})
it('an explicitly opened archived mission counts accepted formal children without counting its root', async () => {
  const { pool, reader } = await setup([
    issue('cold', { archived: true, stage: 'done' }),
    issue('child', { parentId: 'cold' }),
  ])
  expect(reader.mission('cold')).toBe(LOADING)
  while (pool.hydrate()) {}
  expect(reader.mission('cold')).toMatchObject({
    root: { id: 'cold' },
    progress: { total: 1, done: 0, stall: 1 },
  })
  expect(reader.deck('cold', 'full')).toMatchObject({ rows: [], presence: null })
})
it('an unknown mission is not found in the complete principal replica and never queues a load', async () => {
  const { pool, reader, load } = await setup([issue('root')])
  expect(reader.mission('absent')).toMatchObject({ root: undefined, missionSessions: [] })
  expect(reader.deck('absent', 'full')).toMatchObject({ root: undefined, rows: [] })
  expect(pool.hydrate()).toBe(0)
  expect(load).not.toHaveBeenCalled()
})
it('observes an addressed mission without subscribing to unrelated issue content', async () => {
  const { pool, reader } = await setup([issue('root'), issue('unrelated')])
  const selected = observable.box('root')
  let draws = 0
  const stop = autorun(() => {
    reader.mission(selected.get())
    draws++
  })
  disposals.push(stop)
  while (pool.hydrate()) {}
  const before = draws
  const beforeWork = { ...reader.stats }
  runInAction(() =>
    pool.apply({
      type: 'update',
      rows: [{ kind: 'issue', id: 'unrelated', value: issue('unrelated', { title: 'new title' }) }],
    }),
  )
  expect(draws).toBe(before)
  expect(reader.stats).toEqual(beforeWork)
  expect(reader.mission('root')).toMatchObject({ root: { title: 'root' }, progress: { total: 1 } })
  runInAction(() => selected.set('unrelated'))
  expect(reader.mission('unrelated')).toMatchObject({ root: { title: 'new title' } })
})
