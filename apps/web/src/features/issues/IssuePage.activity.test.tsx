import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { makeIssue } from '@/lib/test-issue'
import { IssuePage } from './IssuePage'
import type { IssueEvent } from './issue-events'

const ROWS: IssueEvent[] = [
  {
    id: 1,
    ts: '2026-07-07T00:00:01.000Z',
    kind: 'issue.created',
    subject: 'i-1',
    repoPath: '/r',
    payload: {},
  },
  {
    id: 2,
    ts: '2026-07-07T00:00:02.000Z',
    kind: 'issue.state',
    subject: 'i-1',
    repoPath: '/r',
    payload: {},
  },
  {
    id: 3,
    ts: '2026-07-07T00:00:04.000Z',
    kind: 'issue.stage_changed',
    subject: 'i-1',
    repoPath: '/r',
    payload: { to: 'review' },
  },
  {
    id: 4,
    ts: '2026-07-07T00:00:05.000Z',
    kind: 'issue.pinned',
    subject: 'i-1',
    repoPath: '/r',
    payload: {},
  },
  {
    id: 5,
    ts: '2026-07-07T00:00:09.000Z',
    kind: 'issue.created',
    subject: 'other',
    repoPath: '/r',
    payload: {},
  },
]

// Stands in for the server's `issues.events` read, WHICH IS WHERE THE NARROWING
// LIVES SINCE POD-532 — so the fake honours `subject` the way SQL does. A page
// that forgets to send it gets the whole repo's log back here, exactly as it
// would in production, and the 'other' row below is what makes that visible.
const eventsQuery = vi.fn(async (input?: unknown): Promise<IssueEvent[]> => {
  const subject = (input as { subject?: string } | undefined)?.subject
  return subject ? ROWS.filter((r) => r.subject === subject) : ROWS
})

// #175: comment bodies left IssueWire — IssuePage fetches the thread lazily
// via the issues.comments proc; the wire only carries commentCount.
const COMMENTS = [
  { id: 'cm-1', author: 'me', body: 'a note', createdAt: '2026-07-07T00:00:03.000Z' },
]
const commentsQuery = vi.fn(async (_input?: unknown) => COMMENTS)

vi.mock('@/app/store', () => {
  const state = () =>
    ({
      trpc: {
        settings: {
          get: { query: vi.fn(async () => ({ gitWorkflow: { mergeStyle: 'ff-only' } })) },
        },
        issues: {
          events: { query: eventsQuery },
          comments: { query: commentsQuery },
          addSession: { mutate: vi.fn() },
          addShell: { mutate: vi.fn() },
          start: { mutate: vi.fn() },
          update: { mutate: vi.fn() },
          addComment: { mutate: vi.fn() },
        },
      },
      hub: { onIssues: () => () => {} },
      machines: [],
      issues: [],
      setSelectedWorktree: vi.fn(),
      setPane: vi.fn(),
      setView: vi.fn(),
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
  eventsQuery.mockClear()
  commentsQuery.mockClear()
})

describe('IssuePage activity feed', () => {
  it('scopes the feed to this issue and fetches events + comments from the log start', async () => {
    // (Event/comment label formatting is covered by issue-events.test.ts; here we
    // only assert the page-level scoping + fetch wiring.)
    const issue = makeIssue({ id: 'i-1', repoPath: '/r' })
    render(
      <IssuePage issue={issue} orderedIds={[issue.id]} onBack={vi.fn()} onNavigate={vi.fn()} />,
    )

    // Events for a different issue ('other') never arrive — only i-1's single 'created'.
    expect(await screen.findByText('created')).toBeTruthy()
    expect(screen.getAllByText('created')).toHaveLength(1)
    // The comment thread renders alongside events.
    expect(screen.getByText('a note')).toBeTruthy()

    // Feed is fetched from the log start, narrowed to THIS issue on the server
    // (POD-532) rather than paged repo-wide and filtered here.
    await waitFor(() => expect(eventsQuery).toHaveBeenCalled())
    expect(eventsQuery.mock.calls[0]?.[0]).toMatchObject({
      repoPath: '/r',
      since: 0,
      subject: 'i-1',
    })
    // The comment thread was fetched via the lazy proc (#175).
    expect(commentsQuery).toHaveBeenCalledWith({ id: 'i-1' })
  })

  it('orders events and comments chronologically', async () => {
    const issue = makeIssue({ id: 'i-1', repoPath: '/r' })
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
