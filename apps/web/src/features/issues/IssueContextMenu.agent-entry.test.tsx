import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ConfirmProvider } from '@/lib/hooks/use-confirm'
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

// The menu's Archive and Delete confirms are the app-wide dialog (POD-1077), so
// it now reads the ConfirmProvider context the real tree supplies from AppShell.
function open(issue: ReturnType<typeof makeIssue>, primaryStart = false): void {
  render(
    <ConfirmProvider>
      <IssueContextMenu
        issues={[issue]}
        allIssues={[issue]}
        anchor={{ x: 10, y: 10 }}
        primaryStart={primaryStart}
        onClose={vi.fn()}
        onOpen={vi.fn()}
        onRename={vi.fn()}
      />
    </ConfirmProvider>,
  )
}

afterEach(() => {
  cleanup()
  startMutate.mockClear()
  addSessionMutate.mockClear()
})

/**
 * POD-110 consolidated two agent entries into one that read "Run now" on an
 * unstarted task and "Assign agent" on a running one. POD-1470 took that entry
 * off the menu entirely: every surface hosting it is a LIST, and a row names
 * neither the harness "Run now" would launch nor the agent already on the task.
 * Both live where they can be seen — the task page's Sessions block, the start
 * controls each list carries in its own chrome, and the command palette.
 *
 * What survives here is `start`, which is a different entry: a host asks for it
 * (the deck, on a proposal) and it says "Start issue" in its own words.
 */
describe('IssueContextMenu — the agent entry is off the menu (POD-110 → POD-1470)', () => {
  for (const [state, issue] of [
    ['unstarted', makeIssue({ worktreePath: null, stage: 'backlog' })],
    ['running', makeIssue()], // default worktreePath is set
    ['closed', makeIssue({ worktreePath: null, closedReason: 'done' })],
  ] as const) {
    it(`offers neither face on a ${state} task`, () => {
      open(issue)
      expect(screen.queryByRole('menuitem', { name: /Run now/ })).toBeNull()
      expect(screen.queryByRole('menuitem', { name: /Assign agent/ })).toBeNull()
    })
  }

  it('still starts a proposal through the host-opted "Start issue"', () => {
    open(makeIssue({ worktreePath: null, stage: 'backlog' }), true)
    expect(screen.queryByRole('menuitem', { name: /Run now/ })).toBeNull()
    fireEvent.click(screen.getByRole('menuitem', { name: 'Start issue' }))
    expect(startMutate).toHaveBeenCalledWith({ id: 'i' })
    expect(addSessionMutate).not.toHaveBeenCalled()
  })
})
