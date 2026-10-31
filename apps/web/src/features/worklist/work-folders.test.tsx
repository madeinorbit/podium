import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ClosedLaneHeader, ProjectFolderHeader } from './work-folders'

const branchMenu = vi.hoisted(() => ({ loads: 0 }))
vi.mock('@/lib/BaseBranchMenu', () => {
  branchMenu.loads++
  return {
    RepoBaseBranchMenu: ({ onDone }: { onDone: () => void }) => (
      <button type="button" onClick={onDone}>
        Finish branch change
      </button>
    ),
  }
})

afterEach(cleanup)

it('loads the base-branch editor only after choosing it and closes it on completion', async () => {
  render(
    <ProjectFolderHeader
      label="Project"
      count={1}
      collapsed={false}
      onToggle={vi.fn()}
      menu={{
        onToggle: vi.fn(),
        repo: { repoId: 'project', path: '/repo' },
      }}
    />,
  )
  expect(branchMenu.loads).toBe(0)
  fireEvent.click(screen.getByRole('button', { name: 'Project options' }))
  const openBranch = await screen.findByRole('menuitem', { name: 'Base branch…' })
  expect(branchMenu.loads).toBe(0)
  fireEvent.click(openBranch)
  const done = await screen.findByRole('button', { name: 'Finish branch change' })
  expect(branchMenu.loads).toBe(1)
  fireEvent.click(done)
  await waitFor(() =>
    expect(screen.queryByRole('button', { name: 'Finish branch change' })).toBeNull(),
  )
})

describe('Closed lane summary', () => {
  it('shows the count, retention note and archive action', () => {
    const archive = vi.fn()
    render(<ClosedLaneHeader count={5} onArchiveAll={archive} onUndo={vi.fn()} />)
    expect(screen.getByText('5 closed this week')).toBeTruthy()
    expect(screen.getByText('Cleared after 7 days')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Archive all 5 closed tasks' }))
    expect(archive).toHaveBeenCalledTimes(1)
  })

  it('uses singular task labels and replaces the action with Undo', () => {
    const undo = vi.fn()
    const { rerender } = render(<ClosedLaneHeader count={1} onArchiveAll={vi.fn()} onUndo={undo} />)
    screen.getByRole('button', { name: 'Archive all 1 closed task' }).focus()
    rerender(<ClosedLaneHeader count={0} archivedCount={1} onArchiveAll={vi.fn()} onUndo={undo} />)
    expect(screen.getByText('1 task archived')).toBeTruthy()
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Undo' }))
    expect(screen.queryByTestId('closed-issues-archive-all')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Undo' }))
    expect(undo).toHaveBeenCalledTimes(1)
  })

  it('shows Archiving and disables Undo until receipts arrive', () => {
    const undo = vi.fn()
    const { rerender } = render(
      <ClosedLaneHeader
        count={0}
        archivedCount={2}
        archiving
        onArchiveAll={vi.fn()}
        onUndo={undo}
      />,
    )
    expect(screen.getByText('Archiving…')).toBeTruthy()
    const button = screen.getByRole('button', { name: 'Undo' }) as HTMLButtonElement
    expect(button.disabled).toBe(true)
    fireEvent.click(button)
    expect(undo).not.toHaveBeenCalled()
    rerender(<ClosedLaneHeader count={0} archivedCount={2} onArchiveAll={vi.fn()} onUndo={undo} />)
    expect(screen.getByText('2 tasks archived')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Undo' }))
    expect(undo).toHaveBeenCalledTimes(1)
  })

  it('shows no card when there are no closed tasks or pending Undo', () => {
    render(<ClosedLaneHeader count={0} onArchiveAll={vi.fn()} onUndo={vi.fn()} />)
    expect(screen.queryByTestId('closed-lane-header')).toBeNull()
  })
})
