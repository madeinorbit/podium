import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { IssuePage } from './IssuePage'
import { makeIssue } from './test-issue'

const addSession = vi.fn(async () => ({}))
const addShell = vi.fn(async () => ({}))
const start = vi.fn(async () => ({}))
const update = vi.fn(async () => ({}))

vi.mock('./store', () => ({
  useStore: () => ({
    trpc: {
      settings: { get: { query: vi.fn(async () => ({ gitWorkflow: { mergeStyle: 'ff-only' } })) } },
      issues: {
        addSession: { mutate: addSession },
        addShell: { mutate: addShell },
        start: { mutate: start },
        update: { mutate: update },
      },
    },
    issues: [],
    setSelectedWorktree: vi.fn(),
    setPane: vi.fn(),
    setView: vi.fn(),
  }),
}))

afterEach(() => {
  cleanup()
  addSession.mockClear()
  addShell.mockClear()
  start.mockClear()
  update.mockClear()
})

describe('IssuePage agent start controls', () => {
  it('starts a new ticket session with a selected agent from the split dropdown', async () => {
    const issue = makeIssue({ id: 'i-1', defaultAgent: 'claude-code', worktreePath: '/r/wt' })
    render(
      <IssuePage issue={issue} orderedIds={[issue.id]} onBack={vi.fn()} onNavigate={vi.fn()} />,
    )

    const sessionAgentButton = screen.getAllByTitle('Choose session agent').at(0)
    if (!sessionAgentButton) throw new Error('missing session agent dropdown')
    fireEvent.click(sessionAgentButton)
    const defaultItem = await screen.findByRole('menuitem', {
      name: 'New Claude Code (default) session',
    })
    expect(defaultItem.querySelector('svg')).toBeTruthy()
    expect(screen.queryByRole('menuitem', { name: 'New Claude Code session' })).toBeNull()
    const codexItem = screen.getByRole('menuitem', { name: 'New Codex session' })
    expect(codexItem.querySelector('svg')).toBeTruthy()
    fireEvent.click(codexItem)

    await waitFor(() => expect(addSession).toHaveBeenCalledWith({ id: 'i-1', agentKind: 'codex' }))
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

    await waitFor(() =>
      expect(update).toHaveBeenCalledWith({ id: 'i-1', patch: { defaultModel: 'sonnet' } }),
    )
  })
})
