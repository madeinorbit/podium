// @vitest-environment happy-dom
import type { SessionMeta } from '@podium/model'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { makeIssue } from '@/lib/test-issue'
import { IssuePanelView } from './IssuePanelView'

vi.mock('@/lib/use-feature', () => ({ useFeature: () => false }))

const ROOT = makeIssue({
  id: 'root',
  repoPath: '/r',
  seq: 1,
  title: 'Operator workspace',
  description: 'Rework the dock into one scroll.',
  worktreePath: '/r',
  activityNotes: 'Spine direction is fixed; the inspector is next.',
  notesUpdatedAt: '2026-08-07T00:00:00.000Z',
  childCount: 2,
  childDoneCount: 1,
})
const OPEN_CHILD = makeIssue({
  id: 'k1',
  repoPath: '/r',
  seq: 2,
  title: 'Flat sidebar',
  parentId: 'root',
})
const DONE_CHILD = makeIssue({
  id: 'k2',
  repoPath: '/r',
  seq: 3,
  title: 'Tray removal',
  parentId: 'root',
  stage: 'done',
})
// A grandchild: it belongs to its own parent's Subtasks list, and to NEITHER
// this panel's list nor this panel's meter — the inspector is one tier deep and
// the meter counts exactly the rows it sits above (POD-516 r3 #4).
const GRANDCHILD = makeIssue({
  id: 'g1',
  repoPath: '/r',
  seq: 4,
  title: 'Rail badge',
  parentId: 'k1',
})

/** Ids are branded on `SessionMeta`; fixtures are built from string literals,
 *  so the override side is the unbranded spelling. */
type SessionOverride = Partial<Omit<SessionMeta, 'sessionId' | 'issueId'>> & {
  sessionId?: string
  issueId?: string
}

const session = (over: SessionOverride = {}): SessionMeta =>
  ({
    sessionId: 's1',
    issueId: 'root',
    agentKind: 'claude-code',
    name: 'Workspace coordinator',
    archived: false,
    status: 'live',
    lastActiveAt: '2026-08-07T00:00:00.000Z',
    ...over,
  }) as unknown as SessionMeta

let mockIssues = [ROOT, OPEN_CHILD, DONE_CHILD, GRANDCHILD]
let mockSessions: SessionMeta[] = []

const setPane = vi.fn()
const setView = vi.fn()
const setOpenIssueId = vi.fn()

const EVENT_ROWS = [
  {
    id: 1,
    ts: '2026-08-07T00:00:00.000Z',
    kind: 'issue.created',
    subject: 'root',
    repoPath: '/r',
    payload: null,
  },
  {
    id: 2,
    ts: '2026-08-07T00:01:00.000Z',
    kind: 'issue.created',
    subject: 'k1',
    repoPath: '/r',
    payload: null,
  },
]
// Honours `subject` the way the SQL does (POD-532), so a caller that forgets to
// send it fails here instead of quietly rendering another issue's history.
const eventsQuery = vi.fn(async (input?: unknown) => {
  const subject = (input as { subject?: string } | undefined)?.subject
  return subject ? EVENT_ROWS.filter((row) => row.subject === subject) : EVENT_ROWS
})

vi.mock('@/app/store', () => {
  const state = () => ({
    trpc: {
      issues: {
        comments: { query: vi.fn(async () => []) },
        events: { query: eventsQuery },
        start: { mutate: vi.fn(async () => ({})) },
        close: { mutate: vi.fn(async () => ({})) },
        update: { mutate: vi.fn(async () => ({})) },
        clearNeedsHuman: { mutate: vi.fn(async () => ({})) },
        panelApply: { mutate: vi.fn(async () => ({})) },
      },
      sessions: { sendText: { mutate: vi.fn(async () => ({})) } },
    },
    httpOrigin: '',
    openFileInWorktree: vi.fn(),
    openArtifact: vi.fn(),
    uiState: { get: () => null, set: vi.fn() },
    issues: mockIssues,
    sessions: mockSessions,
    repos: [],
    machines: [],
    setPane,
    setView,
    setOpenIssueId,
    navigateToSession: vi.fn(),
    renameSession: vi.fn(async () => {}),
    archiveSession: vi.fn(async () => {}),
    markIssueRead: vi.fn(),
    markIssueUnread: vi.fn(),
    markSessionRead: vi.fn(),
  })
  return {
    useStore: () => state(),
    useStoreSelector: (sel: (s: unknown) => unknown) => sel(state()),
    useReplicaIssues: () => (state() as unknown as { issues: never[] }).issues,
  }
})

