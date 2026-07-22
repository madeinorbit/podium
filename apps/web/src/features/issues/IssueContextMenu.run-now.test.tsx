import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { makeIssue } from '@/lib/test-issue'
import { IssueContextMenu } from './IssueContextMenu'

vi.mock('@/lib/use-feature', () => ({ useFeature: () => false }))

const startMutate = vi.fn(async () => ({}))
const addSessionMutate = vi.fn(async () => ({}))

vi.mock('@/app/store', () => {
  const useStore = () => ({
    trpc: {
      issues: { start: { mutate: startMutate }, addSession: { mutate: addSessionMutate } },
    },
    markIssueRead: vi.fn(),
    markIssueUnread: vi.fn(),
    sessions: [],
    repos: [],
    machines: [],
  })
  return {
    useStore,
    useStoreSelector: (sel: (s: unknown) => unknown) => sel(useStore() as never),
  }
})

function open(issue: ReturnType<typeof makeIssue>): void {
  render(
    <IssueContextMenu
      issues={[issue]}
      allIssues={[issue]}
      anchor={{ x: 10, y: 10 }}
      onClose={vi.fn()}
      onOpen={vi.fn()}
      onRename={vi.fn()}
    />,
  )
}

afterEach(() => {
  cleanup()
  startMutate.mockClear()
  addSessionMutate.mockClear()
})

describe('IssueContextMenu consolidated agent entry (POD-110 → POD-169)', () => {
  it('offers ONE agent entry on a startable issue — "Run now" opening the agent flyout', () => {
    open(makeIssue({ worktreePath: null, stage: 'backlog' }))
    const trigger = screen.getByRole('menuitem', { name: /Run now/ })
    expect(screen.queryByRole('menuitem', { name: /Assign agent/ })).toBeNull()
    fireEvent.click(trigger)
    // The flyout's first option is the default agent — the old one-click path.
    fireEvent.click(screen.getByRole('menuitem', { name: /\(default\)/ }))
    expect(startMutate).toHaveBeenCalledWith({ id: 'i' })
    expect(addSessionMutate).not.toHaveBeenCalled()
  })

  it('reads "Assign agent" once the issue has a worktree — still one entry', () => {
    open(makeIssue()) // default worktreePath is set
    expect(screen.queryByRole('menuitem', { name: /Run now/ })).toBeNull()
    expect(screen.getByRole('menuitem', { name: /Assign agent/ })).toBeDefined()
  })

  it('offers no agent entry on a closed issue', () => {
    open(makeIssue({ worktreePath: null, closedReason: 'done' }))
    expect(screen.queryByRole('menuitem', { name: /Run now/ })).toBeNull()
    expect(screen.queryByRole('menuitem', { name: /Assign agent/ })).toBeNull()
  })
})
