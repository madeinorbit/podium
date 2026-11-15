import type { IssueNavigationModel } from '@podium/client-core/values'
import { asIssueId, issueStatusMenuEntries } from '@podium/model'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import type { ReactNode } from 'react'
import { afterEach, expect, it, vi } from 'vitest'

vi.mock('@expo/ui/swift-ui/modifiers', () => ({
  disabled: (value: boolean) => ({ disabled: value }),
}))
// Only the native boundary is replaced. These tests inspect the props SwiftUI
// receives; rendering the system checkmark still needs the isolated iOS pass.
vi.mock('@expo/ui/swift-ui', () => ({
  Menu: ({ label, children }: { label: string; children: ReactNode }) => (
    <div role="menu" aria-label={label}>
      {children}
    </div>
  ),
  Toggle: ({
    label,
    isOn,
    onIsOnChange,
    systemImage,
  }: {
    label: string
    isOn: boolean
    onIsOnChange: (isOn: boolean) => void
    systemImage?: string
  }) => (
    <button
      type="button"
      role="menuitemcheckbox"
      aria-checked={isOn}
      data-system-image={systemImage}
      onClick={() => onIsOnChange(!isOn)}
    >
      {label}
    </button>
  ),
  Button: ({ label, onPress }: { label: string; onPress: () => void }) => (
    <button type="button" onClick={onPress}>
      {label}
    </button>
  ),
}))

const { IssueRowMenuItems } = await import('./IssueRowMenuItems.ios')

const issue = (patch: Partial<IssueNavigationModel> = {}): IssueNavigationModel =>
  ({
    id: asIssueId('task'),
    stage: 'planning',
    closedReason: undefined,
    deletedAt: undefined,
    ...patch,
  }) as IssueNavigationModel

afterEach(cleanup)

it.each([
  ['backlog', undefined, 'Backlog'],
  ['planning', undefined, 'Planning'],
  ['in_progress', undefined, 'In Progress'],
  ['review', undefined, 'Review'],
  ['done', 'done', 'Done'],
  ['done', 'cancelled', 'Cancelled'],
  ['done', 'duplicate', 'Duplicate'],
  ['done', 'wontfix', 'Cancelled'],
] as const)('passes exactly one native on-state for %s/%s before interaction', (stage, closedReason, label) => {
  const onStatus = vi.fn()
  render(
    <IssueRowMenuItems
      issue={issue({ stage, closedReason })}
      lane="live"
      onAction={vi.fn()}
      onStatus={onStatus}
    />,
  )
  const menu = within(screen.getByRole('menu', { name: 'Status' }))
  expect(menu.getAllByRole('menuitemcheckbox')).toHaveLength(issueStatusMenuEntries().length)
  expect(menu.getAllByRole('menuitemcheckbox', { checked: true })).toEqual([
    menu.getByRole('menuitemcheckbox', { name: label }),
  ])
  // The checkmark must be menu state, never a label glyph or SF Symbol image.
  for (const item of menu.getAllByRole('menuitemcheckbox'))
    expect(item.hasAttribute('data-system-image')).toBe(false)
  expect(onStatus).not.toHaveBeenCalled()
})

it.each(issueStatusMenuEntries())('chooses $label through the existing status value', (entry) => {
  const onStatus = vi.fn()
  const onAction = vi.fn()
  render(
    <IssueRowMenuItems
      issue={issue({ stage: entry.status === 'planning' ? 'review' : 'planning' })}
      lane="live"
      onAction={onAction}
      onStatus={onStatus}
    />,
  )
  fireEvent.click(screen.getByRole('menuitemcheckbox', { name: entry.label }))
  expect(onStatus).toHaveBeenCalledExactlyOnceWith(entry.value)
  expect(onAction).not.toHaveBeenCalled()
})

it('keeps the current status selected when tapped again and follows a refreshed issue', () => {
  const onStatus = vi.fn()
  const props = { lane: 'live' as const, onAction: vi.fn(), onStatus }
  const view = render(<IssueRowMenuItems {...props} issue={issue()} />)
  fireEvent.click(screen.getByRole('menuitemcheckbox', { name: 'Planning' }))
  expect(onStatus).not.toHaveBeenCalled()
  expect(screen.getByRole('menuitemcheckbox', { name: 'Planning', checked: true })).toBeTruthy()

  fireEvent.click(screen.getByRole('menuitemcheckbox', { name: 'Review' }))
  expect(onStatus).toHaveBeenCalledExactlyOnceWith('stage:review')
  view.rerender(<IssueRowMenuItems {...props} issue={issue({ stage: 'review' })} />)
  expect(screen.getAllByRole('menuitemcheckbox', { checked: true })).toEqual([
    screen.getByRole('menuitemcheckbox', { name: 'Review' }),
  ])
  // Reopening creates a fresh native tree from the current shared issue value.
  view.unmount()
  render(<IssueRowMenuItems {...props} issue={issue({ stage: 'review' })} />)
  expect(screen.getAllByRole('menuitemcheckbox', { checked: true })).toEqual([
    screen.getByRole('menuitemcheckbox', { name: 'Review' }),
  ])
  expect(onStatus).toHaveBeenCalledTimes(1)
})
