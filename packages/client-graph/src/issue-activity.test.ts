import {
  IssueActivityHistory,
  buildActivityFeed,
  type IssueEvent,
} from '@podium/client-core/values'
import { autorun } from 'mobx'
import { expect, it, vi } from 'vitest'
import { insideReader, measureWork } from '../../../tests/worklist/harness/src/work-meter'
import { issueActivity, type IssueActivityPorts } from './issue-activity'
import { MobxPool } from './pool'

const stamp = '2026-10-01T00:00:00.000Z'
const event = (id: number, patch: Partial<IssueEvent> = {}): IssueEvent => ({
  id,
  ts: stamp,
  kind: 'issue.created',
  subject: 'root',
  repoPath: '/repo',
  payload: null,
  ...patch,
})
const flush = async () => {
  for (let n = 0; n < 12; n++) await Promise.resolve()
}

it('matches the legacy feed after pages, duplicates, hidden kinds and timestamp ties', () => {
  const history = new IssueActivityHistory(),
    comments = [{ author: 'me', body: 'A comment', createdAt: stamp }]
  const rows = [
    event(1),
    event(2, { kind: 'issue.read' }),
    event(3, { ts: '2026-09-30T00:00:00.000Z' }),
    event(4),
  ]
  history.replaceComments(comments)
  history.appendEvents(rows.slice(0, 2))
  const events = history.events,
    items = history.items
  history.appendEvents([rows[0]!, ...rows.slice(2)])
  expect(history.events).toBe(events)
  expect(history.items).toBe(items)
  expect(history.items).toEqual(buildActivityFeed(comments, rows))
  expect(history.since).toBe(4)
  expect(history.appendEvents([rows[0]!, rows[3]!])).toBe(0)
  history.replaceComments([{ ...comments[0]!, body: 'Replaced' }])
  expect(history.items).toEqual(buildActivityFeed([{ ...comments[0]!, body: 'Replaced' }], rows))
  // A planted wrong order is rejected by the same legacy comparison.
  expect([...history.items].reverse()).not.toEqual(
    buildActivityFeed([{ ...comments[0]!, body: 'Replaced' }], rows),
  )
  history.reset()
  expect(history.since).toBe(0)
  expect(history.items).toEqual([])
  expect(history.appendEvents([rows[0]!])).toBe(1)
})

it('appends only the new event rows at 1x/4x and rejects retained-history ID rebuilding', async () => {
  async function capture(scale: 1 | 4, planted = false) {
    const history = new IssueActivityHistory()
    history.appendEvents(Array.from({ length: 128 * scale }, (_, n) => event(n + 1)))
    const next = event(1000, { ts: '2026-10-02T00:00:00.000Z' })
    const measured = await measureWork(async () =>
      insideReader('issue activity append', () => {
        if (planted) new Set(history.events.map((row) => row.id))
        history.appendEvents([next])
      }),
    )
    expect(history.items.at(-1)?.id).toBe('e|1000')
    return measured.work
  }
  const one = await capture(1),
    four = await capture(4)
  for (const counter of ['rows', 'derivations', 'elements'] as const)
    expect(four[counter]).toBe(one[counter])
  const plantedOne = await capture(1, true),
    plantedFour = await capture(4, true)
  expect(plantedFour.elements).toBeGreaterThan(plantedOne.elements)
  console.info(
    'issue activity append work1x4x',
    JSON.stringify({ one, four, retainedHistoryControlRejected: true }),
  )
})

it('shares one request owner, advances hidden-event cursors and resumes after reopen', async () => {
  const pool = new MobxPool({ selectedIssueId: 'root', coarseNow: Date.parse(stamp) })
  pool.apply({
    type: 'replace',
    rows: [
      {
        kind: 'issue',
        id: 'root',
        value: {
          id: 'root',
          title: 'Root',
          repoPath: '/repo',
          stage: 'planning',
          createdAt: stamp,
          updatedAt: stamp,
        },
      },
    ],
  })
  const activity = issueActivity(pool, 'root'),
    calls: number[] = []
  let newest = 201
  const ports: IssueActivityPorts = {
    comments: vi.fn(async () => []),
    mail: vi.fn(async () => []),
    events: vi.fn(async ({ since, limit }) => {
      calls.push(since)
      return Array.from({ length: Math.min(limit, Math.max(0, newest - since)) }, (_, n) =>
        event(since + n + 1, { kind: 'issue.read' }),
      )
    }),
  }
  const paint = vi.fn(),
    stopPaint = autorun(() => {
      void activity.revision
      void activity.mail
      paint()
    })
  const page = activity.retain(ports),
    panel = issueActivity(pool, 'root').retain(ports)
  try {
    expect(issueActivity(pool, 'root')).toBe(activity)
    await flush()
    expect(calls).toEqual([0, 200])
    expect(activity.history.since).toBe(201)
    expect(activity.history.items).toEqual([])
    page()
    panel()
    newest = 202
    const reopen = activity.retain(ports)
    await flush()
    expect(calls).toEqual([0, 200, 201])
    expect(activity.history.since).toBe(202)
    reopen()
    pool.apply({
      type: 'update',
      rows: [
        {
          kind: 'issue',
          id: 'root',
          value: {
            id: 'root',
            title: 'Root',
            repoPath: '/repo',
            stage: 'planning',
            updatedAt: '2026-10-02T00:00:00.000Z',
          },
        },
      ],
    })
    await flush()
    expect(calls).toHaveLength(3)
    expect(paint).toHaveBeenCalled()
  } finally {
    page()
    panel()
    stopPaint()
    pool.dispose()
  }
  expect(activity.history.since).toBe(0)
})

it('ignores stale responses after release and retains already loaded history on failure', async () => {
  const pool = new MobxPool({ selectedIssueId: null, coarseNow: 0 })
  pool.apply({
    type: 'replace',
    rows: [
      { kind: 'issue', id: 'root', value: { id: 'root', repoPath: '/repo', updatedAt: stamp } },
    ],
  })
  const activity = issueActivity(pool, 'root')
  let resolve!: (rows: IssueEvent[]) => void
  const ports: IssueActivityPorts = {
    comments: async () => [],
    mail: async () => [],
    events: () =>
      new Promise((done) => {
        resolve = done
      }),
  }
  const release = activity.retain(ports)
  release()
  resolve([event(1)])
  await flush()
  expect(activity.history.since).toBe(0)
  activity.history.appendEvents([event(1)])
  const retry = activity.retain({
    ...ports,
    events: async () => {
      throw new Error('offline')
    },
  })
  await flush()
  expect(activity.history.since).toBe(1)
  expect(activity.history.items).toHaveLength(1)
  retry()
  pool.dispose()
})