const parts = (): string[] =>
  [...document.querySelectorAll('[data-part]')].map((el) => el.getAttribute('data-part') ?? '')

beforeEach(() => {
  mockIssues = [ROOT, OPEN_CHILD, DONE_CHILD, GRANDCHILD]
  mockSessions = []
})

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe('IssuePanelView inspector', () => {
  it('renders one scroll in the approved section order', () => {
    render(<IssuePanelView cwd="/r" />)

    expect(parts()).toEqual([
      'Current update',
      'Subtasks',
      'Agents & sessions',
      'Relations',
      'Branch & worktree',
      'Recent activity',
    ])
  })

  it('drops the collapsible section chrome — headings are text, not toggles', () => {
    render(<IssuePanelView cwd="/r" />)

    for (const title of ['Current update', 'Agents & sessions', 'Relations']) {
      expect(screen.getByText(title).closest('button')).toBeNull()
    }
  })

  // The TITLE is the dock title bar's job now (RightDock), so the panel leads
  // with the ref and the description — and the description is uncapped, because
  // it lives in the scroll instead of in the height-budgeted fixed head.
  it('leads with the ref and an uncapped description, and repeats no title', () => {
    render(<IssuePanelView cwd="/r" />)

    expect(within(screen.getByTestId('dock-inspect-head')).getByText('#1')).toBeTruthy()
    const description = screen.getByTestId('dock-description')
    expect(description.textContent).toBe('Rework the dock into one scroll.')
    expect(description.className).not.toContain('line-clamp')
    // The dock title bar says it once; the panel does not say it again.
    expect(screen.queryByText('Operator workspace')).toBeNull()
    // ...and the head no longer names the panel it is already inside.
    expect(within(screen.getByTestId('dock-inspect-head')).queryByText('Task')).toBeNull()
    expect(screen.queryByText('P2')).toBeNull()
    expect(screen.queryByText(/subissues done/)).toBeNull()
  })

  it('puts the meter with the subtasks it counts, and counts only those', () => {
    render(<IssuePanelView cwd="/r" />)

    const work = screen.getByTestId('dock-subissues')
    // 2 direct children, one done. Neither the issue itself nor the grandchild
    // is in the count — the meter describes the rows underneath it.
    expect(within(work).getByTestId('dock-subtasks-meter').textContent).toContain('1 of 2 done')
    // ...and it is no longer floating under the current update.
    expect(
      within(screen.getByTestId('dock-current-update')).queryByTestId('dock-subtasks-meter'),
    ).toBeNull()
    expect(within(work).getByText('Flat sidebar')).toBeTruthy()
    // The grandchild belongs to its own parent's Subtasks list, not this one.
    expect(within(work).queryByText('Rail badge')).toBeNull()
    // Completed work folds away until asked for.
    expect(within(work).queryByText('Tray removal')).toBeNull()
    fireEvent.click(within(work).getByText(/Show 1 completed/))
    expect(within(work).getByText('Tray removal')).toBeTruthy()
  })

  // Amber, in the same place and the same weight the sidebar and the Flight
  // Deck put it, so one task does not read three ways in three columns.
  it('marks a subtask that needs the operator in attention ink', () => {
    mockIssues = [ROOT, { ...OPEN_CHILD, needsHuman: true }, DONE_CHILD, GRANDCHILD]
    render(<IssuePanelView cwd="/r" />)

    const work = screen.getByTestId('dock-subissues')
    const marked = [...work.querySelectorAll<HTMLElement>('[data-needs-you]')]
    expect(marked).toHaveLength(1)
    const row = marked[0] as HTMLElement
    expect(row.textContent).toContain('Flat sidebar')
    expect(within(row).getByText('Needs you').className).toContain('text-attention')
  })

  // The current update says WHAT happened and when; who said it is the roster's
  // job, two sections down, and saying it twice is what the operator flagged.
  it('keeps the update to its words and its age, with one link to the timeline', () => {
    mockSessions = [session()]
    render(<IssuePanelView cwd="/r" />)

    const update = screen.getByTestId('dock-current-update')
    expect(update.textContent).toContain('Spine direction is fixed')
    expect(update.textContent).not.toContain('Workspace coordinator')
    expect(within(update).getByTestId('dock-open-full-activity')).toBeTruthy()
    // Only one exit to the full issue in the whole scroll.
    expect(screen.getAllByTestId('dock-open-full-activity')).toHaveLength(1)
  })

  // A branch is an address, not a verification result.
  it('gives the branch and worktree their own section instead of trailing evidence', () => {
    mockIssues = [
      {
        ...ROOT,
        branch: 'issue/554-host-resource-lifecycle-policy',
        gitState: {
          updatedAt: '2026-08-07T00:00:00.000Z',
          branch: 'issue/554-host-resource-lifecycle-policy',
          shared: false,
          dirtyFiles: 0,
        },
        panel: {
          todos: [{ text: 'Runtime verification', done: false }],
          artifacts: [],
          deferred: [],
        },
      },
      OPEN_CHILD,
      DONE_CHILD,
      GRANDCHILD,
    ]
    render(<IssuePanelView cwd="/r" />)

    const checkout = screen.getByTestId('dock-checkout')
    expect(within(checkout).getByText('issue/554-host-resource-lifecycle-policy')).toBeTruthy()
    expect(within(checkout).getByTitle('/r')).toBeTruthy()
    expect(
      within(screen.getByTestId('dock-evidence')).queryByText(
        'issue/554-host-resource-lifecycle-policy',
      ),
    ).toBeNull()
  })

  it('lists the agents and sessions working the task', () => {
    mockSessions = [session(), session({ sessionId: 's2', name: 'Flight deck builder' })]
    render(<IssuePanelView cwd="/r" />)

    const agents = screen.getByTestId('dock-sessions')
    expect(within(agents).getByText('Workspace coordinator')).toBeTruthy()
    expect(within(agents).getByText('Flight deck builder')).toBeTruthy()
    expect(within(agents).queryByTestId('dock-presence-note')).toBeNull()
  })

  it('folds the overflow and the retired sessions rather than listing everything', () => {
    mockSessions = [
      ...Array.from({ length: 6 }, (_, i) => session({ sessionId: `s${i}`, name: `Agent ${i}` })),
      session({ sessionId: 'gone', name: 'Retired agent', archived: true }),
    ]
    render(<IssuePanelView cwd="/r" />)

    const agents = screen.getByTestId('dock-sessions')
    expect(within(agents).queryByText('Agent 5')).toBeNull()
    fireEvent.click(within(agents).getByText(/1 more active/))
    expect(within(agents).getByText('Agent 5')).toBeTruthy()

    expect(within(agents).queryByText('Retired agent')).toBeNull()
    fireEvent.click(within(agents).getByText(/Retired · 1/))
    expect(within(agents).getByText('Retired agent')).toBeTruthy()
  })

  // The words come from mission.ts so the deck and the dock cannot drift; the
  // only amber case is in-progress work its agent vacated.
  it('explains an empty roster instead of leaving a blank section', () => {
    render(<IssuePanelView cwd="/r" />)

    const note = screen.getByTestId('dock-presence-note')
    expect(note.dataset.presence).toBe('attention')
    expect(note.textContent).toContain('Agent left · choose a handoff')
  })

  it('reads work that has not started as ready, not as abandoned', () => {
    mockIssues = [{ ...ROOT, stage: 'planning' }, OPEN_CHILD, DONE_CHILD, GRANDCHILD]
    render(<IssuePanelView cwd="/r" />)

    const note = screen.getByTestId('dock-presence-note')
    expect(note.dataset.presence).toBe('ready')
    expect(note.textContent).toContain('Ready to start')
  })

  // mission.ts is total over the stage vocabulary, so the dock keeps NO words of
  // its own for the empty case — a local fallback is exactly what would drift.
  it('takes even the unaccepted case from the shared vocabulary', () => {
    mockIssues = [{ ...ROOT, stage: 'proposed' }, OPEN_CHILD, DONE_CHILD, GRANDCHILD]
    render(<IssuePanelView cwd="/r" />)

    expect(screen.getByTestId('dock-presence-note').textContent).toContain('Proposed · not started')
  })

  it('says where the session went when it moved', () => {
    mockSessions = [session({ archived: true, handoffTarget: 'POD-612' })]
    render(<IssuePanelView cwd="/r" />)

    expect(screen.getByTestId('dock-presence-note').textContent).toContain(
      'Session moved to POD-612',
    )
  })

  it('raises the decision band only when the issue needs you', () => {
    render(<IssuePanelView cwd="/r" />)
    expect(screen.queryByTestId('dock-decision-band')).toBeNull()
    cleanup()

    mockIssues = [
      { ...ROOT, needsHuman: true, humanQuestion: 'Merge this or send it back?' },
      OPEN_CHILD,
      DONE_CHILD,
      GRANDCHILD,
    ]
    render(<IssuePanelView cwd="/r" />)
    const band = screen.getByTestId('dock-decision-band')
    expect(band.textContent).toContain('Needs you')
    expect(band.textContent).toContain('Merge this or send it back?')
  })

  it('asks the server for this issue events only', async () => {
    render(<IssuePanelView cwd="/r" />)

    const feed = await screen.findByTestId('dock-recent-activity')
    expect(eventsQuery).toHaveBeenCalledWith(expect.objectContaining({ subject: 'root' }))
    // The child's own creation event belongs to the child's feed, not this one.
    expect(await within(feed).findAllByText('created')).toHaveLength(1)
  })

  it('links out to the full activity', () => {
    render(<IssuePanelView cwd="/r" />)

    fireEvent.click(screen.getByTestId('dock-open-full-activity'))
    expect(setOpenIssueId).toHaveBeenCalledWith('root')
    expect(setView).toHaveBeenCalledWith('issues')
  })

  it('shows evidence only when the issue has any', () => {
    render(<IssuePanelView cwd="/r" />)
    expect(screen.queryByTestId('dock-evidence')).toBeNull()
    cleanup()

    mockIssues = [
      {
        ...ROOT,
        panel: {
          todos: [{ text: 'Runtime verification', done: false }],
          artifacts: [],
          deferred: [],
        },
      },
      OPEN_CHILD,
      DONE_CHILD,
      GRANDCHILD,
    ]
    render(<IssuePanelView cwd="/r" />)
    expect(
      within(screen.getByTestId('dock-evidence')).getByText('Runtime verification'),
    ).toBeTruthy()
  })
})

// A conversation that has not become a task is the NORMAL first state of a
// fresh agent, not a failure — the dock says what will appear, and never asks
// for a task to be created.
describe('IssuePanelView with no task', () => {
  it('takes shape instead of reporting a missing task', () => {
    mockSessions = [session({ sessionId: 'fresh', issueId: undefined, name: 'New Codex' })]
    render(<IssuePanelView cwd="/elsewhere" sessionId="fresh" />)

    expect(screen.getByTestId('dock-intake')).toBeTruthy()
    expect(screen.getByText('Conversation workspace')).toBeTruthy()
    expect(parts()).toEqual(['Taking shape'])
    expect(screen.getByText('Waiting for your first message')).toBeTruthy()
    expect(screen.getByText('New Codex · ready')).toBeTruthy()
    expect(screen.getByText(/Podium does not force a task/)).toBeTruthy()
    expect(document.body.textContent).not.toMatch(/no task|not found|error/i)
  })
})
