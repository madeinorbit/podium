// The panel reads through the real pool's issue-page views, so the real
// pool fixture must win over the hand-mock pool that mock-core-store-handle
// pulls in: the last store-worklist-pool mock wins, and the real fixture
// supports issue-page while the hand mock rejects it.
import '@/test-support/mock-core-store-handle'
import '@/test-support/mock-pool-fixture'
import '@/test-support/model-catalog-mock'
import type { SessionView } from '@podium/client-core/session-values'
// @vitest-environment happy-dom
import type { IssueEvent } from '@podium/client-core/values'

import { asIssueId, asSessionId } from '@podium/model'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DockHeaderSlotProvider } from '@/app/DockHeaderSlot'
import { OperatorFocusProvider } from '@/app/operator-focus'
import { ConfirmProvider } from '@/lib/hooks/use-confirm'
import { makeIssue } from '@/lib/test-issue'
import { IssuePanelView } from './IssuePanelView'

vi.mock('@/lib/use-feature', () => ({ useFeature: () => false }))

const openArtifactsTab = vi.hoisted(() => vi.fn())
vi.mock('@/features/files/artifacts-tab', () => ({ useOpenArtifactsTab: () => openArtifactsTab }))

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

/** Ids are branded on `SessionView`; fixtures are built from string literals,
 *  so the override side is the unbranded spelling. */
type SessionOverride = Partial<Omit<SessionView, 'sessionId' | 'issueId'>> & {
  sessionId?: string
  issueId?: string
}

const session = (over: SessionOverride = {}): SessionView =>
  ({
    sessionId: 's1',
    issueId: 'root',
    agentKind: 'claude-code',
    name: 'Workspace coordinator',
    archived: false,
    status: 'live',
    lastActiveAt: '2026-08-07T00:00:00.000Z',
    ...over,
  }) as unknown as SessionView

let mockIssues = [ROOT, OPEN_CHILD, DONE_CHILD, GRANDCHILD]
let mockSessions: SessionView[] = []

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
let commentRows: unknown[] = []
const commentsQuery = vi.fn(async () => commentRows)
// Honours `subject` the way the SQL does (POD-532), so a caller that forgets to
// send it fails here instead of quietly rendering another issue's history.
const eventsQuery = vi.fn(async (input?: unknown) => {
  const subject = (input as { subject?: string } | undefined)?.subject
  return subject ? eventRows.filter((row) => row.subject === subject) : eventRows
})

// The task head's launch box carries model + effort segments, and those read
// the live catalog through a hook that hangs off the REAL store provider rather
// than the mock below.
vi.mock('@/lib/use-model-catalog', () => ({
  useModelCatalog: () => ({}),
  useModelCatalogState: () => ({ catalog: {}, status: 'unavailable' }),
}))

