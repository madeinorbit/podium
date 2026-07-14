import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { IssuePage } from './IssuePage'
import { makeIssue } from './test-issue'

const update = vi.fn(async () => ({}))
const panelApply = vi.fn(async () => ({}))
const openFileInWorktree = vi.fn()
const mailInbox = vi.fn(async () => [
  {
    id: 'msg-1',
    issueId: 'i-agent-data',
    fromAuthor: 'issue:#12',
    body: 'The shared tokens are ready to consume.',
    createdAt: '2026-07-14T11:00:00.000Z',
    status: 'unread' as const,
    claimedBy: null,
    wasUnread: true,
  },
])

vi.mock('@/app/store', () => {
  const state = () =>
    ({
      trpc: {
        settings: {
          get: { query: vi.fn(async () => ({ gitWorkflow: { mergeStyle: 'ff-only' } })) },
        },
        issues: {
          events: { query: vi.fn(async () => []) },
          comments: { query: vi.fn(async () => []) },
          mailInbox: { mutate: mailInbox },
          update: { mutate: update },
          panelApply: { mutate: panelApply },
          addSession: { mutate: vi.fn() },
          addShell: { mutate: vi.fn() },
          start: { mutate: vi.fn() },
          addComment: { mutate: vi.fn() },
        },
      },
      hub: { onIssues: () => () => {} },
      httpOrigin: 'http://podium.test',
      machines: [],
      issues: [],
      openFileInWorktree,
      setSelectedWorktree: vi.fn(),
      setPane: vi.fn(),
      setView: vi.fn(),
    }) as never
  return {
    useStore: () => state(),
    useStoreSelector: (sel: (s: unknown) => unknown) => sel(state()),
  }
})

afterEach(() => {
  cleanup()
  update.mockClear()
  panelApply.mockClear()
  mailInbox.mockClear()
  openFileInWorktree.mockClear()
})

describe('IssuePage agent-saved data', () => {
  const issue = makeIssue({
    id: 'i-agent-data',
    repoPath: '/repo',
    worktreePath: null,
    title: 'Surface the agent dossier',
    description: 'Human-authored summary.',
    design: 'Architecture details from the implementing agent.',
    acceptance: 'All saved fields are visible.',
    notes: 'A durable implementation note.',
    activityNotes: 'Runtime verification is still in progress.',
    notesUpdatedAt: '2026-07-14T12:00:00.000Z',
    blockedBy: ['issue:#9'],
    dependencyNote: 'Wait for the upstream contract.',
    closedReason: 'done',
    supersededBy: 'issue:#99',
    pinned: true,
    origin: 'agent',
    audience: 'agent',
    draft: true,
    panel: {
      todos: [
        { text: 'Render every field', done: false },
        { text: 'Keep the layout scannable', done: true },
      ],
      artifacts: [
        {
          path: 'docs/agent-data.md',
          title: 'Agent data notes',
          addedAt: '2026-07-14T10:00:00.000Z',
        },
      ],
      deferred: [
        {
          text: 'Revisit tablet density later.',
          addedAt: '2026-07-13T10:00:00.000Z',
        },
      ],
    },
  })

  it('renders long-form fields, checkpoints, panel data, lifecycle metadata, blockers, and mail', async () => {
    render(
      <IssuePage issue={issue} orderedIds={[issue.id]} onBack={vi.fn()} onNavigate={vi.fn()} />,
    )

    const longForm = screen.getByTestId('long-form-fields')
    expect(within(longForm).getByText(issue.design ?? '')).toBeTruthy()
    expect(within(longForm).getByText(issue.acceptance ?? '')).toBeTruthy()
    expect(within(longForm).getByText(issue.notes ?? '')).toBeTruthy()
    expect(screen.getByText('Runtime verification is still in progress.')).toBeTruthy()

    const panel = screen.getByTestId('issue-panel-sections')
    expect(within(panel).getByText('Render every field')).toBeTruthy()
    expect(within(panel).getByText('Agent data notes')).toBeTruthy()
    expect(within(panel).getByText('Revisit tablet density later.')).toBeTruthy()

    const status = screen.getByTestId('status-strip')
    for (const text of ['Closed · done', 'draft', 'pinned', 'agent-created', 'internal']) {
      expect(within(status).getByText(text)).toBeTruthy()
    }
    expect(screen.getByText('Superseded by')).toBeTruthy()

    const blockers = screen.getAllByTestId('agent-blockers')[0]
    if (!blockers) throw new Error('missing agent blocker notes')
    expect(within(blockers).getByText('blocked by: issue:#9')).toBeTruthy()
    expect(within(blockers).getByText('Wait for the upstream contract.')).toBeTruthy()

    expect(await screen.findByText('The shared tokens are ready to consume.')).toBeTruthy()
    expect(mailInbox).toHaveBeenCalledWith({ id: issue.id })
  })

  it('persists long-form edits and todo checks, and opens file artifacts', async () => {
    render(
      <IssuePage issue={issue} orderedIds={[issue.id]} onBack={vi.fn()} onNavigate={vi.fn()} />,
    )

    fireEvent.click(screen.getByText('Architecture details from the implementing agent.'))
    const design = screen.getByLabelText('Issue design')
    fireEvent.change(design, { target: { value: 'Updated architecture details.' } })
    fireEvent.blur(design)
    await waitFor(() =>
      expect(update).toHaveBeenCalledWith({
        id: issue.id,
        patch: { design: 'Updated architecture details.' },
      }),
    )

    const panel = screen.getByTestId('issue-panel-sections')
    fireEvent.click(within(panel).getAllByRole('checkbox')[0] as HTMLElement)
    await waitFor(() =>
      expect(panelApply).toHaveBeenCalledWith({
        id: issue.id,
        op: 'todo-done',
        index: 1,
      }),
    )

    fireEvent.click(within(screen.getByTestId('issue-artifacts')).getByRole('button'))
    expect(openFileInWorktree).toHaveBeenCalledWith({
      machineId: undefined,
      root: '/repo',
      path: '/repo/docs/agent-data.md',
    })
  })
})
