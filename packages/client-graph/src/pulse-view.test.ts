import type { TaskCostRowWire, UsageBucketWire } from '@podium/model'
import { autorun } from 'mobx'
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

it('joins refreshes, reads costs after harvest, and publishes both atomically', async () => {
  const view = open()
  const usage = deferred<{ buckets: UsageBucketWire[] }>()
  const costs = deferred<TaskCostRowWire[]>()
  const readUsage = vi.fn(() => usage.promise)
  const readCosts = vi.fn(() => costs.promise)
  const seen: unknown[] = []
  const stop = autorun(() => seen.push([view.answer?.buckets, view.costs.answer]))
  const first = view.refresh(readUsage, readCosts)
  expect(view.refresh(readUsage, readCosts)).toBe(first)
  expect(readUsage).toHaveBeenCalledTimes(1)
  expect(readCosts).not.toHaveBeenCalled()
  usage.resolve({ buckets })
  await Promise.resolve()
  expect(readCosts).toHaveBeenCalledTimes(1)
  expect(view.answer).toBeUndefined()
  costs.resolve(tasks)
  await first
  expect(seen).toEqual([
    [undefined, undefined],
    [buckets, tasks],
  ])
  await view.refresh(
    async () => ({ buckets: [] }),
    async () => [],
  )
  expect(view.answer?.buckets).toEqual([])
  expect(view.costs.answer).toEqual([])
  stop()
  view.dispose()
})

it('keeps the last pair when a new cost read fails', async () => {
  const view = open()
  await view.refresh(
    async () => ({ buckets }),
    async () => tasks,
  )
  const before = view.answer
  await view.refresh(
    async () => ({ buckets: [] }),
    async () => {
      throw new Error('offline')
    },
  )
  expect(view.answer).toBe(before)
  expect(view.costs.answer).toBe(tasks)
  expect(view.error).toBe('offline')
  view.dispose()
})

it('fences both answers after blur while allowing a new focus to succeed', async () => {
  const view = open()
  const oldCosts = deferred<TaskCostRowWire[]>()
  const old = view.refresh(
    async () => ({ buckets }),
    () => oldCosts.promise,
  )
  await Promise.resolve()
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
