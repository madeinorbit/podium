import type { IssueNavigationModel } from '@podium/client-core/values'
import { LOADING } from '@podium/client-graph/worklist/rollup'
import { asIssueId } from '@podium/model'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { ReactNode } from 'react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

const facts = vi.hoisted(() => ({ read: vi.fn() }))
vi.mock('../client/use-issue-close', () => ({ useIssueCloseConcerns: facts.read }))
vi.mock('@expo/ui', () => ({ Host: ({ children }: { children: ReactNode }) => children }))
vi.mock('@expo/ui/swift-ui/modifiers', () => ({
  ...Object.fromEntries(
    [
      'accessibilityIdentifier',
      'disabled',
      'font',
      'foregroundStyle',
      'navigationBarTitleDisplayMode',
      'navigationTitle',
      'presentationDetents',
      'presentationDragIndicator',
    ].map((name) => [name, (value: unknown) => ({ name, value })]),
  ),
}))
vi.mock('@expo/ui/swift-ui', () => {
  const Box = ({ children }: { children?: ReactNode }) => <>{children}</>
  return {
    BottomSheet: ({
      isPresented,
      onIsPresentedChange,
      onDismiss,
      children,
    }: {
      isPresented: boolean
      onIsPresentedChange: (open: boolean) => void
      onDismiss: () => void
      children: ReactNode
    }) => (
      <div data-testid="native-close" data-presented={isPresented}>
        <button type="button" onClick={() => onIsPresentedChange(false)}>
          Drag dismiss
        </button>
        {children}
        <button type="button" onClick={onDismiss}>
          Finish dismissal
        </button>
      </div>
    ),
    Button: ({
      label,
      role,
      onPress,
      modifiers = [],
    }: {
      label: string
      role?: string
      onPress: () => void
      modifiers?: { name: string; value: unknown }[]
    }) => (
      <button
        type="button"
        data-native-role={role}
        onClick={onPress}
        disabled={Boolean(modifiers.find((item) => item.name === 'disabled')?.value)}
      >
        {label}
      </button>
    ),
    Form: Box,
    Group: Box,
    NavigationStack: Box,
    Section: ({
      title,
      footer,
      children,
    }: {
      title?: string
      footer?: string
      children: ReactNode
    }) => (
      <section>
        <h2>{title}</h2>
        {children}
        <p>{footer}</p>
      </section>
    ),
    Text: ({ children }: { children?: ReactNode }) => <span>{children}</span>,
    Toolbar: Object.assign(Box, { Content: Box }),
    ToolbarItem: Box,
    VStack: Box,
  }
})

import { IssueCloseSheet } from './IssueCloseSheet.ios'

const issue = { id: asIssueId('task') } as IssueNavigationModel
const concern = {
  key: 'sessions',
  icon: 'sessions',
  label: '1 working agent',
  detail: 'Closing stops this agent.',
}

beforeEach(() => facts.read.mockReset().mockReturnValue([concern]))
afterEach(cleanup)

it('waits for live close facts, then keeps the native warning current', () => {
  const props = { issue, reason: 'done' as const, onClose: vi.fn(), onConfirm: vi.fn() }
  facts.read.mockReturnValue(LOADING)
  const view = render(<IssueCloseSheet {...props} />)
  fireEvent.click(screen.getByRole('button', { name: 'Close task' }))
  expect(props.onConfirm).not.toHaveBeenCalled()
  expect(screen.getByText('Checking this task…')).toBeTruthy()

  facts.read.mockReturnValue([concern])
  view.rerender(<IssueCloseSheet {...props} />)
  expect(screen.getByText('1 working agent')).toBeTruthy()
  expect(
    screen.getByRole('button', { name: 'Close anyway' }).getAttribute('data-native-role'),
  ).toBe('destructive')

  facts.read.mockReturnValue([])
  view.rerender(<IssueCloseSheet {...props} />)
  expect(screen.queryByText('1 working agent')).toBeNull()
  expect(screen.getByRole('button', { name: 'Close task' }).hasAttribute('disabled')).toBe(false)
})

it('confirms the selected ending once, after native dismissal', () => {
  const onClose = vi.fn()
  const onConfirm = vi.fn()
  render(
    <IssueCloseSheet issue={issue} reason="cancelled" onClose={onClose} onConfirm={onConfirm} />,
  )
  fireEvent.click(screen.getByRole('button', { name: 'Close as cancelled' }))
  expect(screen.getByTestId('native-close').getAttribute('data-presented')).toBe('false')
  expect(onClose).not.toHaveBeenCalled()
  expect(onConfirm).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button', { name: 'Finish dismissal' }))
  fireEvent.click(screen.getByRole('button', { name: 'Finish dismissal' }))
  expect(onClose).toHaveBeenCalledTimes(1)
  expect(onConfirm).toHaveBeenCalledExactlyOnceWith('cancelled')
  const [closedAt = 0] = onClose.mock.invocationCallOrder
  const [confirmedAt = 0] = onConfirm.mock.invocationCallOrder
  expect(closedAt).toBeLessThan(confirmedAt)
})

it.each(['Keep open', 'Drag dismiss'])('%s dismisses without closing the task', (label) => {
  const onClose = vi.fn()
  const onConfirm = vi.fn()
  render(<IssueCloseSheet issue={issue} reason="done" onClose={onClose} onConfirm={onConfirm} />)
  fireEvent.click(screen.getByRole('button', { name: label }))
  fireEvent.click(screen.getByRole('button', { name: 'Finish dismissal' }))
  expect(onClose).toHaveBeenCalledOnce()
  expect(onConfirm).not.toHaveBeenCalled()
})

it('does not request close facts while down', () => {
  render(<IssueCloseSheet issue={issue} reason={null} onClose={vi.fn()} onConfirm={vi.fn()} />)
  expect(facts.read).not.toHaveBeenCalled()
  expect(screen.queryByTestId('native-close')).toBeNull()
})
