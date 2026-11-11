import type { TaskCostRowWire, UsageBucketWire } from '@podium/model'
import { expect, it, vi } from 'vitest'
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
const tasks = [{ issueId: 'task' }] as TaskCostRowWire[]
const open = () => new PulseView(new MobxPool({ selectedIssueId: null, coarseNow: 0 }))

it('joins refreshes and publishes usage before the dependent cost read settles', async () => {
  const view = open()
  const usage = deferred<{ buckets: UsageBucketWire[] }>()
  const costs = deferred<TaskCostRowWire[]>()
  const readUsage = vi.fn(() => usage.promise)
  const readCosts = vi.fn(() => costs.promise)
  const first = view.refresh(readUsage, readCosts)
  expect(view.refresh(readUsage, readCosts)).toBe(first)
  expect(readUsage).toHaveBeenCalledTimes(1)
  expect(readCosts).not.toHaveBeenCalled()
  usage.resolve({ buckets })
  await vi.waitFor(() => expect(readCosts).toHaveBeenCalledTimes(1))
  expect(readCosts).toHaveBeenCalledTimes(1)
  expect(view.answer?.buckets).toBe(buckets)
  costs.resolve(tasks)
  await first
  expect(view.costs.answer).toBe(tasks)
  await view.refresh(
    async () => ({ buckets: [] }),
    async () => [],
  )
  expect(view.answer?.buckets).toEqual([])
  expect(view.costs.answer).toEqual([])
  view.dispose()
})

it('keeps successful usage and the last cost answer when a new cost read fails', async () => {
  const view = open()
  await view.refresh(
    async () => ({ buckets }),
    async () => tasks,
  )
  await view.refresh(
    async () => ({ buckets: [] }),
    async () => {
      throw new Error('offline')
    },
  )
  expect(view.answer?.buckets).toEqual([])
  expect(view.costs.answer).toBe(tasks)
  expect(view.error).toBeNull()
  expect(view.costs.error).toBe('offline')
  view.dispose()
})

it('fences both answers after blur while allowing a new focus to succeed', async () => {
  const view = open()
  const oldCosts = deferred<TaskCostRowWire[]>()
  const readOldCosts = vi.fn(() => oldCosts.promise)
  const old = view.refresh(async () => ({ buckets }), readOldCosts)
  await vi.waitFor(() => expect(readOldCosts).toHaveBeenCalledTimes(1))
  view.cancel()
  await view.refresh(
    async () => ({ buckets: [] }),
    async () => [],
  )
  oldCosts.resolve(tasks)
  await old
  expect(view.answer?.buckets).toEqual([])
  expect(view.costs.answer).toEqual([])
  view.dispose()
})

it('keeps the loading calendar at the opening time until a harvest arrives', async () => {
  const openedAt = new Date(2026, 10, 11, 12).getTime()
  const clock = vi.spyOn(Date, 'now').mockReturnValue(openedAt)
  const view = open()
  try {
    clock.mockReturnValue(openedAt + 24 * 3_600_000)
    expect(view.summary.days.at(-1)?.hours[0]?.startMs).toBe(new Date(2026, 10, 11).getTime())
    await view.refresh(
      async () => ({ buckets: [] }),
      async () => [],
    )
    expect(view.summary.days.at(-1)?.hours[0]?.startMs).toBe(new Date(2026, 10, 12).getTime())
  } finally {
    view.dispose()
    clock.mockRestore()
  }
})

it('keeps quota and usage on a first cost failure, and clears only the recovered error', async () => {
  const view = open()
  await view.refresh(
    async () => ({ buckets }),
    async () => {
      throw new Error('cost failed')
    },
    async () => [],
  )
  expect(view.answer?.buckets).toBe(buckets)
  expect(view.quota.answer).toEqual([])
  expect(view.quota.error).toBeNull()
  expect(view.costs.answer).toBeUndefined()
  expect(view.costs.error).toBe('cost failed')
  expect(view.projects).toBeNull()
  await view.refresh(
    async () => ({ buckets }),
    async () => [],
    async () => {
      throw new Error('quota failed')
    },
  )
  expect(view.costs.error).toBeNull()
  expect(view.costs.answer).toEqual([])
  expect(view.quota.answer).toEqual([])
  expect(view.quota.error).toBe('quota failed')
  view.dispose()
})

