import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { makeIssue } from '@/lib/test-issue'
import { IssuePage } from './IssuePage'

const addSession = vi.fn(async () => ({}))
const addShell = vi.fn(async () => ({}))
const start = vi.fn(async () => ({}))
const update = vi.fn(async (_input: unknown) => ({}))

vi.mock('@/app/store', () => {
  const state = () =>
    ({
      trpc: {
        settings: {
          get: { query: vi.fn(async () => ({ gitWorkflow: { mergeStyle: 'ff-only' } })) },
        },
        issues: {
          // Activity feed loads transition events on mount; no events in this fixture.
          events: { query: vi.fn(async () => []) },
          addSession: { mutate: addSession },
          addShell: { mutate: addShell },
          start: { mutate: start },
          update: { mutate: update },
        },
      },
      hub: { onIssues: () => () => {} },
      machines: [],
      issues: [],
      setSelectedWorktree: vi.fn(),
      setPane: vi.fn(),
      setView: vi.fn(),
      // The page edits an issue through the STORE ACTION, not through trpc
      // directly — `issue-page-commands` takes `updateIssue` as a dependency and
      // IssuePage hands it `s.updateIssue`. Without it here the call landed on
      // `undefined`, was swallowed by the commands' own `void run(...)`, and the
      // assertion below saw zero calls with nothing explaining why. Stands in for
      // the real action (actions.ts enqueues an overlayed `issueUpdate`) at the
      // point where it reaches the wire.
      updateIssue: async (id: string, patch: unknown) => update({ id, patch }),
    }) as never
  return {
    useStore: () => state(),
    // Selector hooks (useStoreSelector) reach the same mocked state.
    useStoreSelector: (sel: (s: unknown) => unknown) => sel(state()),
    useReplicaIssues: () => (state() as unknown as { issues: never[] }).issues,
  }
})

afterEach(() => {
  cleanup()
  addSession.mockClear()
  addShell.mockClear()
  start.mockClear()
  update.mockClear()
})

describe('IssuePage agent start controls', () => {
  // POD-1224: the agent is a SETTING in the launch box, not a one-off hidden in
  // a split button's dropdown. Choosing it writes `defaultAgent` — so the same
  // choice governs the CLI, the board and the next session — and the action
  // button then starts plainly, with no agent argument of its own.
  it('writes the chosen agent to the issue and adds a session with it', async () => {
    const issue = makeIssue({ id: 'i-1', defaultAgent: 'claude-code', worktreePath: '/r/wt' })
    render(
      <IssuePage issue={issue} orderedIds={[issue.id]} onBack={vi.fn()} onNavigate={vi.fn()} />,
    )

    const agentButton = screen.getAllByRole('button', { name: 'Agent' }).at(0)
    if (!agentButton) throw new Error('missing agent picker')
    fireEvent.click(agentButton)
    const codexItem = await screen.findByRole('menuitem', { name: 'Codex' })
    expect(codexItem.querySelector('svg')).toBeTruthy()
    fireEvent.click(codexItem)

    // Models are per-agent, so the write resets model + effort with it.
    await waitFor(() =>
      expect(update).toHaveBeenCalledWith({
        id: 'i-1',
        patch: { defaultAgent: 'codex', defaultModel: 'auto', defaultEffort: 'auto' },
      }),
    )

    const addButton = screen.getAllByRole('button', { name: '+ Session' }).at(0)
    if (!addButton) throw new Error('missing add-session button')
    fireEvent.click(addButton)
    await waitFor(() => expect(addSession).toHaveBeenCalledWith({ id: 'i-1' }))
  })

  it('picks a model for the ticket and persists it via issues.update', async () => {
    const issue = makeIssue({ id: 'i-1', defaultAgent: 'claude-code', worktreePath: '/r/wt' })
    render(
      <IssuePage issue={issue} orderedIds={[issue.id]} onBack={vi.fn()} onNavigate={vi.fn()} />,
    )

    const modelButton = screen.getAllByRole('button', { name: 'Model' }).at(0)
    if (!modelButton) throw new Error('missing model picker')
    fireEvent.click(modelButton)
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Sonnet' }))

    // Effort is per-model, so changing the model also resets effort to auto.
    await waitFor(() =>
      expect(update).toHaveBeenCalledWith({
        id: 'i-1',
        patch: { defaultModel: 'sonnet', defaultEffort: 'auto' },
      }),
    )
  })
})