vi.mock('@/app/store', () => {
  // The real owner retains its transport across snapshot reads. Recreating it
  // here restarts useIssueHistory's effect after each comments publication,
  // whose revision update renders another snapshot and starts the cycle again.
  const trpc = {
    issues: {
      // The mock factory is hoisted before commentRows initializes.
      comments: { query: () => commentsQuery() },
      // The mock factory is hoisted before eventsQuery initializes.
      events: { query: (input?: unknown) => eventsQuery(input) },
      start: { mutate: vi.fn(async () => ({})) },
      close: { mutate: vi.fn(async () => ({})) },
      update: { mutate: vi.fn(async () => ({})) },
      clearNeedsHuman: { mutate: vi.fn(async () => ({})) },
      panelApply: { mutate: vi.fn(async () => ({})) },
    },
    sessions: { sendText: { mutate: vi.fn(async () => ({})) } },
  }
  const state = () => ({
    trpc,
    httpOrigin: '',
    openFileInWorktree: vi.fn(),
    openArtifact: vi.fn(),
    uiState: { get: () => null, set: vi.fn(), subscribe: () => () => {} },
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
    useRuntimeSelector: (sel: (s: unknown) => unknown) => sel(state()),
  }
})

const parts = (): string[] =>
  [...document.querySelectorAll('[data-part]')].map((el) => el.getAttribute('data-part') ?? '')

beforeEach(() => {
  mockIssues = [ROOT, OPEN_CHILD, DONE_CHILD, GRANDCHILD]
  mockSessions = []
  eventRows = BASE_EVENT_ROWS
  commentRows = []
})

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe('IssuePanelView inspector', () => {
  // THE CALM COLUMN (POD-2077): head, description, the latest update, then
  // artifacts, relations, comments and cost. The roster, the activity log, the
  // branch address and the needs-you band all left the panel — the deck, the
  // chat and the footer already say those things.
  it('renders one scroll in the design order', () => {
    render(<IssuePanelView cwd="/r" />)

    expect(parts()).toEqual(['Current update', 'Comments', 'Cost'])
    for (const gone of ['dock-sessions', 'dock-checkout', 'dock-recent-activity']) {
      expect(screen.queryByTestId(gone)).toBeNull()
    }
  })

  it('keeps headings as text, not toggles', () => {
    render(<IssuePanelView cwd="/r" />)

    for (const title of ['Comments', 'Cost']) {
      expect(screen.getByText(title).closest('button')).toBeNull()
    }
  })

  it('names the task over its status and an uncapped description', () => {
    render(<IssuePanelView cwd="/r" />)

    const head = within(screen.getByTestId('dock-inspect-head'))
    // NO REF EYEBROW (POD-1457): the dock's trail prints the ref.
    expect(head.queryByText('#1')).toBeNull()
    const title = screen.getByTestId('dock-title')
    expect(title.textContent).toBe('Operator workspace')
    expect(title.className).toContain('line-clamp-3')
    expect(head.getByTestId('dock-subtasks-toggle').textContent).toBe('1 of 2 subtasks done')
    const description = screen.getByTestId('dock-description')
    expect(description.textContent).toBe('Rework the dock into one scroll.')
    expect(description.className).not.toContain('line-clamp')
  })

  it('folds the subtasks behind their count, one tier deep', () => {
    render(<IssuePanelView cwd="/r" />)

    expect(screen.queryByTestId('dock-subissues')).toBeNull()
    fireEvent.click(screen.getByTestId('dock-subtasks-toggle'))
    const work = screen.getByTestId('dock-subissues')
    expect(within(work).getByText('Flat sidebar')).toBeTruthy()
    expect(within(work).getByText('Tray removal')).toBeTruthy()
    // The grandchild belongs to its own parent's list, not this one.
    expect(within(work).queryByText('Rail badge')).toBeNull()
  })

  it('keeps an archived child visible, marked archived', () => {
    mockIssues = [ROOT, OPEN_CHILD, { ...DONE_CHILD, archived: true }, GRANDCHILD]
    render(<IssuePanelView cwd="/r" />)
    fireEvent.click(screen.getByTestId('dock-subtasks-toggle'))
    const archivedRow = within(screen.getByTestId('dock-subissues'))
      .getByText('Tray removal')
      .closest('button')
    expect(within(archivedRow as HTMLElement).getByText('archived')).toBeTruthy()
  })

  it('lists an archived parent under Relations, marked archived', () => {
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
    expect(within(parent).getByText('Parent')).toBeTruthy()
    expect(within(parent).getByText('Shipped epic')).toBeTruthy()
    expect(within(parent).getByText('archived')).toBeTruthy()
  })

  it('groups relations by kind and prints each label once', () => {
    const blockerA = makeIssue({ id: 'b1', repoPath: '/r', seq: 20, title: 'First blocker' })
    const blockerB = makeIssue({ id: 'b2', repoPath: '/r', seq: 21, title: 'Second blocker' })
    mockIssues = [
      {
        ...ROOT,
        deps: [
          { id: 'b1' as never, type: 'blocked-by' },
          { id: 'b2' as never, type: 'blocked-by' },
        ],
      },
      OPEN_CHILD,
      DONE_CHILD,
      GRANDCHILD,
      blockerA,
      blockerB,
    ]
    render(<IssuePanelView cwd="/r" />)

    const relations = within(screen.getByTestId('dock-relations'))
    expect(relations.getAllByText('Blocked by')).toHaveLength(1)
    expect(relations.getByText('First blocker')).toBeTruthy()
    expect(relations.getByText('Second blocker')).toBeTruthy()
    expect(relations.getByText('#21')).toBeTruthy()
  })

  // Amber, in the same place the sidebar and the Flight Deck put it.
  it('marks a subtask that needs the operator in attention ink', () => {
    mockIssues = [ROOT, { ...OPEN_CHILD, needsHuman: true }, DONE_CHILD, GRANDCHILD]
    render(<IssuePanelView cwd="/r" />)
    fireEvent.click(screen.getByTestId('dock-subtasks-toggle'))

    const work = within(screen.getByTestId('dock-subissues'))
    expect(work.getByText('Needs you').className).toContain('text-attention')
  })

  // The update is a quiet, clamped block: the chat beside the panel narrates
  // the work, and the offer card in chat is where a decision is asked for.
  it('clamps the update and raises no needs-you band', () => {
    mockIssues = [{ ...ROOT, needsHuman: true }, OPEN_CHILD, DONE_CHILD, GRANDCHILD]
    render(<IssuePanelView cwd="/r" />)

    const update = screen.getByTestId('dock-current-update')
    expect(update.textContent).toContain('Agent status')
    expect(update.textContent).toContain('Spine direction is fixed')
    const body = screen.getByTestId('dock-current-update-body')
    expect(body.className).toContain('line-clamp-4')
    fireEvent.click(body)
    expect(body.className).not.toContain('line-clamp-4')
    expect(screen.queryByTestId('dock-decision-band')).toBeNull()
    expect(screen.queryByText('Needs you')).toBeNull()
  })

  it('drops the update block when nothing has been posted', () => {
    mockIssues = [{ ...ROOT, activityNotes: '' }, OPEN_CHILD, DONE_CHILD, GRANDCHILD]
    render(<IssuePanelView cwd="/r" />)
    expect(screen.queryByTestId('dock-current-update')).toBeNull()
  })

  it('shows the comment thread over an add-a-comment field', async () => {
    commentRows = [
      {
        id: 'c1',
        author: 'Martin Kuehn',
        body: 'Hold until legal signs off.',
        createdAt: '2026-08-07T00:00:00.000Z',
      },
      { id: 'c2', author: 'steward', body: 'Noted.', createdAt: '2026-08-07T00:05:00.000Z' },
    ] as never
    render(<IssuePanelView cwd="/r" />)

    const comments = within(screen.getByTestId('dock-comments'))
    expect(await comments.findByText('Hold until legal signs off.')).toBeTruthy()
    expect(comments.getByText('Martin Kuehn')).toBeTruthy()
    expect(comments.getByText('MK')).toBeTruthy()
    expect(comments.getByText('Steward')).toBeTruthy()
    expect(comments.getByPlaceholderText('Add a comment…')).toBeTruthy()
    // Comments only: the panel asks for no event pages.
    expect(eventsQuery).not.toHaveBeenCalled()
  })

  it('puts Open in Work in the dock title bar, and nowhere else', () => {
    // THE ISOLATION RULE (POD-1457): the one crossing goes to WORK.
    const host = document.createElement('div')
    document.body.appendChild(host)
    render(
      <DockHeaderSlotProvider value={host}>
        <OperatorFocusProvider missionId="root">
          <IssuePanelView cwd="/r" onNavigate={vi.fn()} />
        </OperatorFocusProvider>
      </DockHeaderSlotProvider>,
    )

    const open = within(host).getByTestId('task-open-in-work')
    expect(open.getAttribute('aria-label')).toBe('Open in Work')
    fireEvent.click(open)
    expect(setView).toHaveBeenCalledWith('workspace')
    expect(setView).not.toHaveBeenCalledWith('issues')
    host.remove()
  })

  // What the work PRODUCED and what it parked — never the agent's todo list
  // (POD-1071).
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
    const artifacts = within(screen.getByTestId('dock-artifacts'))
    expect(artifacts.getByText('Spine direction')).toBeTruthy()
    expect(artifacts.getByText('08-07')).toBeTruthy()
    expect(
      within(screen.getByTestId('dock-deferred')).getByText('Second pass on the rail'),
    ).toBeTruthy()
    expect(screen.queryByText('Runtime verification')).toBeNull()
  })

  it('lists a few artifacts, newest first, and hands View all to the host', () => {
    const artifacts = Array.from({ length: 5 }, (_, i) => ({
      path: `docs/note-${i}.md`,
      title: `Note ${i}`,
      addedAt: `2026-08-0${i + 1}T00:00:00.000Z`,
    }))
    mockIssues = [
      { ...ROOT, panel: { todos: [], artifacts, deferred: [] } },
      OPEN_CHILD,
      DONE_CHILD,
      GRANDCHILD,
    ]
    const onViewAll = vi.fn()
    render(<IssuePanelView cwd="/r" onViewAllArtifacts={onViewAll} />)

    const section = within(screen.getByTestId('dock-artifacts'))
    expect(section.getAllByTestId('dock-artifact-row').map((r) => r.textContent)).toEqual([
      'Note 408-05',
      'Note 308-04',
      'Note 208-03',
    ])
    fireEvent.click(section.getByTestId('dock-artifacts-view-all'))
    expect(onViewAll).toHaveBeenCalledWith('root')
  })

  it('opens the Artifacts stage tab when no host opener is given', () => {
    const artifacts = Array.from({ length: 5 }, (_, i) => ({
      path: `docs/note-${i}.md`,
      title: `Note ${i}`,
      addedAt: `2026-08-0${i + 1}T00:00:00.000Z`,
    }))
    mockIssues = [
      { ...ROOT, panel: { todos: [], artifacts, deferred: [] } },
      OPEN_CHILD,
      DONE_CHILD,
      GRANDCHILD,
    ]
    render(<IssuePanelView cwd="/r" />)

    const section = within(screen.getByTestId('dock-artifacts'))
    expect(section.getAllByTestId('dock-artifact-row')).toHaveLength(3)
    fireEvent.click(section.getByTestId('dock-artifacts-view-all'))
    expect(openArtifactsTab).toHaveBeenCalledWith(ROOT.id, '/r')
  })
})

// An id that resolves to no task gets the panel's one quiet empty state — not
// an intake form, and not an error.
describe('IssuePanelView with no task', () => {
  it('renders the empty state', () => {
    mockSessions = [session({ sessionId: 'fresh', issueId: undefined, name: 'New Codex' })]
    render(<IssuePanelView cwd="/elsewhere" sessionId={asSessionId('fresh')} />)

    expect(screen.getByTestId('dock-issue-empty')).toBeTruthy()
    expect(screen.queryByTestId('dock-intake')).toBeNull()
    expect(document.body.textContent).not.toMatch(/Conversation workspace|Taking shape/)
    expect(document.body.textContent).not.toMatch(/not found|error/i)
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