it('reports first quota failure independently and still harvests usage and costs', async () => {
  const view = open()
  await view.refresh(
    async () => ({ buckets }),
    async () => tasks,
    async () => {
      throw new Error('quota failed')
    },
  )
  expect(view.quota.answer).toBeUndefined()
  expect(view.quota.error).toBe('quota failed')
  expect(view.answer?.buckets).toBe(buckets)
  expect(view.costs.answer).toBe(tasks)
  expect(view.error).toBeNull()
  view.dispose()
})

it('does not start costs after a failed harvest, while quota still succeeds', async () => {
  const view = open()
  const readCosts = vi.fn(async () => tasks)
  await view.refresh(
    async () => {
      throw new Error('usage failed')
    },
    readCosts,
    async () => [],
  )
  expect(view.error).toBe('usage failed')
  expect(view.costs.error).toBe('usage failed')
  expect(view.quota.answer).toEqual([])
  expect(readCosts).not.toHaveBeenCalled()
  view.dispose()
})

it('does not start costs after blur during usage; a new focus may read normally', async () => {
  const view = open()
  const oldUsage = deferred<{ buckets: UsageBucketWire[] }>()
  const oldQuota = deferred<never[]>()
  const readCosts = vi.fn(async () => tasks)
  const old = view.refresh(
    () => oldUsage.promise,
    readCosts,
    () => oldQuota.promise,
  )
  view.cancel()
  await view.refresh(
    async () => ({ buckets: [] }),
    async () => [],
    async () => {
      throw new Error('new quota')
    },
  )
  oldUsage.resolve({ buckets })
  oldQuota.resolve([])
  await old
  expect(readCosts).not.toHaveBeenCalled()
  expect(view.answer?.buckets).toEqual([])
  expect(view.costs.answer).toEqual([])
  expect(view.quota.answer).toBeUndefined()
  expect(view.quota.error).toBe('new quota')
  view.dispose()
})

it('holds attribution against the matched harvest while newer usage succeeds alone', async () => {
  const clock = vi.spyOn(Date, 'now').mockReturnValue(Date.parse('2026-11-11T12:00:00Z'))
  const pool = new MobxPool({ selectedIssueId: null, coarseNow: 0 })
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
  const view = new PulseView(pool)
  const costs = [
    { issueId: 'task', windowModels: [{ ...buckets[0], inputTokens: 10 }] },
  ] as TaskCostRowWire[]
  try {
    await view.refresh(
      async () => ({ buckets }),
      async () => costs,
    )
    expect(view.projects?.attributedPercent).toBeCloseTo(50)
    const total = view.projects?.windowTotalUsd
    const pendingCosts = deferred<TaskCostRowWire[]>()
    const pending = view.refresh(
      async () => ({ buckets: buckets.map((bucket) => ({ ...bucket, inputTokens: 40 })) }),
      () => pendingCosts.promise,
    )
    await vi.waitFor(() => expect(view.summary.week.estCostUsd).toBeCloseTo((total ?? 0) * 2))
    expect(view.projects?.attributedPercent).toBeCloseTo(50)
    pendingCosts.reject(new Error('cost failed'))
    await pending
    expect(view.projects?.windowTotalUsd).toBe(total)
    expect(view.projects?.attributedPercent).toBeCloseTo(50)
    // Positive control: the next successful pair must advance the denominator.
    await view.refresh(
      async () => ({ buckets: buckets.map((bucket) => ({ ...bucket, inputTokens: 40 })) }),
      async () => costs,
    )
    expect(view.projects?.attributedPercent).toBeCloseTo(25)
  } finally {
    view.dispose()
    pool.dispose()
    clock.mockRestore()
  }
})

