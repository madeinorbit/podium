// @vitest-environment happy-dom
import { asIssueId, type TaskCostComparisonWire } from '@podium/model/browser'
import { act, cleanup, render, renderHook } from '@testing-library/react'
import { observer } from 'mobx-react-lite'
import { afterEach, expect, it, vi } from 'vitest'
import type { Trpc } from '@/app/trpc'
import { useTaskCost } from './useTaskCost'
import { useMissionCost } from './useMissionCost'
import { resetPolledQueryCache } from '@/lib/use-polled-query'

function answer(issueId = 'one'): TaskCostComparisonWire {
  const models = [{ model: 'claude-opus-5', inputTokens: 1_000_000, outputTokens: 0,
    cacheReadTokens: 0, cacheCreationTokens: 0, cacheCreation1hTokens: 0, messages: 25 }]
  return { task: { issueId: asIssueId(issueId), state: 'costed',
    own: { models, messages: 25, sessionCount: 1 },
    rollup: { models, messages: 25, sessionCount: 1 },
    descendantCount: 0, provisional: false, floor: 'none', harnesses: [],
    uncostedSessionCount: 0, sessions: [] },
    cohort: { medianUsdPerReply: 0.1, taskCount: 3 } }
}
function setup() {
  const comparison = vi.fn(async ({ issueId }: { issueId: string }) => answer(issueId))
  const tasks = vi.fn(() => { throw new Error('corpus must not be requested') })
  const task = vi.fn(async () => answer().task)
  const trpc = { cost: { taskComparison: { query: comparison }, tasks: { query: tasks },
    task: { query: task } } } as unknown as Trpc
  return { trpc, comparison, tasks, task }
}
afterEach(() => { cleanup(); resetPolledQueryCache() })
async function settled() { await act(async () => { await Promise.resolve() }) }

it('opens and reopens one task with a fresh small answer, never cost.tasks', async () => {
  const ctx = setup()
  const first = renderHook(() => useTaskCost(ctx.trpc, asIssueId('one')))
  await settled()
  expect(first.result.current.view?.rateVsMedian).toBe(2)
  expect(ctx.comparison).toHaveBeenCalledTimes(1)
  expect(ctx.task).not.toHaveBeenCalled()
  expect(ctx.tasks).not.toHaveBeenCalled()
  first.unmount()
  const second = renderHook(() => useTaskCost(ctx.trpc, asIssueId('one')))
  expect(second.result.current.view).toBeNull()
  await settled()
  expect(ctx.comparison).toHaveBeenCalledTimes(2)
})

it('does not load without an addressed task and replaces the owner on navigation', async () => {
  const ctx = setup()
  const hook = renderHook(({ id }) => useTaskCost(ctx.trpc, id === null ? null : asIssueId(id)),
    { initialProps: { id: null as string | null } })
  expect(ctx.comparison).not.toHaveBeenCalled()
  hook.rerender({ id: 'one' }); await settled()
  hook.rerender({ id: 'two' })
  expect(hook.result.current.view).toBeNull()
  await settled()
  expect(ctx.comparison.mock.calls.map(([input]) => input.issueId)).toEqual(['one', 'two'])
  expect(ctx.tasks).not.toHaveBeenCalled()
})

it('owns the mission comparison only while the popover is open', async () => {
  const ctx = setup()
  let current: ReturnType<typeof useMissionCost> | undefined
  const Probe = observer(({ open }: { open: boolean }) => {
    current = useMissionCost(ctx.trpc, 'one', open)
    return null
  })
  const hook = render(<Probe open={false} />)
  await settled()
  expect(ctx.comparison).not.toHaveBeenCalled()
  hook.rerender(<Probe open />); await settled()
  expect(current?.view?.rateVsMedian).toBe(2)
  expect(ctx.comparison).toHaveBeenCalledExactlyOnceWith({ issueId: 'one', includeSessions: false })
  hook.rerender(<Probe open={false} />)
  expect(current?.view?.rateVsMedian).toBeNull()
  hook.rerender(<Probe open />); await settled()
  expect(ctx.comparison).toHaveBeenCalledTimes(2)
  expect(ctx.tasks).not.toHaveBeenCalled()
})
