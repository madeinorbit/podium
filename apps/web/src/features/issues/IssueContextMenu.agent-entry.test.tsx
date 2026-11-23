import { withKeyedInputs } from '@podium/client-core/test-support/keyed-inputs'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { closeSetupAgents, setupAgentsRequest } from '@/features/setup-agents/open-setup-agents'
import { ConfirmProvider } from '@/lib/hooks/use-confirm'
import { makeIssue } from '@/lib/test-issue'
import { IssueContextMenu } from './IssueContextMenu'
import { IssuePageWorldContext } from './issue-page/issue-page-data'

const agentFleetRead = vi.hoisted(() =>
  vi.fn(() => {
    const machine = {
      id: 'machine-a',
      name: 'Workstation',
      online: true,
      serviceAssignment: { server: false, agentExecution: true },
      availability: { daemon: true },
      inventory: {
        agents: [
          { kind: 'claude-code', installed: true, login: { state: 'in' } },
          { kind: 'codex', installed: true, login: { state: 'out' } },
          { kind: 'cursor', installed: false, login: { state: 'unknown' } },
        ],
      },
    }
    return { machines: [machine], setupMachines: [machine], options: [] }
  }),
)
vi.mock('./use-agent-fleet-options', () => ({ useAgentFleet: agentFleetRead }))

vi.mock('@/lib/use-feature', () => ({ useFeature: () => false }))

const startMutate = vi.fn(async () => ({}))
const addSessionMutate = vi.fn(async () => ({}))
// Starting is the issue's effect record (POD-6526), never the routes above.
const startIssueSession = vi.fn(() => ({ settled: Promise.resolve(true) }))

vi.mock('@podium/client-core/react', async (original) => {
  const { fixtureRuntimeHooks } = await import('@podium/client-core/test-support/command-hooks')
  return {
    ...(await original<typeof import('@podium/client-core/react')>()),
    // POD-3911: the menu reads owner.access, not getSnapshot directly.
    ...fixtureRuntimeHooks(() =>
      withKeyedInputs({
        subscribe: () => () => {},
        getSnapshot: () => ({
          trpc: {
            issues: { start: { mutate: startMutate }, addSession: { mutate: addSessionMutate } },
          },
          markIssueRead: vi.fn(),
          markIssueUnread: vi.fn(),
          startIssueSession,
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
    ),
  }
})
vi.mock('@/app/store', () => ({
  readFixture: () => {
    throw new Error('Task menu used a legacy selector')
  },
}))

// The menu's Archive and Delete confirms are the app-wide dialog (POD-1077), so
// it now reads the ConfirmProvider context the real tree supplies from AppShell.
function open(
  issue: ReturnType<typeof makeIssue>,
  primaryStart = false,
  surface: 'board' | 'palette' = 'board',
): void {
  render(
    <ConfirmProvider>
      <IssuePageWorldContext.Provider value={{ issues: [issue], sessions: [] }}>
        <IssueContextMenu
          issues={[issue]}
          allIssues={[issue]}
          poolInputs={{ sessions: [], repos: [], machines: [] }}
          anchor={{ x: 10, y: 10 }}
          primaryStart={primaryStart}
          surface={surface}
          onClose={vi.fn()}
          onOpen={vi.fn()}
          onRename={vi.fn()}
        />
      </IssuePageWorldContext.Provider>
    </ConfirmProvider>,
  )
}

afterEach(() => {
  cleanup()
  closeSetupAgents()
  agentFleetRead.mockClear()
  startMutate.mockClear()
  addSessionMutate.mockClear()
  startIssueSession.mockClear()
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
      expect(agentFleetRead).not.toHaveBeenCalled()
    })
  }

  it('still starts a proposal through the host-opted "Start issue"', () => {
    open(makeIssue({ worktreePath: null, stage: 'backlog' }), true)
    expect(screen.queryByRole('menuitem', { name: /Run now/ })).toBeNull()
    fireEvent.click(screen.getByRole('menuitem', { name: 'Start issue' }))
    expect(startIssueSession).toHaveBeenCalledWith({ issueId: 'i', mode: 'begin' })
    expect(startMutate).not.toHaveBeenCalled()
    expect(addSessionMutate).not.toHaveBeenCalled()
  })
})

it('reads capability choices only for the opened agent flyout and returns setup to the issue', () => {
  open(makeIssue(), false, 'palette')
  expect(agentFleetRead).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('menuitem', { name: 'Assign agent' }))
  expect(agentFleetRead).toHaveBeenCalled()
  expect(screen.queryByRole('menuitem', { name: 'Cursor' })).toBeNull()
  expect(screen.getByRole('menuitem', { name: 'Codex signed out' })).toBeTruthy()
  fireEvent.click(screen.getByRole('menuitem', { name: 'Set up agents…' }))
  expect(setupAgentsRequest()).toMatchObject({ machineId: 'machine-a', origin: 'menu' })
  expect(startIssueSession).not.toHaveBeenCalled()
  act(() => setupAgentsRequest()?.onStart?.('codex'))
  expect(startIssueSession).toHaveBeenCalledExactlyOnceWith({ issueId: 'i', agentKind: 'codex' })
})