it('retries quota while costs remain pending and coalesces only other quota reads', async () => {
  const view = open()
  const costs = deferred<TaskCostRowWire[]>()
  const readCosts = vi.fn(() => costs.promise)
  const readUsage = vi.fn(async () => ({ buckets }))
  const first = view.refresh(readUsage, readCosts, async () => {
    throw new Error('quota failed')
  })
  await vi.waitFor(() => {
    expect(view.quota.error).toBe('quota failed')
    expect(readCosts).toHaveBeenCalledTimes(1)
  })
  expect(view.costs.loading).toBe(true)
  const quota = deferred<never[]>()
  const readQuota = vi.fn(() => quota.promise)
  const retry = view.refreshQuota(readQuota)
  expect(readQuota).toHaveBeenCalledTimes(1)
  // Positive control: repeated quota taps still join their own pending request.
  expect(view.refreshQuota(readQuota)).toBe(retry)
  expect(readQuota).toHaveBeenCalledTimes(1)
  quota.resolve([])
  await retry
  expect(view.quota.answer).toEqual([])
  expect(view.quota.error).toBeNull()
  expect(view.costs.loading).toBe(true)
  expect(readUsage).toHaveBeenCalledTimes(1)
  expect(readCosts).toHaveBeenCalledTimes(1)
  costs.resolve(tasks)
  await first
  expect(view.costs.answer).toBe(tasks)
  view.dispose()
})

it.each([
  'usage',
  'costs',
] as const)('retries failed %s while quota remains pending, keeping the harvest before costs', async (failure) => {
  const view = open()
  const quota = deferred<never[]>()
  const readQuota = vi.fn(() => quota.promise)
  const first = view.refresh(
    async () => {
      if (failure === 'usage') throw new Error('usage failed')
      return { buckets }
    },
    async () => {
      throw new Error('costs failed')
    },
    readQuota,
  )
  await vi.waitFor(() => expect(view.costs.error).toBe(`${failure} failed`))
  expect(view.quota.loading).toBe(true)
  const usage = deferred<{ buckets: UsageBucketWire[] }>()
  const costs = deferred<TaskCostRowWire[]>()
  const readUsage = vi.fn(() => usage.promise)
  const readCosts = vi.fn(() => costs.promise)
  const retry = view.refreshUsage(readUsage, readCosts)
  expect(readUsage).toHaveBeenCalledTimes(1)
  expect(view.refreshUsage(readUsage, readCosts)).toBe(retry)
  expect(readUsage).toHaveBeenCalledTimes(1)
  expect(readCosts).not.toHaveBeenCalled()
  usage.resolve({ buckets })
  await vi.waitFor(() => expect(readCosts).toHaveBeenCalledTimes(1))
  // Positive control: pending costs still coalesce the entire harvest pair.
  expect(view.refreshUsage(readUsage, readCosts)).toBe(retry)
  costs.resolve(tasks)
  await retry
  expect(view.answer?.buckets).toBe(buckets)
  expect(view.costs.answer).toBe(tasks)
  expect(view.error).toBeNull()
  expect(view.costs.error).toBeNull()
  expect(view.quota.loading).toBe(true)
  expect(readQuota).toHaveBeenCalledTimes(1)
  quota.resolve([])
  await first
  expect(view.quota.answer).toEqual([])
  view.dispose()
})

it('a full refresh starts a fresh quota read even while it joins pending usage', async () => {
  const view = open()
  const usage = deferred<{ buckets: UsageBucketWire[] }>()
  const readUsage = vi.fn(() => usage.promise)
  const readCosts = vi.fn(async () => tasks)
  const readQuota = vi.fn(async () => [])
  const first = view.refresh(readUsage, readCosts, readQuota)
  await vi.waitFor(() => expect(view.quota.loading).toBe(false))
  const next = view.refresh(readUsage, readCosts, readQuota)
  expect(readQuota).toHaveBeenCalledTimes(2)
  expect(readUsage).toHaveBeenCalledTimes(1)
  usage.resolve({ buckets })
  await Promise.all([first, next])
  expect(readCosts).toHaveBeenCalledTimes(1)
  view.dispose()
})
