import type { TaskCostComparisonWire } from '@podium/model/browser'
import { afterEach, expect, it, vi } from 'vitest'
import { TaskCostModel } from './task-cost-model'

export const answer = (inputTokens = 1_000_000): TaskCostComparisonWire => ({
  task: {
    issueId: 'cost-model' as TaskCostComparisonWire['task']['issueId'], state: 'costed',
    own: { models: [], messages: 0, sessionCount: 0 },
    rollup: { models: [{ model: 'claude-opus-5', inputTokens, outputTokens: 0,
      cacheReadTokens: 0, cacheCreationTokens: 0, cacheCreation1hTokens: 0, messages: 25 }],
      messages: 25, sessionCount: 1 },
    descendantCount: 1, provisional: false, floor: 'none', harnesses: [],
    uncostedSessionCount: 0, sessions: [],
  },
  cohort: { medianUsdPerReply: 0.1, taskCount: 3 },
})
function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
afterEach(() => vi.useRealTimers())

it('requests only while open and visible, then drops the answer on close', async () => {
  vi.useFakeTimers()
  const read = vi.fn(async () => answer())
  const model = new TaskCostModel(read, 'cost-model', false)
  await model.refresh()
  expect(read).not.toHaveBeenCalled()
  model.open()
  expect(read).not.toHaveBeenCalled()
  model.setVisible(true)
  await Promise.resolve()
  expect(read).toHaveBeenCalledExactlyOnceWith({ issueId: 'cost-model', includeSessions: false })
  expect(model.view?.rateVsMedian).toBe(2)
  model.setVisible(false)
  await vi.advanceTimersByTimeAsync(180_000)
  expect(read).toHaveBeenCalledTimes(1)
  model.setVisible(true)
  await Promise.resolve()
  await vi.advanceTimersByTimeAsync(90_000)
  expect(read).toHaveBeenCalledTimes(3)
  model.close()
  expect(model.view).toBeNull()
  await vi.advanceTimersByTimeAsync(180_000)
  expect(read).toHaveBeenCalledTimes(3)
})

it('ignores superseded responses and a response after close', async () => {
  const first = deferred<TaskCostComparisonWire>()
  const second = deferred<TaskCostComparisonWire>()
  const read = vi.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise)
  const model = new TaskCostModel(read, 'cost-model')
  model.open(); model.setVisible(true)
  const fresh = model.refresh()
  second.resolve(answer(2_000_000)); await fresh
  first.resolve(answer()); await Promise.resolve()
  expect(model.view?.rollup.estCostUsd).toBe(10)
  const late = deferred<TaskCostComparisonWire>()
  read.mockReturnValueOnce(late.promise)
  const pending = model.refresh()
  model.close(); late.resolve(answer()); await pending
  expect(model.view).toBeNull()
  expect(model.loading).toBe(false)
})

it('keeps the last total on a failed refresh and retries, including sync throws', async () => {
  const read = vi.fn().mockResolvedValueOnce(answer()).mockImplementationOnce(() => {
    throw new Error('offline')
  }).mockResolvedValueOnce(answer(2_000_000))
  const model = new TaskCostModel(read, 'cost-model')
  model.open(); model.setVisible(true); await Promise.resolve()
  await model.refresh()
  expect(model.error).toBe('offline')
  expect(model.loading).toBe(false)
  expect(model.view?.rollup.estCostUsd).toBe(5)
  await model.refresh()
  expect(model.error).toBeNull()
  expect(model.view?.rollup.estCostUsd).toBe(10)
  model.close()
})
