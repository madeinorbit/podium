import { TaskCostModel } from '@podium/client-graph/task-cost-model'
import type { TaskCostComparisonWire } from '@podium/model'
import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import type { ReactNode } from 'react'
import { afterEach, expect, it, vi } from 'vitest'

vi.mock('expo-haptics', () => ({ ImpactFeedbackStyle: { Light: 'light' } }))
vi.mock('@expo/ui/swift-ui/modifiers', () =>
  Object.fromEntries(
    [
      'accessibilityHidden',
      'alignmentGuide',
      'accessibilityIdentifier',
      'accessibilityLabel',
      'buttonStyle',
      'fixedSize',
      'font',
      'foregroundStyle',
      'frame',
      'listRowInsets',
      'monospacedDigit',
      'opacity',
      'padding',
    ].map((name) => [name, (value: unknown) => ({ [name]: value })]),
  ),
)
vi.mock('@expo/ui/swift-ui', () => {
  const Box = ({ children }: { children?: ReactNode }) => <div>{children}</div>
  const Leaf = ({
    children,
    modifiers,
  }: {
    children?: ReactNode
    modifiers?: Record<string, unknown>[]
  }) => (
    <span
      data-testid={
        modifiers?.find((modifier) => 'accessibilityIdentifier' in modifier)
          ?.accessibilityIdentifier as string
      }
    >
      {children}
    </span>
  )
  return { HStack: Box, VStack: Box, Text: Leaf, Rectangle: Leaf, Button: Box }
})

import { CostReading } from './CostReading'
import { CostReading as NativeCostReading } from './CostReading.ios'

let model: TaskCostModel | undefined
afterEach(() => {
  cleanup()
  model?.close()
  model = undefined
})

const pending: TaskCostComparisonWire = {
  task: {
    issueId: 'pending-task' as never,
    state: 'pending',
    own: { models: [], messages: 0, sessionCount: 1 },
    rollup: { models: [], messages: 0, sessionCount: 1 },
    descendantCount: 0,
    provisional: false,
    floor: 'partial',
    harnesses: ['codex'],
    uncostedSessionCount: 1,
    sessions: [],
  },
  cohort: { taskCount: 0, medianUsdPerReply: null },
}

it.each([
  ['generic', CostReading],
  ['iOS', NativeCostReading],
] as const)('%s holds a completed pending answer as the desktop unfilled reading', async (_, Reading) => {
  const read = vi.fn().mockResolvedValue(pending)
  model = new TaskCostModel(read, 'pending-task', false)
  model.open()
  const rendered = render(<Reading model={model} />)
  act(() => model?.setVisible(true))
  await waitFor(() => expect(model?.view?.state).toBe('pending'))

  expect(model.loading).toBe(false)
  expect(read).toHaveBeenCalledExactlyOnceWith({
    issueId: 'pending-task',
    includeSessions: false,
  })
  expect(screen.getByText('Estimated cost')).toBeTruthy()
  expect(screen.getByTestId('issue-cost-unfilled')).toBeTruthy()
  expect(screen.queryByTestId('issue-cost-value')).toBeNull()
  expect(rendered.container.textContent).not.toMatch(
    /Loading|Not recorded|Unavailable|\$|at list price/,
  )
  expect(screen.queryByRole('button', { name: /cost/i })).toBeNull()
  expect(screen.queryByRole('progressbar')).toBeNull()
})
