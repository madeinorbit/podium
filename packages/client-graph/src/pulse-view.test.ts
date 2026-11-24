import type { MachineQuotaWire, TaskCostRowWire, UsageBucketWire } from '@podium/model'
import { autorun } from 'mobx'
import { afterEach, expect, it, vi } from 'vitest'
import { liveFixture } from './live-fixture'
import { MobxPool } from './pool'
import { PulseView } from './pulse-view'

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (cause: unknown) => void
  const promise = new Promise<T>((yes, no) => {
    resolve = yes
    reject = no
  })
  return { promise, resolve, reject }
}
const buckets = [
  {
    hour: '2026-11-10T12:00:00Z',
    model: 'claude-opus-5',
    inputTokens: 20,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    messages: 1,
  },
] satisfies UsageBucketWire[]
const machines = [{ machineId: 'm1' }] as unknown as MachineQuotaWire[]
const tasks = [{ issueId: 'task' }] as TaskCostRowWire[]

const disposals: (() => void)[] = []
afterEach(() => {
  for (const dispose of disposals.splice(0)) dispose()
})

function open(now: () => number = () => 1_000) {
  const pool = new MobxPool({ selectedIssueId: null, coarseNow: 0 })
  const live = liveFixture(pool, now)
  const view = new PulseView(pool)
  // A mounted Pulse reader: what holds `account.usage` in production.
  disposals.push(
    autorun(() => void view.buckets),
    () => view.dispose(),
    () => pool.dispose(),
  )
  return { pool, live, view }
}

it('is cold until the first pushed values, and paints them as they arrive', () => {
  let now = 1_000
  const { live, view } = open(() => now)
  expect(view.buckets).toBeNull()
  expect(view.quota).toBeNull()
  expect(view.usageFailed).toBe(false)
  expect(view.quotaFailed).toBe(false)
  expect(view.usageStamp).toBeNull()

  live.usage({ hostname: 'h', buckets })
  now = 2_000
  live.quota({ machines })
  expect(view.buckets).toBe(buckets)
  expect(view.usageAt).toBe(1_000)
  expect(view.summary.week.estCostUsd).toBeGreaterThan(0)
  expect(view.quota).toBe(machines)
  expect(view.quotaAt).toBe(2_000)
  expect(view.usageStamp).toBe(1_000)
})

it('derives figures against the scan time when the daemon sends one', () => {
  const { live, view } = open(() => 9_000)
  live.usage({ hostname: 'h', sampledAt: '1970-01-01T00:00:04.000Z', buckets })
  expect(view.usageAt).toBe(4_000)
})

it('keeps the last values when the connection drops, and flags each reading on its own', () => {
  const { live, view } = open()
  live.usage({ hostname: 'h', buckets })
  live.quota({ machines })
  // The mounted screen reads the clock while the value is current.
  expect(view.usageAt).toBe(1_000)
  live.lost(5_000)
  expect(view.buckets).toBe(buckets)
  expect(view.quota).toBe(machines)
  expect(view.usageFailed).toBe(true)
  expect(view.quotaFailed).toBe(true)
  // The figures keep the clock of the value they show, not the disconnect's.
  expect(view.usageAt).toBe(1_000)
  // A stale usage value is not a new harvest: nothing to re-ask for.
  expect(view.usageStamp).toBeNull()
})

it('stops holding account.usage while unfocused, keeping the last reading on screen', () => {
  const { live, view } = open()
  live.usage({ hostname: 'h', buckets })
  expect(live.live.usageWatched).toBe(true)
  view.setActive(false)
  expect(live.live.usageWatched).toBe(false)
  expect(view.buckets).toBe(buckets)
  view.setActive(true)
  expect(live.live.usageWatched).toBe(true)
})

it('fails usage alone when the server answers without it', () => {
  const { live, view } = open()
  live.quota({ machines })
  live.usage(null)
  expect(view.buckets).toBeNull()
  expect(view.usageFailed).toBe(true)
  expect(view.usageStamp).toBeNull()
  expect(view.quotaFailed).toBe(false)
  expect(view.quota).toBe(machines)
})

it('lands only the newest of overlapping cost reads and keeps the last answer on failure', async () => {
  const { view } = open()
  const stale = deferred<TaskCostRowWire[]>()
  const first = view.refreshCosts(() => stale.promise)
  await view.refreshCosts(async () => tasks)
  stale.resolve([])
  await first
  expect(view.costs.answer).toBe(tasks)

  await view.refreshCosts(async () => {
    throw new Error('offline')
  })
  expect(view.costs.answer).toBe(tasks)
  expect(view.costs.error).toBe('offline')
  await view.refreshCosts(async () => tasks)
  expect(view.costs.error).toBeNull()
})

it('divides project shares by the usage total each cost request was asked against', async () => {
  const clock = vi.spyOn(Date, 'now').mockReturnValue(Date.parse('2026-11-11T12:00:00Z'))
  try {
    const { pool, live, view } = open(() => Date.now())
    pool.apply({
      type: 'update',
      rows: [
        {
          kind: 'issue',
          id: 'task',
          value: {
            id: 'task',
            seq: 1,
            title: 'Task',
            stage: 'in_progress',
            repoName: 'project',
            repoPath: '/project',
            createdAt: '2026-11-01T00:00:00Z',
            updatedAt: '2026-11-01T00:00:00Z',
          } as never,
        },
      ],
    })
    const costs = [
      { issueId: 'task', windowModels: [{ ...buckets[0], inputTokens: 10 }] },
    ] as TaskCostRowWire[]
    live.usage({ hostname: 'h', buckets })
    await view.refreshCosts(async () => costs)
    expect(view.projects?.attributedPercent).toBeCloseTo(50)
    const total = view.projects?.windowTotalUsd

    // A newer usage push alone does not move the denominator...
    live.usage({ hostname: 'h', buckets: buckets.map((b) => ({ ...b, inputTokens: 40 })) })
    expect(view.summary.week.estCostUsd).toBeCloseTo((total ?? 0) * 2)
    expect(view.projects?.windowTotalUsd).toBe(total)
    expect(view.projects?.attributedPercent).toBeCloseTo(50)
    // ...a failed cost read neither...
    await view.refreshCosts(async () => {
      throw new Error('cost failed')
    })
    expect(view.projects?.attributedPercent).toBeCloseTo(50)
    // ...and the next request, asked against the newer usage, does (positive control).
    await view.refreshCosts(async () => costs)
    expect(view.projects?.attributedPercent).toBeCloseTo(25)
  } finally {
    clock.mockRestore()
  }
})

it('keeps the loading calendar at the opening time until a usage value arrives', () => {
  const openedAt = new Date(2026, 10, 11, 12).getTime()
  const clock = vi.spyOn(Date, 'now').mockReturnValue(openedAt)
  try {
    const later = openedAt + 24 * 3_600_000
    const { live, view } = open(() => later)
    clock.mockReturnValue(later)
    expect(view.summary.days.at(-1)?.hours[0]?.startMs).toBe(new Date(2026, 10, 11).getTime())
    live.usage({ hostname: 'h', buckets: [] })
    expect(view.summary.days.at(-1)?.hours[0]?.startMs).toBe(new Date(2026, 10, 12).getTime())
  } finally {
    clock.mockRestore()
  }
})

it('shows the demo figures in place of the live values', () => {
  const { view } = open()
  view.showFixture(buckets, machines)
  expect(view.buckets).toBe(buckets)
  expect(view.quota).toBe(machines)
  expect(view.usageFailed).toBe(false)
  expect(view.quotaFailed).toBe(false)
})
