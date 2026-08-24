import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { toast } from 'sonner'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { makeIssue } from '@/lib/test-issue'
import { IssuePage } from './IssuePage'

// The page's mutation runner reports a refused write through the app's shared
// <Toaster/>, which lives in AppShell and is not mounted around this page.
vi.mock('sonner', () => ({
  toast: Object.assign(vi.fn(), { error: vi.fn(), success: vi.fn(), info: vi.fn() }),
}))
// The launch box's model/effort segments read the live catalog through this
// shim, which hangs off the REAL store provider rather than the mock below —
// so without it every render of the box threw `useStore outside StoreProvider`
// before a single assertion ran. Same stub the dock's own test uses.
vi.mock('@/lib/use-model-catalog', () => ({ useModelCatalog: () => ({}) }))

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
          start: { mutate: start },
          update: { mutate: update },
        },
      },
      hub: { onIssues: () => () => {} },
      machines: [],
      // The launch box reads the fleet to grey harnesses this repo's hosts
      // cannot run; an absent slice crashes `reposToViews` rather than
      // resolving to "no hosts".
      repos: [],
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
  start.mockClear()
  update.mockClear()
  vi.mocked(toast.error).mockClear()
})

/** NOT YET BEGUN. `makeIssue` defaults to an `in_progress` task that already has
 *  a checkout, and either one is proof somebody picked the work up — which is
 *  exactly when the launch box leaves the page (POD-1585). Every test about
 *  launching therefore has to say otherwise explicitly. */
const unstarted = (over: Parameters<typeof makeIssue>[0] = {}) =>
  makeIssue({
    id: 'i-1',
    defaultAgent: 'claude-code',
    stage: 'backlog',
    worktreePath: null,
    ...over,
  })

describe('IssuePage agent start controls', () => {
  // POD-1224: the agent is a SETTING in the launch box, not a one-off hidden in
  // a split button's dropdown. Choosing it writes `defaultAgent` — so the same
  // choice governs the CLI, the board and the next session — and the action
  // button then starts plainly, with no agent argument of its own.
  it('writes the chosen agent to the issue and starts with it', async () => {
    const issue = unstarted()
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

    const startButton = screen.getAllByRole('button', { name: 'Start work' }).at(0)
    if (!startButton) throw new Error('missing start-work button')
    fireEvent.click(startButton)
    await waitFor(() => expect(start).toHaveBeenCalledWith({ id: 'i-1' }))
  })

  /**
   * THE BOX IS FOR LAUNCHING, so it leaves once somebody has (POD-1585). Adding
   * an agent to work already under way is the flight deck's move and a shell is
   * a tab; the page's Sessions block is then the roster and nothing else.
   */
  it.each([
    ['a checkout', { worktreePath: '/r/wt' }],
    ['a stage that says so', { stage: 'in_progress' as const }],
    ['a task under review', { stage: 'review' as const }],
  ])('offers no launch controls once the work has begun — %s', (_name, over) => {
    const issue = unstarted(over)
    render(
      <IssuePage issue={issue} orderedIds={[issue.id]} onBack={vi.fn()} onNavigate={vi.fn()} />,
    )

    expect(screen.queryByTestId('launch-box')).toBeNull()
    expect(screen.queryByRole('button', { name: 'Start work' })).toBeNull()
    expect(screen.queryByRole('button', { name: '+ Session' })).toBeNull()
    expect(screen.queryByRole('button', { name: '+ Shell' })).toBeNull()
  })

  it('picks a model for the ticket and persists it via issues.update', async () => {
    const issue = unstarted()
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

  // POD-1266: a refused start used to land as a muted grey strip pinned under
  // the whole page — below the activity feed and the comment composer, hundreds
  // of pixels from the button that was pressed, in the type reserved for
  // captions. `git worktree add` failing on a branch that already exists is the
  // ordinary way this happens, and it read as page furniture rather than as an
  // answer to the click. It is an alert now, and NOTHING is written into the
  // page body.
  it('reports a refused start as an alert, not as text at the foot of the page', async () => {
    const message =
      "worktree add failed: fatal: a branch named 'issue/1262-main-red-on-typecheck' already exists"
    start.mockRejectedValueOnce(new Error(message))
    const issue = unstarted()
    render(
      <IssuePage issue={issue} orderedIds={[issue.id]} onBack={vi.fn()} onNavigate={vi.fn()} />,
    )

    const startButton = screen.getAllByRole('button', { name: 'Start work' }).at(0)
    if (!startButton) throw new Error('missing start-work button')
    fireEvent.click(startButton)

    await waitFor(() => expect(toast.error).toHaveBeenCalledWith(message))
    expect(screen.queryByText(message)).toBeNull()
  })
})
