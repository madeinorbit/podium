import type { SessionView } from '@podium/client-core/session-values'
import { asSessionId, type IssueCloseReason } from '@podium/model/browser'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ConfirmProvider } from '@/lib/hooks/use-confirm'
import { makeIssue } from '@/lib/test-issue'
import { IssueContextMenu } from './IssueContextMenu'
import { IssuePageWorldContext } from './issue-page/issue-page-data'

vi.mock('@/lib/use-feature', () => ({ useFeature: () => false }))

const closeIssue = vi.fn(async () => {})
const state: { sessions: SessionView[] } = { sessions: [] }

vi.mock('@podium/client-core/react', async (original) => ({
  ...(await original<typeof import('@podium/client-core/react')>()),
  useStoreHandle: () => ({
    getSnapshot: () => ({
      trpc: { issues: { start: { mutate: vi.fn() } } },
      markIssueRead: vi.fn(),
      markIssueUnread: vi.fn(),
      closeIssue,
      get sessions() {
        throw new Error('Task menu read legacy sessions')
      },
      get repos() {
        throw new Error('Task menu read legacy repos')
      },
      get machines() {
        throw new Error('Task menu read legacy machines')
      },
    }),
  }),
}))
vi.mock('@/app/store', () => ({
  useRuntimeSelector: () => {
    throw new Error('Task menu used a legacy selector')
  },
}))

const working = (): SessionView =>
  ({
    sessionId: asSessionId('agent'),
    agentKind: 'claude-code',
    title: 'POD-1113-A',
    cwd: '/r/wt',
    status: 'live',
    agentState: { phase: 'working' },
    createdAt: 't',
    updatedAt: 't',
    unread: false,
    archived: false,
  }) as unknown as SessionView

function open(over: { onRequestClose?: (reason: IssueCloseReason) => void } = {}): {
  onClose: ReturnType<typeof vi.fn>
} {
  const onClose = vi.fn()
  const issue = makeIssue({ memberSessionIds: ['agent'] })
  render(
    // POD-1077: the menu's cascade confirms read the ConfirmProvider context
    // AppShell supplies in the real tree.
    <ConfirmProvider>
      <IssuePageWorldContext.Provider
        value={{ issues: [issue], sessions: state.sessions as SessionView[] }}
      >
        <IssueContextMenu
          issues={[issue]}
          allIssues={[issue]}
          poolInputs={{ sessions: state.sessions, repos: [], machines: [] }}
          anchor={{ x: 10, y: 10 }}
          onClose={onClose}
          onOpen={vi.fn()}
          surface="sidebar"
          {...over}
        />
      </IssuePageWorldContext.Provider>
    </ConfirmProvider>,
  )
  return { onClose }
}

/** Closing is reached through the status submenu since POD-1074 — the terminal
 *  half of the same list that moves an issue between the open lanes. */
const pickStatus = (label: RegExp): void => {
  fireEvent.click(screen.getByRole('menuitem', { name: /Set status/ }))
  fireEvent.click(screen.getByRole('menuitem', { name: label }))
}

afterEach(() => {
  cleanup()
  closeIssue.mockClear()
  state.sessions = []
})

describe('IssueContextMenu close guard (POD-1113)', () => {
  it('shows the guard — not an instant close — on a surface with no dialog of its own', () => {
    state.sessions = [working()]
    open()
    pickStatus(/^Done/)
    expect(closeIssue).not.toHaveBeenCalled()
    // The same concern list the issue page shows: a live agent is still working.
    expect(screen.getByTestId('issue-close-concerns').textContent).toContain('still working')
  })

  it('closes with the reason the entry carried once the guard is confirmed', async () => {
    state.sessions = [working()]
    const { onClose } = open()
    pickStatus(/^Cancelled/)
    fireEvent.click(screen.getByRole('button', { name: /Close as cancelled/ }))
    expect(closeIssue).toHaveBeenCalledWith('i', 'cancelled')
    await vi.waitFor(() => expect(onClose).toHaveBeenCalled())
  })

  it('keeps the issue open — and dismisses the menu — when the guard is declined', () => {
    state.sessions = [working()]
    const { onClose } = open()
    pickStatus(/^Done/)
    fireEvent.click(screen.getByRole('button', { name: /Keep open/ }))
    expect(closeIssue).not.toHaveBeenCalled()
    expect(onClose).toHaveBeenCalled()
  })

  // POD-1278. The guard used to rise on every close, and with nothing to list it
  // said so — an amber warning about an issue that has nothing wrong with it,
  // asking again for the press just made. It now behaves like every other menu
  // command when it has nothing to name; the three cases above prove it still
  // rises when it does.
  it('closes on the press when nothing is unresolved, with no guard in between', async () => {
    const { onClose } = open()
    pickStatus(/^Done/)
    expect(closeIssue).toHaveBeenCalledWith('i', 'done')
    expect(screen.queryByTestId('issue-close-concerns')).toBeNull()
    await vi.waitFor(() => expect(onClose).toHaveBeenCalled())
  })

  it('defers to a host that owns the dialog instead of mounting a second one', () => {
    const onRequestClose = vi.fn()
    open({ onRequestClose })
    pickStatus(/^Done/)
    expect(onRequestClose).toHaveBeenCalledWith('done')
    expect(closeIssue).not.toHaveBeenCalled()
    expect(screen.queryByTestId('issue-close-concerns')).toBeNull()
  })
})
