import type { TaskCostComparisonWire } from '@podium/model'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { useSyncExternalStore } from 'react'
import { afterEach, expect, it, vi } from 'vitest'

const host = vi.hoisted(() => ({
  focused: true,
  app: 'active',
  listeners: new Set<() => void>(),
  read: vi.fn(),
}))
vi.mock('../../client/hooks', () => ({
  useTrpc: () => ({ cost: { taskComparison: { query: host.read } } }),
}))
vi.mock('../../client/projection-focus', () => ({
  useProjectionFocus: () =>
    useSyncExternalStore(
      (changed) => {
        host.listeners.add(changed)
        return () => host.listeners.delete(changed)
      },
      () => host.focused,
    ),
}))
vi.mock('react-native', async (original) => ({
  ...(await original<object>()),
  AppState: {
    get currentState() {
      return host.app
    },
    addEventListener: (_: string, listener: () => void) => {
      host.listeners.add(listener)
      return { remove: () => host.listeners.delete(listener) }
    },
  },
}))
vi.mock('expo-haptics', () => ({ ImpactFeedbackStyle: { Light: 'light' } }))

import { IssueCost } from './IssueCost'

afterEach(() => {
  cleanup()
  vi.useRealTimers()
  host.read.mockReset()
  host.focused = true
  host.app = 'active'
  host.listeners.clear()
})

function answer(state: TaskCostComparisonWire['task']['state'] = 'costed'): TaskCostComparisonWire {
  const models = [
    {
      model: 'claude-opus-5',
      inputTokens: 2_000_000,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      cacheCreation1hTokens: 0,
      messages: 25,
    },
  ]
  return {
    task: {
      issueId: 'cost-task' as never,
      state,
      own: { models: [], messages: 0, sessionCount: 1 },
      rollup: { models, messages: 25, sessionCount: 3 },
      descendantCount: 2,
      provisional: true,
      floor: 'partial',
      harnesses: ['codex'],
      uncostedSessionCount: 2,
      sessions: [],
    },
    cohort: { taskCount: 3, medianUsdPerReply: 0.1 },
  }
}

it('prices the attributed desktop rollup and preserves its estimate and floor wording', async () => {
  host.read.mockResolvedValue(answer())
  render(<IssueCost issueId="cost-task" />)
  await waitFor(() => expect(screen.getByTestId('issue-cost-value').textContent).toBe('≈$10'))
  expect(host.read).toHaveBeenCalledExactlyOnceWith({
    issueId: 'cost-task',
    includeSessions: false,
  })
  expect(screen.getByText('Estimated cost so far')).toBeTruthy()
  expect(screen.queryByText(/claude-opus-5/)).toBeNull()
  expect(screen.queryByText(/at list price for the same tokens/)).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: 'Show cost details' }))
  expect(screen.getByText('≥ floor · all Codex · 2 sessions unread')).toBeTruthy()
  expect(screen.getByText(/at list price for the same tokens/)).toBeTruthy()
})

it.each([
  'no-sessions',
  'not-recorded',
] as const)('shows %s as a state without inventing a zero', async (state) => {
  host.read.mockResolvedValue(answer(state))
  const view = render(<IssueCost issueId="cost-task" />)
  await act(async () => {})
  if (state === 'no-sessions') expect(screen.queryByTestId('issue-cost')).toBeNull()
  else expect(screen.getByTestId('issue-cost-value').textContent).toBe('Not recorded')
  expect(view.container.textContent).not.toContain('$')
  expect(view.container.textContent).not.toContain('at list price')
})

it('keeps failed cost distinct from missing spend and retries the shared procedure', async () => {
  host.read.mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce(answer())
  render(<IssueCost issueId="cost-task" />)
  fireEvent.click(await screen.findByRole('button', { name: 'Retry cost' }))
  await waitFor(() => expect(screen.getByTestId('issue-cost-value').textContent).toBe('≈$10'))
  expect(host.read).toHaveBeenCalledTimes(2)
})

it('pauses refresh while the route or app is hidden and releases demand on close', async () => {
  vi.useFakeTimers()
  host.read.mockResolvedValue(answer())
  host.focused = false
  const view = render(<IssueCost issueId="cost-task" />)
  expect(host.read).not.toHaveBeenCalled()
  host.focused = true
  act(() => {
    for (const listener of host.listeners) listener()
  })
  await act(async () => {})
  expect(host.read).toHaveBeenCalledTimes(1)
  host.app = 'background'
  act(() => {
    for (const listener of host.listeners) listener()
  })
  await act(async () => vi.advanceTimersByTimeAsync(180_000))
  expect(host.read).toHaveBeenCalledTimes(1)
  host.app = 'active'
  act(() => {
    for (const listener of host.listeners) listener()
  })
  await act(async () => {})
  expect(host.read).toHaveBeenCalledTimes(2)
  view.unmount()
  await vi.advanceTimersByTimeAsync(180_000)
  expect(host.read).toHaveBeenCalledTimes(2)
  expect(host.listeners.size).toBe(0)
})
