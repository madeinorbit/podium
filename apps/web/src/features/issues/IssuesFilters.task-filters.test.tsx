// @vitest-environment happy-dom

/**
 * MU-09 (POD-6294; design §2.2). On the Tasks view, Assigned to (Me, All users,
 * a member) and Show agent tasks are FILTERS: they sit in the Filter menu, the
 * trigger counts what differs from Reset, and Reset puts back Me with agent
 * tasks hidden. Display no longer carries Show agent tasks.
 */
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { makeIssue } from '@/lib/test-issue'
import { AnchoredIssueMenu, DisplayMenu, FilterMenu } from './IssuesFilters'
import { AssigneeAvatar } from './issue-glyphs'
import { DEFAULT_DISPLAY } from './issues-display'

afterEach(cleanup)

const shared = {
  shared: true,
  currentMemberId: 'mem_bob',
  members: [
    { id: 'mem_alice', displayName: 'Alice' },
    { id: 'mem_bob', displayName: 'Bob' },
  ],
} as unknown as Parameters<typeof FilterMenu>[0]['roster']

function menu(props: Partial<Parameters<typeof FilterMenu>[0]> = {}) {
  const handlers = {
    onChange: vi.fn(),
    onAssignedTo: vi.fn(),
    onShowAgentTasks: vi.fn(),
    onReset: vi.fn(),
  }
  render(
    <FilterMenu
      filter={{}}
      assignedTo="me"
      showAgentTasks={false}
      roster={shared}
      count={0}
      {...handlers}
      {...props}
    />,
  )
  fireEvent.click(screen.getByTestId('tasks-filter-trigger'))
  return handlers
}

it('offers Assigned to: Me, All users and the other members, by name', async () => {
  const { onAssignedTo } = menu()
  fireEvent.click(await screen.findByRole('menuitem', { name: 'Assigned to' }))
  expect(
    (await screen.findByRole('menuitemradio', { name: 'Me' })).getAttribute('aria-checked'),
  ).toBe('true')
  expect(screen.getByRole('menuitemradio', { name: 'Alice' })).toBeTruthy()
  // The viewer is "Me", not listed twice; no raw member id is shown.
  expect(screen.queryByRole('menuitemradio', { name: 'Bob' })).toBeNull()
  expect(screen.queryByText('mem_alice')).toBeNull()
  fireEvent.click(screen.getByRole('menuitemradio', { name: 'All users' }))
  expect(onAssignedTo).toHaveBeenCalledWith('all')
})

it('carries Show agent tasks as a filter', async () => {
  const { onShowAgentTasks } = menu()
  fireEvent.click(await screen.findByRole('menuitemcheckbox', { name: 'Show agent tasks' }))
  expect(onShowAgentTasks).toHaveBeenCalledWith(true)
})

it('counts active filters on the trigger and resets them', async () => {
  const { onReset } = menu({ assignedTo: 'all', showAgentTasks: true, count: 2 })
  expect(screen.getByTestId('tasks-filter-count').textContent).toBe('2')
  fireEvent.click(await screen.findByRole('menuitem', { name: 'Reset filters' }))
  expect(onReset).toHaveBeenCalled()
})

it('shows no count and no Reset at the default', async () => {
  menu()
  await screen.findByRole('menuitemcheckbox', { name: 'Show agent tasks' })
  expect(screen.queryByTestId('tasks-filter-count')).toBeNull()
  expect(screen.queryByRole('menuitem', { name: 'Reset filters' })).toBeNull()
})

it('offers no Assigned to on a one-member instance', async () => {
  menu({
    roster: { ...shared, shared: false } as Parameters<typeof FilterMenu>[0]['roster'],
  })
  await screen.findByRole('menuitemcheckbox', { name: 'Show agent tasks' })
  expect(screen.queryByRole('menuitem', { name: 'Assigned to' })).toBeNull()
})

it('no longer lists Show agent tasks under Display', async () => {
  render(<DisplayMenu display={DEFAULT_DISPLAY} onChange={() => {}} showLayout />)
  fireEvent.click(screen.getByTitle('Display'))
  await screen.findByRole('menuitemradio', { name: /priority/i })
  expect(screen.queryByRole('menuitemcheckbox', { name: 'Show agent tasks' })).toBeNull()
})

it('Set assignee picks from the active members by name and writes the member id', async () => {
  const onSetAssignee = vi.fn()
  const issue = makeIssue({ id: 'a', assignee: 'mem_alice' } as Parameters<typeof makeIssue>[0])
  render(
    <AnchoredIssueMenu
      issue={issue}
      kind="a"
      roster={shared}
      labelPool={[]}
      onMoveIssue={() => {}}
      onSetPriority={() => {}}
      onSetAssignee={onSetAssignee}
      onToggleLabel={() => {}}
      onClose={() => {}}
    />,
  )
  fireEvent.click(await screen.findByRole('menuitem', { name: 'Bob' }))
  expect(onSetAssignee).toHaveBeenCalledWith('a', 'mem_bob')
  expect(screen.getByRole('menuitem', { name: 'Alice' })).toBeTruthy()
  expect(screen.queryByText('mem_alice')).toBeNull()
})

it('names the assignee on a row by display name, not the member id', () => {
  render(<AssigneeAvatar assignee="mem_alice" name="Alice Smith" />)
  const avatar = screen.getByLabelText('Assignee: Alice Smith')
  expect(avatar.textContent).toBe('AS')
})
