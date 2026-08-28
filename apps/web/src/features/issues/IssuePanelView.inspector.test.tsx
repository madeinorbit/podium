// @vitest-environment happy-dom
import type { IssueEvent } from '@podium/client-core/viewmodels'
import type { SessionMeta } from '@podium/model'
import { asIssueId, asSessionId } from '@podium/model'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { OperatorFocusProvider } from '@/app/operator-focus'
import { ConfirmProvider } from '@/lib/hooks/use-confirm'
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
const updateIssue = vi.fn(async () => ({}))

const BASE_EVENT_ROWS: IssueEvent[] = [
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
let eventRows = BASE_EVENT_ROWS
// Honours `subject` the way the SQL does (POD-532), so a caller that forgets to
// send it fails here instead of quietly rendering another issue's history.
const eventsQuery = vi.fn(async (input?: unknown) => {
  const subject = (input as { subject?: string } | undefined)?.subject
  return subject ? eventRows.filter((row) => row.subject === subject) : eventRows
})

// The task head's launch box carries model + effort segments, and those read
// the live catalog through a hook that hangs off the REAL store provider rather
// than the mock below.
vi.mock('@/lib/use-model-catalog', () => ({ useModelCatalog: () => ({}) }))

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
    setSelectedIssueId: vi.fn(),
    setView,
    setOpenIssueId,
    navigateToSession: vi.fn(),
    renameSession: vi.fn(async () => {}),
    archiveSession: vi.fn(async () => {}),
    markIssueRead: vi.fn(),
    markIssueUnread: vi.fn(),
    markSessionRead: vi.fn(),
    updateIssue,
    closeIssue: vi.fn(async () => ({})),
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
  eventRows = BASE_EVENT_ROWS
})

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe('IssuePanelView inspector', () => {
  // POD-743 re-ordered this scroll. It used to run by how fast each fact moves,
  // which put the evidence below two sections of roster; that was right when
  // this panel was the only place a task's shape was visible. The Flight Deck
  // draws the shape now, so what the operator came here to do — judge the work
  // and act on it — comes first, and the structure the deck already shows sits
  // underneath as reference.
  it('renders one scroll, judgement first and structure underneath', () => {
    render(<IssuePanelView cwd="/r" />)

    expect(parts()).toEqual([
      'Current update',
      'Recent activity',
      'Subtasks',
      'Relations',
      'Agents & sessions',
      'Branch & worktree',
    ])
  })

  it('drops the collapsible section chrome — headings are text, not toggles', () => {
    render(<IssuePanelView cwd="/r" />)

    for (const title of ['Current update', 'Agents & sessions', 'Relations']) {
      expect(screen.getByText(title).closest('button')).toBeNull()
    }
  })

  // The TITLE came back to the panel in POD-743: the dock title bar carries the
  // explorer's trail now, which is a position rather than a name. It is bounded
  // at two lines because this head sits above the single scroll and anything
  // unbounded up here comes out of the scroll's budget; the description stays
  // uncapped, down in the scroll where there is no budget to protect.
  it('names the task in a two-line head, over an uncapped description', () => {
    render(<IssuePanelView cwd="/r" />)

    const head = within(screen.getByTestId('dock-inspect-head'))
    // NO REF EYEBROW (POD-1457). The dock's trail prints the same ref twenty
    // pixels above this head, so the panel used to open by saying the same
    // thing twice in the same mono grey.
    expect(head.queryByText('#1')).toBeNull()
    const title = screen.getByTestId('dock-title')
    expect(title.textContent).toBe('Operator workspace')
    expect(title.className).toContain('line-clamp-2')
    const description = screen.getByTestId('dock-description')
    expect(description.textContent).toBe('Rework the dock into one scroll.')
    expect(description.className).not.toContain('line-clamp')
    // ...and the head still does not name the panel it is already inside.
    expect(head.queryByText('Task')).toBeNull()
    expect(screen.queryByText('P2')).toBeNull()
    expect(screen.queryByText(/subissues done/)).toBeNull()
  })

  it('keeps an archived child visible in the explorer, marked archived', () => {
    mockIssues = [ROOT, OPEN_CHILD, { ...DONE_CHILD, archived: true }, GRANDCHILD]
    render(<IssuePanelView cwd="/r" />)
    const work = screen.getByTestId('dock-subissues')
    fireEvent.click(within(work).getByText(/Show 1 completed/))
    const archivedRow = within(work).getByText('Tray removal').closest('button')
    expect(archivedRow).toBeTruthy()
    expect(within(archivedRow as HTMLElement).getByText('archived')).toBeTruthy()
  })

  it('keeps an archived parent visible in the explorer, marked archived', () => {
    const archivedParent = makeIssue({
      id: 'epic',
      seq: 10,
      title: 'Shipped epic',
      archived: true,
      stage: 'done',
    })
    const orphaned = makeIssue({
      id: 'child',
      seq: 11,
      title: 'Promoted child',
      parentId: 'epic',
      worktreePath: '/r/child',
    })
    mockIssues = [archivedParent, orphaned]
    render(<IssuePanelView cwd="/r/child" issueId={orphaned.id} />)

    const parent = screen.getByTestId('dock-parent')
    expect(within(parent).getByText('Shipped epic')).toBeTruthy()
    expect(within(parent).getByText('archived')).toBeTruthy()
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
  it('keeps the update to its words and its age, and offers no exit to the Tasks tool', () => {
    mockSessions = [session()]
    render(<IssuePanelView cwd="/r" />)

    const update = screen.getByTestId('dock-current-update')
    expect(update.textContent).toContain('Spine direction is fixed')
    expect(update.textContent).not.toContain('Workspace coordinator')
    // The "Full update timeline" link crossed into the Tasks tool, and this
    // panel does not link there any more (POD-1457) — entering that tool is a
    // decision the operator makes in the toolbar. Recent activity is the next
    // section down, so nothing left this column.
    expect(screen.queryByTestId('dock-open-full-activity')).toBeNull()
    expect(screen.getByTestId('dock-recent-activity')).toBeTruthy()
  })

  // A branch is an address, not a verification result.
  it('gives the branch and worktree their own section instead of trailing the artifacts', () => {
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
          todos: [],
          artifacts: [
            { path: 'docs/runtime-verification.md', addedAt: '2026-08-07T00:00:00.000Z' },
          ],
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
      within(screen.getByTestId('dock-artifacts')).queryByText(
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

  it('keeps semantic updates when later read receipts arrive', async () => {
    eventRows = [
      BASE_EVENT_ROWS[0]!,
      {
        id: 3,
        ts: '2026-08-07T00:02:00.000Z',
        kind: 'issue.stage_changed',
        subject: 'root',
        repoPath: '/r',
        payload: { to: 'review' },
      },
      ...Array.from({ length: 6 }, (_, index) => ({
        id: 10 + index,
        ts: `2026-08-07T00:${String(10 + index).padStart(2, '0')}:00.000Z`,
        kind: 'issue.read',
        subject: 'root',
        repoPath: '/r',
        payload: null,
      })),
    ]
    render(<IssuePanelView cwd="/r" />)

    const feed = await screen.findByTestId('dock-recent-activity')
    expect(within(feed).getByText('moved to Review')).toBeTruthy()
    expect(within(feed).getByText('created')).toBeTruthy()
    expect(within(feed).queryByText('read')).toBeNull()
  })

  it('names the crossing after the view it opens, and offers no other', () => {
    // THE ISOLATION RULE (POD-1457). The explorer is a place to read tasks from;
    // the Tasks tool is a place you go on purpose, from the toolbar. The one
    // crossing this panel offers goes to WORK, and it says so in the label.
    render(
      <OperatorFocusProvider missionId="root">
        <IssuePanelView cwd="/r" onNavigate={vi.fn()} />
      </OperatorFocusProvider>,
    )

    expect(screen.getByTestId('task-open-in-work').textContent).toContain('Open in Work')
    fireEvent.click(screen.getByTestId('task-open-in-work'))
    expect(setView).toHaveBeenCalledWith('workspace')
    expect(setView).not.toHaveBeenCalledWith('issues')
  })

  // The dock shows what the work PRODUCED and what it parked. An agent's todo
  // list is not one of those — it is the agent's own plan, and the dock stopped
  // rendering it (POD-1071); the full issue page is where it still lives.
  it('shows artifacts and deferred notes only when the issue has any, and never todos', () => {
    render(<IssuePanelView cwd="/r" />)
    expect(screen.queryByTestId('dock-artifacts')).toBeNull()
    expect(screen.queryByTestId('dock-deferred')).toBeNull()
    cleanup()

    mockIssues = [
      {
        ...ROOT,
        panel: {
          todos: [{ text: 'Runtime verification', done: false }],
          artifacts: [
            {
              path: 'docs/spine.md',
              title: 'Spine direction',
              addedAt: '2026-08-07T00:00:00.000Z',
            },
          ],
          deferred: [{ text: 'Second pass on the rail', addedAt: '2026-08-07T00:00:00.000Z' }],
        },
      },
      OPEN_CHILD,
      DONE_CHILD,
      GRANDCHILD,
    ]
    render(<IssuePanelView cwd="/r" />)
    expect(within(screen.getByTestId('dock-artifacts')).getByText('Spine direction')).toBeTruthy()
    expect(
      within(screen.getByTestId('dock-deferred')).getByText('Second pass on the rail'),
    ).toBeTruthy()
    expect(screen.queryByText('Runtime verification')).toBeNull()
  })
})

// An id that resolves to no task is not a state worth describing: the panel
// renders the explorer's own level 0, which is what "no task" looks like
// everywhere else in this dock and is a place the operator can act from.
describe('IssuePanelView with no task', () => {
  it('renders the task index, not an empty state of its own', () => {
    mockSessions = [session({ sessionId: 'fresh', issueId: undefined, name: 'New Codex' })]
    render(<IssuePanelView cwd="/elsewhere" sessionId={asSessionId('fresh')} />)

    expect(screen.getByTestId('explorer-list')).toBeTruthy()
    expect(screen.queryByTestId('dock-intake')).toBeNull()
    expect(document.body.textContent).not.toMatch(/Conversation workspace|Taking shape/)
    expect(document.body.textContent).not.toMatch(/no task|not found|error/i)
  })

  it('shows an archived task rather than substituting another (POD-1277)', () => {
    const archived = makeIssue({
      id: 'arch',
      repoPath: '/r',
      seq: 99,
      title: 'Retired sweep',
      archived: true,
    })
    mockIssues = [ROOT, archived]
    mockSessions = [session({ sessionId: 'live', issueId: ROOT.id })]
    render(<IssuePanelView cwd="/r" sessionId={asSessionId('live')} issueId={asIssueId('arch')} />)

    expect(screen.getByText('Retired sweep')).toBeTruthy()
    expect(screen.queryByTestId('dock-intake')).toBeNull()
  })
})

// POD-1618. The composer mints a draft with the literal title "Draft" and the
// agent is supposed to retitle it; plenty never do. The sidebar has always
// substituted the attached session's name for that placeholder, so a task the
// operator sees named in one column read "Draft" in this panel — the same task
// wearing two names, which reads as two tasks rather than one unnamed one.
describe('IssuePanelView draft naming', () => {
  const DRAFT = makeIssue({
    id: 'd1',
    repoPath: '/r',
    seq: 1609,
    title: 'Draft',
    draft: true,
    worktreePath: null,
    memberSessionIds: ['sd'],
  })

  beforeEach(() => {
    mockIssues = [DRAFT]
    mockSessions = [
      session({ sessionId: 'sd', issueId: 'd1', name: 'Artifact directive provenance' }),
    ]
  })

  it('names a draft with its agent name, exactly as the sidebar row does', () => {
    render(<IssuePanelView cwd="/r" issueId={asIssueId('d1')} />)

    const title = screen.getByTestId('dock-title')
    expect(title.textContent).toBe('Artifact directive provenance')
    expect(title.textContent).not.toBe('Draft')
  })

  // The editor opens on what is SHOWN. A field that offered the word "Draft" to
  // edit, under a heading reading something else, is an editor for another row.
  it('seeds the rename editor with the name on screen, not the stored title', () => {
    render(<IssuePanelView cwd="/r" issueId={asIssueId('d1')} />)

    fireEvent.doubleClick(screen.getByTestId('dock-title'))

    const field = screen.getByDisplayValue('Artifact directive provenance')
    expect(field).toBeTruthy()
    expect(screen.queryByTestId('dock-title')).toBeNull()
  })

  // The commit policy is `use-inline-rename`'s, shared with the sidebar: an
  // editor opened by a fumbled double-click and closed by clicking away must
  // not spend a write on a name that did not change.
  it('writes an edited name and no-ops an unchanged one', () => {
    render(<IssuePanelView cwd="/r" issueId={asIssueId('d1')} />)

    fireEvent.doubleClick(screen.getByTestId('dock-title'))
    fireEvent.blur(screen.getByDisplayValue('Artifact directive provenance'))
    expect(updateIssue).not.toHaveBeenCalled()

    fireEvent.doubleClick(screen.getByTestId('dock-title'))
    const field = screen.getByDisplayValue('Artifact directive provenance')
    fireEvent.change(field, { target: { value: '  Artifact provenance  ' } })
    fireEvent.keyDown(field, { key: 'Enter' })

    expect(updateIssue).toHaveBeenCalledWith('d1', { title: 'Artifact provenance' })
  })

  // Escape is the way out that writes nothing, and the head comes back.
  it('restores the heading on Escape', () => {
    render(<IssuePanelView cwd="/r" issueId={asIssueId('d1')} />)

    fireEvent.doubleClick(screen.getByTestId('dock-title'))
    fireEvent.keyDown(screen.getByDisplayValue('Artifact directive provenance'), { key: 'Escape' })

    expect(screen.getByTestId('dock-title').textContent).toBe('Artifact directive provenance')
    expect(updateIssue).not.toHaveBeenCalled()
  })

  // THE OPTIMISTIC BEAT. `issues.update` paints the title through the outbox
  // overlay and nothing else; the draft flag is the SERVER's to clear. Reading
  // the flag alone, a rename would land, paint nothing, and then change the name
  // on its own a round trip later — so the client applies the server's own rule
  // (a named draft is not a draft) rather than waiting to be told it applied.
  it('shows a named draft by its name while the flag is still set', () => {
    mockIssues = [makeIssue({ ...DRAFT, title: 'Artifact provenance' })]

    render(<IssuePanelView cwd="/r" issueId={asIssueId('d1')} />)

    expect(screen.getByTestId('dock-title').textContent).toBe('Artifact provenance')
  })

  // A DRAFT WITH NO NAME AT ALL. `issues.update` takes `title` as a bare
  // optional string and promotes on `trim()` while assigning the raw value, so
  // `--title "   "` leaves a whitespace-titled draft. Printing that would render
  // a task with no name — worse than the placeholder this rule replaces.
  it('treats a whitespace-titled draft as unnamed too', () => {
    mockIssues = [makeIssue({ ...DRAFT, title: '   ' })]

    render(<IssuePanelView cwd="/r" issueId={asIssueId('d1')} />)

    expect(screen.getByTestId('dock-title').textContent).toBe('Artifact directive provenance')
  })

  // The menu entry exists only because the head has an editor for it to open —
  // `renameEnabled` is literally "was an `onRename` supplied", and this panel
  // used to supply none.
  it('offers Rename in the head menu, and it opens the editor', async () => {
    // The shared issue menu reaches for the confirm context AppShell supplies.
    render(
      <ConfirmProvider>
        <IssuePanelView cwd="/r" issueId={asIssueId('d1')} />
      </ConfirmProvider>,
    )

    fireEvent.click(screen.getByLabelText('More issue actions'))
    const rename = await screen.findByText('Rename')
    fireEvent.click(rename)

    expect(screen.getByDisplayValue('Artifact directive provenance')).toBeTruthy()
  })
})
