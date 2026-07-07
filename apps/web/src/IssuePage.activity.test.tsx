import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { IssuePage } from './IssuePage'
import type { IssueEvent } from './issue-events'
import { makeIssue } from './test-issue'

const ROWS: IssueEvent[] = [
  { id: 1, ts: '2026-07-07T00:00:01.000Z', kind: 'issue.created', subject: 'i-1', repoPath: '/r', payload: {} },
  { id: 2, ts: '2026-07-07T00:00:02.000Z', kind: 'issue.state', subject: 'i-1', repoPath: '/r', payload: {} },
  { id: 3, ts: '2026-07-07T00:00:04.000Z', kind: 'issue.stage_changed', subject: 'i-1', repoPath: '/r', payload: { to: 'review' } },
  { id: 4, ts: '2026-07-07T00:00:05.000Z', kind: 'issue.pinned', subject: 'i-1', repoPath: '/r', payload: {} },
  { id: 5, ts: '2026-07-07T00:00:09.000Z', kind: 'issue.created', subject: 'other', repoPath: '/r', payload: {} },
]

const eventsQuery = vi.fn(async (_input?: unknown): Promise<IssueEvent[]> => ROWS)

vi.mock('./store', () => ({
  useStore: () => ({
    trpc: {
      settings: { get: { query: vi.fn(async () => ({ gitWorkflow: { mergeStyle: 'ff-only' } })) } },
      issues: {
        events: { query: eventsQuery },
        addSession: { mutate: vi.fn() },
        addShell: { mutate: vi.fn() },
        start: { mutate: vi.fn() },
        update: { mutate: vi.fn() },
        addComment: { mutate: vi.fn() },
      },
    },
    hub: { onIssues: () => () => {} },
    issues: [],
    setSelectedWorktree: vi.fn(),
    setPane: vi.fn(),
    setView: vi.fn(),
  }),
}))

afterEach(() => {
  cleanup()
  eventsQuery.mockClear()
})

describe('IssuePage activity feed', () => {
  it('renders state-transition events interleaved with comments', async () => {
    const issue = makeIssue({
      id: 'i-1',
      repoPath: '/r',
      comments: [{ id: 'cm-1', author: 'me', body: 'a note', createdAt: '2026-07-07T00:00:03.000Z' }],
    })
    render(
      <IssuePage issue={issue} orderedIds={[issue.id]} onBack={vi.fn()} onNavigate={vi.fn()} />,
    )

    // Known transition kinds render human-readable.
    expect(await screen.findByText('created')).toBeTruthy()
    expect(await screen.findByText('moved to Review')).toBeTruthy()
    // Comment thread still renders alongside events.
    expect(screen.getByText('a note')).toBeTruthy()
    // Unknown kinds (e.g. S2's issue.pinned) render generically, not dropped.
    expect(screen.getByText('pinned')).toBeTruthy()
    // Pure UI-sync bookkeeping is hidden.
    expect(screen.queryByText('issue.state')).toBeNull()
    // Events for a different issue are filtered out (only i-1's single 'created').
    expect(screen.getAllByText('created')).toHaveLength(1)

    // Feed is fetched scoped to this issue's repo, from the log start.
    await waitFor(() => expect(eventsQuery).toHaveBeenCalled())
    expect(eventsQuery.mock.calls[0]?.[0]).toMatchObject({ repoPath: '/r', since: 0 })
  })

  it('orders events and comments chronologically', async () => {
    const issue = makeIssue({
      id: 'i-1',
      repoPath: '/r',
      comments: [{ id: 'cm-1', author: 'me', body: 'a note', createdAt: '2026-07-07T00:00:03.000Z' }],
    })
    render(
      <IssuePage issue={issue} orderedIds={[issue.id]} onBack={vi.fn()} onNavigate={vi.fn()} />,
    )
    await screen.findByText('moved to Review')

    // Oldest → newest, comment interleaved by its timestamp.
    const nodes = ['created', 'a note', 'moved to Review', 'pinned'].map((t) => screen.getByText(t))
    for (let i = 1; i < nodes.length; i++) {
      const before = nodes[i - 1]
      const after = nodes[i]
      if (!before || !after) throw new Error('missing feed node')
      expect(before.compareDocumentPosition(after) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    }
  })
})
