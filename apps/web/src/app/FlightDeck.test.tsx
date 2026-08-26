// @vitest-environment happy-dom
import type { SessionMeta } from '@podium/model'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { IssueExplorerProvider } from '@/features/issues/explorer/explorer-context'
import { ConfirmProvider } from '@/lib/hooks/use-confirm'
import { DOUBLE_CLICK_MS } from './click-intent'
import {
  continuationPresenceLine,
  deckTaskUnread,
  defaultFolded,
  FlightDeck,
  isFolded,
  readFolds,
  writeFolds,
} from './FlightDeck'
import { OperatorFocusProvider } from './operator-focus'
import { clearHoveredSession, setHoveredSession } from './session-hover'
import { REVEAL_IN_DECK_EVENT, RIGHT_PANEL_KEY } from './shell-state'

/**
 * The deck's own click grammar and fold defaults (POD-710 §4.1–4.4).
 *
 * The pipeline underneath is real — `buildFlightDeckRows`, `treeGuides`,
 * `deckIssueState` and the rest all run against the fixtures below — so a change
 * in the viewmodel that breaks the deck's assumptions shows up here rather than
 * being papered over by a stub.
 */

const harness = vi.hoisted(() => ({
  issues: [] as unknown[],
  sessions: [] as unknown[],
  // The mission's `Add agent` reads these to decide which harnesses its hosts can
  // actually run (POD-1201). Empty is the unscoped case — nothing known, so
  // nothing refused — and every test but the harness one leaves them that way.
  repos: [] as unknown[],
  machines: [] as unknown[],
  selectedIssueId: null as string | null,
  paneA: null as string | null,
  openSessionTab: vi.fn(),
  focusIssueSession: vi.fn(async () => null),
  setPanelMode: vi.fn(),
  preferPanelMode: vi.fn(),
  setSelectedIssueId: vi.fn(),
  setIssueTucked: vi.fn(async () => undefined),
  updateIssue: vi.fn(async (_id: string, _patch: unknown) => undefined),
  closeIssue: vi.fn(async (_id: string, _reason?: string) => undefined),
  ui: new Map<string, string>(),
  listeners: new Set<() => void>(),
  setPlacement: vi.fn(async (_input: unknown) => undefined),
  startIssue: vi.fn(async (_input: unknown) => undefined),
  addSession: vi.fn(async (_input: unknown) => undefined),
  trpc: {
    features: { state: { query: async () => null } },
    issues: {
      setPlacement: { mutate: (input: unknown) => harness.setPlacement(input) },
      start: { mutate: (input: unknown) => harness.startIssue(input) },
      addSession: { mutate: (input: unknown) => harness.addSession(input) },
    },
  } as unknown,
}))

const uiState = {
  get: (key: string): string | null => harness.ui.get(key) ?? null,
  set: (key: string, value: string | null): void => {
    if (value === null) harness.ui.delete(key)
    else harness.ui.set(key, value)
    for (const listener of harness.listeners) listener()
  },
  subscribe: (cb: () => void): (() => void) => {
    harness.listeners.add(cb)
    return () => {
      harness.listeners.delete(cb)
    }
  },
}

vi.mock('./store', () => ({
  useStoreSelector: (select: (store: Record<string, unknown>) => unknown) =>
    select({
      sessions: harness.sessions,
      repos: harness.repos,
      selectedIssueId: harness.selectedIssueId,
      paneA: harness.paneA,
      paneB: null,
      split: false,
      drafts: {},
      coarseNow: Date.parse('2026-01-01T00:10:00.000Z'),
      uiState,
      setSelectedWorktree: vi.fn(),
      setSelectedIssueId: harness.setSelectedIssueId,
      openSessionTab: harness.openSessionTab,
      focusIssueSession: harness.focusIssueSession,
      setPanelMode: harness.setPanelMode,
      preferPanelMode: harness.preferPanelMode,
      setView: vi.fn(),
      markIssueRead: vi.fn(async () => undefined),
      markIssueUnread: vi.fn(async () => undefined),
      updateIssue: harness.updateIssue,
      deleteIssue: vi.fn(async () => undefined),
      closeIssue: harness.closeIssue,
      deferIssue: vi.fn(async () => undefined),
      undeferIssue: vi.fn(async () => undefined),
      setIssueLabels: vi.fn(async () => undefined),
      setIssuePlacement: (id: string, placement: string, originId: string) =>
        harness.setPlacement({ id, placement, originId }),
      restoreIssue: vi.fn(async () => undefined),
      markSessionRead: vi.fn(async () => undefined),
      setIssueTucked: harness.setIssueTucked,
      renameSession: vi.fn(async () => undefined),
      // The shared task menu and `Add agent` read these; the deck's own
      // projection never does.
      machines: harness.machines,
      trpc: harness.trpc,
    }),
  useReplicaIssues: () => harness.issues,
  useSessionDraft: () => '',
}))

type Issue = Record<string, unknown>

const issue = (id: string, over: Issue = {}): Issue => ({
  id,
  seq: Number(id.replace(/\D/g, '')) || 1,
  displayRef: id.toUpperCase(),
  title: `Task ${id}`,
  stage: 'in_progress',
  archived: false,
  deletedAt: null,
  parentId: null,
  memberSessionIds: [],
  updatedAt: '2026-01-01T00:00:00.000Z',
  readAt: '2026-01-01T00:10:00.000Z',
  unread: false,
  // Carried because the shared task menu reads them off the view model; the
  // deck's own projection never looks at either.
  labels: [],
  deps: [],
  ...over,
})

/** Fixtures are shaped, not branded: the ids here are plain strings, so the
 *  overrides come in loose and the cast happens once, at the boundary. */
const session = (id: string, over: Record<string, unknown> = {}): SessionMeta =>
  ({
    sessionId: id,
    agentKind: 'claude-code',
    status: 'live',
    cwd: '/repo',
    name: id,
    title: id,
    unread: false,
    archived: false,
    lastActiveAt: '2026-01-01T00:00:00.000Z',
    createdAt: '2026-01-01T00:00:00.000Z',
    ...over,
  }) as unknown as SessionMeta

/** An agent mid-turn — what `Working` asks about, once per agent (POD-1452). */
const WORKING = { phase: 'working', since: '2026-01-01T00:00:00.000Z' } as const

const deck = (): void => {
  render(
    // ConfirmProvider because the task menu's Archive/Delete now use the
    // app-wide dialog (POD-1077), exactly as AppShell supplies it in the app.
    <ConfirmProvider>
      <OperatorFocusProvider missionId="root">
        {/* The explorer's stack lives above the dock in the app, and the deck
            reads it to know which task the dock is already showing — so the
            harness supplies the real provider rather than the default context. */}
        <IssueExplorerProvider>
          <FlightDeck onCollapse={vi.fn()} />
        </IssueExplorerProvider>
      </OperatorFocusProvider>
    </ConfirmProvider>,
  )
}

/** The single-click action is deferred by the double-click window. */
const settle = (): void => {
  act(() => {
    vi.advanceTimersByTime(400)
  })
}

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true })
  harness.ui.clear()
  harness.listeners.clear()
  harness.repos = []
  harness.machines = []
  harness.selectedIssueId = 'root'
  harness.paneA = null
  harness.openSessionTab.mockClear()
  harness.focusIssueSession.mockClear()
  harness.setPanelMode.mockClear()
  harness.preferPanelMode.mockClear()
  harness.setSelectedIssueId.mockClear()
  harness.setIssueTucked.mockClear()
  harness.updateIssue.mockClear()
  harness.closeIssue.mockClear()
  harness.startIssue.mockClear()
  harness.addSession.mockClear()
  harness.setPlacement.mockClear()
  harness.issues = [
    issue('root', { title: 'Mission' }),
    // One session, no children — the strip that should arrive CLOSED.
    issue('t1', { parentId: 'root', memberSessionIds: ['s1'] }),
    // Two sessions — arrives open.
    issue('t2', { parentId: 'root', memberSessionIds: ['s2', 's3'] }),
    // A branch — arrives open even though it carries one session.
    issue('t3', { parentId: 'root', memberSessionIds: ['s4'] }),
    issue('t4', { parentId: 't3' }),
    issue('p1', { parentId: 'root', stage: 'proposed', title: 'Proposed thing' }),
  ]
  harness.sessions = [
    session('s1', { issueId: 't1' }),
    session('s2', { issueId: 't2' }),
    session('s3', { issueId: 't2' }),
    session('s4', { issueId: 't3' }),
  ]
})

/** Torn down after each test — a window listener outlives the render. */
const afterEachListeners: Array<() => void> = []

afterEach(() => {
  for (const off of afterEachListeners.splice(0)) off()
  cleanup()
  vi.useRealTimers()
})

const chevron = (title: string): HTMLElement =>
  screen.getByRole('button', { name: new RegExp(`^(Expand|Collapse) ${title}$`) })

describe('the cold deck (POD-1112)', () => {
  /** The composer's placeholder: a draft issue minted so a session has somewhere
   *  to live. After a reload the selection can still point at one whose session
   *  never started. */
  const vessel = (over: Issue = {}): Issue =>
    issue('v1', { title: 'Draft', stage: 'backlog', draft: true, ...over })

  it('shows the empty state for a selection left on an empty draft vessel', () => {
    harness.issues = [vessel()]
    harness.sessions = []
    harness.selectedIssueId = 'v1'
    deck()
    expect(screen.getByTestId('flight-empty')).toBeTruthy()
    // Not the mission chrome the vessel used to get: no header, no view bar.
    expect(screen.queryByText('Draft')).toBeNull()
    expect(screen.queryByText('Full spine')).toBeNull()
  })

  it('still shows the mission once the vessel has its session', () => {
    harness.issues = [vessel({ memberSessionIds: ['s-new'] })]
    harness.sessions = [session('s-new', { issueId: 'v1' })]
    harness.selectedIssueId = 'v1'
    deck()
    expect(screen.queryByTestId('flight-empty')).toBeNull()
    expect(screen.getByText('Full spine')).toBeTruthy()
  })

  it('shows the empty state when nothing at all is selected', () => {
    harness.selectedIssueId = null as unknown as string
    deck()
    expect(screen.getByTestId('flight-empty')).toBeTruthy()
  })
})

describe("the mission's brief (POD-1455)", () => {
  const brief = (): HTMLElement => screen.getByTestId('deck-brief')

  it('keeps the shape the author wrote — a lead-in, then a list', () => {
    harness.issues = [
      issue('root', {
        title: 'Mission',
        description: 'in the footer bar: make sure:\n\n- agents count is live\n- burn: the same',
      }),
    ]
    harness.sessions = []
    deck()
    const el = brief()
    expect(el.querySelectorAll('li')).toHaveLength(2)
    expect(el.querySelector('li')?.textContent).toBe('agents count is live')
    // The hyphens are the list now, not text with hyphens in it.
    expect(el.textContent).not.toContain('- agents count')
  })

  it('breaks a single newline, because a brief is written the way it is typed', () => {
    harness.issues = [issue('root', { title: 'Mission', description: 'first line\nsecond line' })]
    harness.sessions = []
    deck()
    expect(brief().querySelectorAll('br')).toHaveLength(1)
  })

  /* NEITHER IS THE TOGGLE. `Show more` appears only when the brief overflows its
     ceiling, and happy-dom has no layout: every box measures zero, so nothing
     ever overflows and the control is correctly absent in every case this file
     can construct. Driven in Chromium instead, against the harness fixture whose
     description is long enough to bind the cap: shut, the brief measures 243px
     of 454px and the control reads `Show more`; opened, 454px with the header at
     597px and the spine pushed down to what is left; shut again, back to 243px
     and `Show more`. */

  /* THE ANCHOR-AND-SCRIPT HALF OF `renderReadoutMarkdown` IS NOT TESTABLE HERE.
     DOMPurify decides at import whether the environment supports it, and under
     happy-dom it does not — `sanitize` hands the input straight back, so a
     `queryByRole('link')` assertion in this file would pass or fail for reasons
     that have nothing to do with this component. Verified in a real browser
     instead (Chromium, against the deck harness): a description carrying
     `[the spec](https://example.com/spec)`, a `<script>` and an `<img onerror>`
     renders as `<p>see the spec </p>` and the list below it, with the link's
     words kept and every tag gone. What IS environment-independent — that the
     structure the author wrote survives — is what the tests here assert. */

  it("marks the column's standing sentence as not the operator's words", () => {
    harness.issues = [issue('root', { title: 'Mission' })]
    harness.sessions = []
    deck()
    expect(brief().getAttribute('data-standing')).toBe('true')
  })

  it('drops the standing mark the moment somebody writes one', () => {
    harness.issues = [issue('root', { title: 'Mission', description: 'Ship the footer.' })]
    harness.sessions = []
    deck()
    expect(brief().getAttribute('data-standing')).toBeNull()
  })

  it('draws the line that ends the brief in every state', () => {
    harness.issues = [issue('root', { title: 'Mission', description: 'Ship the footer.' })]
    harness.sessions = []
    deck()
    expect(document.querySelector('.deck-brief-rule')).toBeTruthy()
    // Nothing is cut in a box with no layout, so the toggle stays away — which
    // is the same answer the browser gives for a brief that fits.
    expect(screen.queryByTestId('deck-brief-more')).toBeNull()
  })

  it("falls through to the agent's own note when nobody wrote a description", () => {
    harness.issues = [
      issue('root', { title: 'Mission', activityNotes: 'Rebasing onto main before review.' }),
    ]
    harness.sessions = []
    deck()
    expect(brief().textContent).toContain('Rebasing onto main')
    expect(brief().getAttribute('data-standing')).toBeNull()
  })
})

describe('flight deck mission agent action', () => {
  it('adds the selected agent to the mission root, even while a sub-task is focused', async () => {
    harness.issues = harness.issues.map((candidate) =>
      (candidate as Issue).id === 'root'
        ? { ...(candidate as Issue), worktreePath: '/repo', defaultAgent: 'claude-code' }
        : candidate,
    )
    harness.selectedIssueId = 't1'
    deck()

    fireEvent.click(screen.getByRole('button', { name: 'Add agent to mission' }))
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Add Codex' }))

    await waitFor(() =>
      expect(harness.addSession).toHaveBeenCalledWith({ id: 'root', agentKind: 'codex' }),
    )
    expect(harness.focusIssueSession).toHaveBeenCalledWith('root', { excludeSessionIds: [] })
    expect(harness.startIssue).not.toHaveBeenCalled()
  })

  it('adds a session even when the replica has not yet painted the worktree', async () => {
    harness.issues = harness.issues.map((candidate) =>
      (candidate as Issue).id === 'root'
        ? { ...(candidate as Issue), defaultAgent: 'claude-code' }
        : candidate,
    )
    deck()

    fireEvent.click(screen.getByRole('button', { name: 'Add agent to mission' }))
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Add Codex' }))

    await waitFor(() =>
      expect(harness.addSession).toHaveBeenCalledWith({ id: 'root', agentKind: 'codex' }),
    )
    expect(harness.startIssue).not.toHaveBeenCalled()
  })

  it('starts only when addSession says the issue has never been started', async () => {
    harness.addSession.mockRejectedValueOnce(new Error('issue not started'))
    harness.issues = harness.issues.map((candidate) =>
      (candidate as Issue).id === 'root'
        ? { ...(candidate as Issue), defaultAgent: 'claude-code' }
        : candidate,
    )
    deck()

    fireEvent.click(screen.getByRole('button', { name: 'Add agent to mission' }))
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Add Codex' }))

    await waitFor(() =>
      expect(harness.startIssue).toHaveBeenCalledWith({ id: 'root', agentKind: 'codex' }),
    )
  })

  it('opens the newly added agent instead of a session already on the mission', async () => {
    harness.issues = harness.issues.map((candidate) =>
      (candidate as Issue).id === 'root'
        ? {
            ...(candidate as Issue),
            worktreePath: '/repo',
            defaultAgent: 'claude-code',
            memberSessionIds: ['existing'],
          }
        : candidate,
    )
    harness.sessions = [
      ...harness.sessions,
      session('existing', { issueId: 'root' }),
      session('archived', { issueId: 'root', archived: true }),
    ]
    deck()

    fireEvent.click(screen.getByRole('button', { name: 'Add agent to mission' }))
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Add Codex' }))

    await waitFor(() =>
      expect(harness.focusIssueSession).toHaveBeenCalledWith('root', {
        excludeSessionIds: ['existing'],
      }),
    )
  })

  /**
   * THE HARNESS AXIS (POD-1201). `Add agent` offered every harness the build
   * knows about, so on a host without Cursor installed `Add Cursor` looked
   * startable and produced a session that died on a missing binary. It now wears
   * the same refusal the tab strip's "+" and the sidebar's spawn menu do.
   *
   * The host runs codex and not cursor, so the counterfactual is inside the same
   * menu: a gate applied indiscriminately fails the Codex half.
   */
  it('refuses a harness the mission’s host does not have, and offers the one it does', async () => {
    harness.repos = [
      { path: '/repo', kind: 'repository', branch: 'main', machineId: 'mine', worktrees: [] },
    ]
    harness.machines = [
      {
        id: 'mine',
        name: 'mine',
        hostname: 'mine',
        online: true,
        inventory: {
          agents: [
            { kind: 'codex', installed: true, login: { state: 'in' } },
            { kind: 'cursor', installed: false, login: { state: 'unknown' } },
          ],
        },
      },
    ]
    harness.issues = harness.issues.map((candidate) =>
      (candidate as Issue).id === 'root'
        ? {
            ...(candidate as Issue),
            worktreePath: '/repo',
            repoPath: '/repo',
            defaultAgent: 'codex',
          }
        : candidate,
    )
    deck()

    fireEvent.click(screen.getByRole('button', { name: 'Add agent to mission' }))

    const cursor = await screen.findByRole('menuitem', { name: /Add Cursor/ })
    expect(cursor.textContent).toContain('not installed')
    expect(cursor.getAttribute('data-refused')).toBe('true')
    fireEvent.click(cursor)
    expect(harness.addSession).not.toHaveBeenCalled()

    const codex = await screen.findByRole('menuitem', { name: /Add Codex/ })
    expect(codex.getAttribute('data-refused')).toBeNull()
  })
})

describe('flight deck fold state (POD-710 §4.2)', () => {
  it('migrates the v1 collapsed array to explicit closes and round-trips v2', () => {
    const migrated = readFolds(JSON.stringify(['a', 'b']))
    expect([...migrated]).toEqual([
      ['a', 'closed'],
      ['b', 'closed'],
    ])

    const explicit = new Map<string, 'open' | 'closed'>([
      ['a', 'open'],
      ['b', 'closed'],
    ])
    expect(readFolds(writeFolds(explicit))).toEqual(explicit)

    // Total, like every persisted reader here.
    expect(readFolds(null).size).toBe(0)
    expect(readFolds('{{{').size).toBe(0)
    expect(readFolds('"nope"').size).toBe(0)
    expect(writeFolds(new Map())).toBeNull()
  })

  it('defaults a lone-session task closed and everything else with a payload open', () => {
    const lone = { descendantIds: [], sessions: [{}] as SessionMeta[] }
    const pair = { descendantIds: [], sessions: [{}, {}] as SessionMeta[] }
    const branch = { descendantIds: ['x'], sessions: [{}] as SessionMeta[] }
    expect(defaultFolded(lone)).toBe(true)
    expect(defaultFolded(pair)).toBe(false)
    expect(defaultFolded(branch)).toBe(false)

    // An explicit value always wins over the rule, in both directions.
    const row = { issue: { id: 'a' }, ...lone } as unknown as Parameters<typeof isFolded>[0]
    expect(isFolded(row, new Map())).toBe(true)
    expect(isFolded(row, new Map([['a', 'open']]))).toBe(false)
    const open = { issue: { id: 'b' }, ...pair } as unknown as Parameters<typeof isFolded>[0]
    expect(isFolded(open, new Map())).toBe(false)
    expect(isFolded(open, new Map([['b', 'closed']]))).toBe(true)
  })

  it('applies the default rule to the rendered spine', () => {
    deck()
    expect(chevron('Task t1').getAttribute('aria-expanded')).toBe('false')
    expect(chevron('Task t2').getAttribute('aria-expanded')).toBe('true')
    expect(chevron('Task t3').getAttribute('aria-expanded')).toBe('true')
  })

  it('records the operator’s fold explicitly, so the default cannot undo it', () => {
    deck()
    act(() => {
      fireEvent.click(chevron('Task t1'))
    })
    expect(chevron('Task t1').getAttribute('aria-expanded')).toBe('true')
    expect(readFolds(harness.ui.get('podium.flightDeck.folds') ?? null).get('t1')).toBe('open')
  })
})

describe('flight deck unread (POD-912)', () => {
  it('a collapsed one-agent strip rolls up that session’s unread', () => {
    const row = {
      issue: {
        id: 't1',
        readAt: '2026-01-01T00:10:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
      },
      workingAgentCount: 0,
      descendantIds: [],
      collapsedSummary: {
        crew: [session('s1', { unread: true, lastActiveAt: '2026-01-01T00:20:00.000Z' })],
      },
    } as unknown as Parameters<typeof deckTaskUnread>[0]
    expect(deckTaskUnread(row, true, new Map())).toBe(true)
    expect(deckTaskUnread(row, false, new Map())).toBe(false)
  })

  it('an expanded strip leaves session unread to the session row', () => {
    harness.sessions = [
      session('s2', { issueId: 't2', unread: true, lastActiveAt: '2026-01-01T00:20:00.000Z' }),
      session('s3', { issueId: 't2', unread: false }),
    ]
    deck()
    const task = document.querySelector('[data-flight-issue="t2"]') as HTMLElement
    expect(task.querySelector('.deck-strip [data-testid="row-unread-dot"]')).toBeNull()
    const unreadSession = document.querySelector('[data-flight-session="s2"]') as HTMLElement
    expect(unreadSession.querySelector('[data-testid="row-unread-dot"]')).toBeTruthy()
    const readSession = document.querySelector('[data-flight-session="s3"]') as HTMLElement
    expect(readSession.querySelector('[data-testid="row-unread-dot"]')).toBeNull()
  })

  it('a collapsed parent stays unread when a child session is new', () => {
    const child = { id: 't4', updatedAt: '2026-01-01T00:00:00.000Z' }
    const row = {
      issue: {
        id: 't3',
        readAt: '2026-01-01T00:10:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
      },
      workingAgentCount: 0,
      descendantIds: ['t4'],
      collapsedSummary: {
        crew: [session('s-child', { unread: true, lastActiveAt: '2026-01-01T00:30:00.000Z' })],
      },
    } as unknown as Parameters<typeof deckTaskUnread>[0]
    expect(deckTaskUnread(row, true, new Map([['t4', child]]))).toBe(true)
  })
})

describe('flight deck click semantics (POD-710 §4.1)', () => {
  const sessionRow = (id: string): HTMLElement => {
    const row = document.querySelector(`[data-flight-session="${id}"] button`)
    if (!row) throw new Error(`no session row ${id}`)
    return row as HTMLElement
  }
  const taskRow = (id: string): HTMLElement => {
    const row = document.querySelectorAll(`[data-flight-issue="${id}"] button`)[1]
    if (!row) throw new Error(`no task row ${id}`)
    return row as HTMLElement
  }

  it('opens a session as a preview on one click', () => {
    deck()
    fireEvent.click(sessionRow('s2'))
    expect(harness.openSessionTab).not.toHaveBeenCalled()
    settle()
    expect(harness.openSessionTab.mock.calls).toEqual([['s2', { permanent: false }]])
  })

  it('lands a native worker row on the terminal without overruling a Chat pick', () => {
    // POD-1702. These rows are navigation — "take me to the agent running this
    // worker, on the terminal it is running in" — so they SUGGEST the CLI. They
    // used to write it as the session's mode, which overwrote an explicit Chat
    // pick and persisted it, so the session reopened on the terminal too.
    harness.sessions = [
      session('s1', { issueId: 't1' }),
      session('s2', {
        issueId: 't2',
        agentState: { nativeSubagents: [{ id: 'w1', type: 'general-purpose' }] },
      }),
      session('s3', { issueId: 't2' }),
      session('s4', { issueId: 't3' }),
    ]
    deck()

    const worker = document.querySelector('[data-testid="flight-native-agents"] button')
    expect(worker).toBeTruthy()
    fireEvent.click(worker as HTMLElement)
    settle()

    expect(harness.preferPanelMode.mock.calls).toEqual([['s2', 'native']])
    expect(harness.setPanelMode).not.toHaveBeenCalled()
  })

  it('reopens the Task dock when an issue is picked', () => {
    const openPanel = vi.fn()
    window.addEventListener('podium:open-right-panel', openPanel, { once: true })
    deck()

    fireEvent.click(taskRow('t2'))
    settle()

    expect(openPanel).toHaveBeenCalledTimes(1)
    expect((openPanel.mock.calls[0]?.[0] as CustomEvent).detail).toBe('issue')
  })

  /** Every `podium:open-right-panel` detail the deck asked for, in order. */
  const panelRequests = (): string[] => {
    const details: string[] = []
    const listener = (event: Event): void => {
      details.push(String((event as CustomEvent).detail))
    }
    window.addEventListener('podium:open-right-panel', listener)
    afterEachListeners.push(() => window.removeEventListener('podium:open-right-panel', listener))
    return details
  }

  it('closes the dock on a second click on the task it is already showing (POD-1639)', () => {
    // The dock is open on the Task panel, exactly as it is after the first pick.
    harness.ui.set(RIGHT_PANEL_KEY, 'issue')
    const details = panelRequests()
    deck()

    fireEvent.click(taskRow('t2'))
    settle()
    fireEvent.click(taskRow('t2'))
    settle()

    expect(details).toEqual(['issue', 'close'])
  })

  it('opens rather than closes when the dock is showing another task', () => {
    harness.ui.set(RIGHT_PANEL_KEY, 'issue')
    const details = panelRequests()
    deck()

    fireEvent.click(taskRow('t2'))
    settle()
    fireEvent.click(taskRow('t3'))
    settle()

    expect(details).toEqual(['issue', 'issue'])
  })

  it('never closes the dock on a promotion, which is an unambiguous open', () => {
    harness.ui.set(RIGHT_PANEL_KEY, 'issue')
    const details = panelRequests()
    deck()

    fireEvent.click(taskRow('t2'))
    settle()
    fireEvent.click(taskRow('t2'))
    fireEvent.click(taskRow('t2'))
    settle()

    expect(details).toEqual(['issue', 'issue'])
  })

  it('opens the dock when it is closed, whatever the row it lands on', () => {
    const details = panelRequests()
    deck()

    fireEvent.click(taskRow('t2'))
    settle()
    fireEvent.click(taskRow('t2'))
    settle()

    expect(details).toEqual(['issue', 'issue'])
  })

  it('promotes on the second click and never fires the single as well', () => {
    deck()
    fireEvent.click(sessionRow('s2'))
    fireEvent.click(sessionRow('s2'))
    settle()
    expect(harness.openSessionTab.mock.calls).toEqual([['s2', { permanent: true }]])
  })

  it('treats Enter as the double click', () => {
    deck()
    fireEvent.keyDown(sessionRow('s3'), { key: 'Enter' })
    settle()
    expect(harness.openSessionTab.mock.calls).toEqual([['s3', { permanent: true }]])
  })

  it('folds a task AND previews its lead session on one click', () => {
    deck()
    expect(chevron('Task t2').getAttribute('aria-expanded')).toBe('true')
    fireEvent.click(taskRow('t2'))
    settle()
    expect(chevron('Task t2').getAttribute('aria-expanded')).toBe('false')
    expect(harness.openSessionTab.mock.calls).toEqual([['s2', { permanent: false }]])
  })

  it('promotes a task’s lead session on a double click and leaves the fold alone', () => {
    deck()
    fireEvent.click(taskRow('t2'))
    fireEvent.click(taskRow('t2'))
    settle()
    expect(chevron('Task t2').getAttribute('aria-expanded')).toBe('true')
    expect(harness.openSessionTab.mock.calls).toEqual([['s2', { permanent: true }]])
  })

  it('changes a proposed issue from its status icon without opening the row', async () => {
    // This file's fake clock is for the click-intent window. Base UI positions
    // the status menu on rAF, and the two together make `findByRole` miss the
    // item. The rest of the suite can keep the fake clock; this test needs the
    // menu to actually open, then a real wait past the double-click window so
    // a leaked row click would still have fired.
    vi.useRealTimers()
    const openPanel = vi.fn()
    window.addEventListener('podium:open-right-panel', openPanel)
    deck()

    fireEvent.click(screen.getByLabelText('Status: Proposed'))
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Backlog' }))
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, DOUBLE_CLICK_MS + 40))
    })

    expect(harness.updateIssue).toHaveBeenCalledWith('p1', { stage: 'backlog' })
    expect(openPanel).not.toHaveBeenCalled()
    window.removeEventListener('podium:open-right-panel', openPanel)
  })
})

describe('flight deck sections (POD-710 §4.3, §4.4)', () => {
  it('turns a superseded empty mission into a forward signpost with a tuck choice', () => {
    harness.issues = [
      issue('root', {
        seq: 813,
        displayRef: 'POD-813',
        title: 'Old task',
        stage: 'done',
        closedReason: 'superseded',
        supersededBy: 'next',
      }),
      issue('next', { seq: 815, displayRef: 'POD-815', title: 'Archived exact-ref search' }),
    ]
    harness.sessions = []

    deck()

    const card = screen.getByTestId('flight-continuation')
    expect(card.textContent).toContain('Work continued in POD-815')
    expect(card.textContent).toContain('Archived exact-ref search')
    expect(screen.queryByText('Nothing here in this view.')).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: 'Open POD-815' }))
    expect(harness.setSelectedIssueId).toHaveBeenCalledWith('next')

    fireEvent.click(screen.getByRole('button', { name: /Tuck away/ }))
    expect(harness.setIssueTucked).toHaveBeenCalledWith('root', true)
    // Already finished: the fold is the whole decision, so nothing is closed.
    expect(harness.closeIssue).not.toHaveBeenCalled()
  })

  /**
   * POD-1212 — a signpost on a task that is still OPEN.
   *
   * `issues.setTucked` refuses an unfinished issue and the sidebar's fold reads
   * the same predicate, so the lone "Tuck away" here painted a fold the server
   * threw out. The ending is recorded first, and the tuck is enqueued behind it
   * in the same `issue:<id>` partition.
   */
  it('records the ending before folding a signpost the task never closed', async () => {
    harness.issues = [
      issue('root', {
        seq: 1158,
        displayRef: 'POD-1158',
        title: 'Chat feed motion',
        stage: 'review',
        dependents: [{ id: 'spin', type: 'discovered-from' }],
      }),
      issue('spin', {
        seq: 1192,
        displayRef: 'POD-1192',
        title: 'Safari scroll and flicker',
        deps: [{ id: 'root', type: 'discovered-from' }],
      }),
    ]
    harness.sessions = [session('s-spin', { issueId: 'spin', name: 'Scroll fix' })]

    deck()

    // The word "tuck" alone is never offered on an open task — it cannot work.
    expect(screen.queryByRole('button', { name: /^Tuck away/ })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: /Done & tuck/ }))

    // Nothing was at stake, so the guard did not interrupt: the close went
    // straight out, and the fold follows it.
    expect(harness.closeIssue).toHaveBeenCalledWith('root', 'done')
    await waitFor(() => expect(harness.setIssueTucked).toHaveBeenCalledWith('root', true))
  })

  /** …but a close that would strand work still raises the shared guard first
   *  (POD-1129) — the deck does not get its own, quieter close. */
  it('raises the close guard before folding away stranded delivery', async () => {
    harness.issues = [
      issue('root', {
        seq: 1158,
        displayRef: 'POD-1158',
        title: 'Chat feed motion',
        stage: 'review',
        dependents: [{ id: 'spin', type: 'discovered-from' }],
        parentBranch: 'main',
        gitState: { shared: false, ahead: 2, merged: false, dirtyFiles: 0, dirtyOwn: 0 },
      }),
      issue('spin', {
        seq: 1192,
        displayRef: 'POD-1192',
        title: 'Safari scroll and flicker',
        deps: [{ id: 'root', type: 'discovered-from' }],
      }),
    ]
    harness.sessions = [session('s-spin', { issueId: 'spin', name: 'Scroll fix' })]

    deck()
    fireEvent.click(screen.getByRole('button', { name: /Done & tuck/ }))

    expect(harness.closeIssue).not.toHaveBeenCalled()
    const concerns = await screen.findByTestId('issue-close-concerns')
    expect(concerns.textContent).toContain('2 commits awaiting delivery')

    fireEvent.click(screen.getByRole('button', { name: /Close anyway/ }))
    expect(harness.closeIssue).toHaveBeenCalledWith('root', 'done')
    await waitFor(() => expect(harness.setIssueTucked).toHaveBeenCalledWith('root', true))
  })

  it('turns a hopscotch-empty origin into a signpost to the live tip', () => {
    harness.issues = [
      issue('root', {
        seq: 959,
        displayRef: 'POD-959',
        title: 'Dest converge missing target',
        stage: 'review',
        dependents: [{ id: 'mid', type: 'discovered-from' }],
      }),
      issue('mid', {
        seq: 962,
        displayRef: 'POD-962',
        title: 'Dest web bun path',
        stage: 'done',
        closedReason: 'done',
        deps: [{ id: 'root', type: 'discovered-from' }],
      }),
      issue('tip', {
        seq: 963,
        displayRef: 'POD-963',
        title: 'Dest web rebuild exit',
        stage: 'in_progress',
        deps: [{ id: 'mid', type: 'discovered-from' }],
      }),
    ]
    harness.sessions = [session('s-tip', { issueId: 'tip', name: 'Dest web rebuild' })]

    deck()

    const card = screen.getByTestId('flight-continuation')
    expect(card.textContent).toContain('Work continued in POD-963')
    expect(card.textContent).toContain('No session remains here.')
    expect(card.textContent).not.toContain('session ended')
    // ONE REGION, ONE STATEMENT (POD-1146). The tip is the continuation AND a
    // departure — it used to render as a card and again as a faint mono tick
    // twelve pixels below it, in a different voice. The card is now the first
    // row of the departures region, so POD-963 is said exactly once.
    expect(screen.getByText('Where the work went')).toBeTruthy()
    expect(screen.queryByText('Left this mission')).toBeNull()
    expect(screen.queryByTestId('flight-departure')).toBeNull()
    expect(screen.getByTestId('flight-departures').contains(card)).toBe(true)

    fireEvent.click(screen.getByRole('button', { name: 'Open POD-963' }))
    expect(harness.setSelectedIssueId).toHaveBeenCalledWith('tip')
  })

  /**
   * POD-1233 — the signpost drawn over an agent that never left.
   *
   * `issueContinuation` reaches its live-session guard only on the hopscotch
   * path, so a task closed as a DUPLICATE produced a card whatever the roster
   * said. POD-1217 sat like this for hours: closed onto POD-1160, its codex
   * session still in the list below the card announcing its absence.
   */
  const duplicateRoot = (members: string[] = []): unknown[] => [
    issue('root', {
      seq: 1217,
      displayRef: 'POD-1217',
      title: 'Safari scroll issue in chat view',
      stage: 'done',
      closedReason: 'duplicate',
      duplicateOf: 'canon',
      memberSessionIds: members,
    }),
    issue('canon', {
      seq: 1160,
      displayRef: 'POD-1160',
      title: 'Safari transcript scroll position',
    }),
  ]

  it('names the agent still on a task closed as a duplicate', () => {
    harness.issues = duplicateRoot(['s-dupe'])
    harness.sessions = [session('s-dupe', { issueId: 'root', agentKind: 'codex' })]

    deck()

    const card = screen.getByTestId('flight-continuation')
    // The lineage half is a fact about issues and survives untouched — this is
    // the trail that guarding `issueContinuation` would have deleted.
    expect(card.textContent).toContain('The same work is tracked in POD-1160')
    expect(card.textContent).toContain('Codex is still on this task.')
    expect(card.textContent).not.toContain('No session remains')
  })

  it('counts a parked agent as present, because parking is not leaving', () => {
    harness.issues = duplicateRoot(['s-dupe'])
    harness.sessions = [
      session('s-dupe', { issueId: 'root', agentKind: 'codex', status: 'hibernated' }),
    ]

    deck()

    // `sessionPresentOnTask` is `!archived && status !== 'exited'`, and sessions
    // here park far more often than they exit. A fix that waited for the session
    // to END would have stayed wrong on POD-1217 indefinitely.
    expect(screen.getByTestId('flight-continuation').textContent).toContain(
      'Codex is parked on this task.',
    )
  })

  it('keeps the empty-task wording when the task really is empty', () => {
    harness.issues = duplicateRoot()
    harness.sessions = []

    deck()

    const card = screen.getByTestId('flight-continuation')
    expect(card.textContent).toContain('No session remains on this closed task.')
    expect(card.textContent).toContain('Safari transcript scroll position is where it carried on.')
  })

  /**
   * POD-1268 — the OTHER ending, which had no card at all.
   *
   * A mission whose work simply stopped here (no continuation to point at) drew
   * `presenceNote`'s bare "Cancelled · session retired" as faint grey text in an
   * empty column, and the only decision left on it — the fold — was not on the
   * screen at all.
   */
  const retiredRoot = (over: Record<string, unknown> = {}): unknown[] => [
    issue('root', {
      seq: 1261,
      displayRef: 'POD-1261',
      title: 'Eager bundle budget is red on main',
      stage: 'done',
      closedReason: 'cancelled',
      ...over,
    }),
  ]

  it('gives a retired mission the signpost box and a direct tuck', () => {
    harness.issues = retiredRoot()
    harness.sessions = []

    deck()

    const card = screen.getByTestId('flight-retired')
    expect(card.textContent).toContain('This task was cancelled.')
    expect(card.textContent).toContain('No session remains on it.')
    // The status line it replaces is gone, not printed twice.
    expect(screen.queryByText('Cancelled · session retired')).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: /Tuck away/ }))
    expect(harness.setIssueTucked).toHaveBeenCalledWith('root', true)
    // Already closed, so the fold is the whole decision — nothing is re-closed.
    expect(harness.closeIssue).not.toHaveBeenCalled()
  })

  it('says finished over work that completed, cancelled over work that did not', () => {
    harness.issues = retiredRoot({ closedReason: 'done' })
    harness.sessions = []

    deck()

    expect(screen.getByTestId('flight-retired').textContent).toContain('This task is finished.')
  })

  /** The card is the CLOSED ending only. Every other empty-spine note is a state
   *  to read and leave alone, and none of them can be tucked — `setTucked`
   *  refuses an unfinished issue. */
  it('leaves a vacated but unfinished mission as a status line', () => {
    harness.issues = retiredRoot({ stage: 'in_progress', closedReason: null })
    harness.sessions = []

    deck()

    expect(screen.queryByTestId('flight-retired')).toBeNull()
    expect(screen.getByText('Agent left · choose a handoff')).toBeTruthy()
  })

  describe('continuationPresenceLine', () => {
    it('leaves both empty-task sentences exactly as they were', () => {
      expect(continuationPresenceLine('duplicate', [])).toBe(
        'No session remains on this closed task.',
      )
      expect(continuationPresenceLine('superseded', [])).toBe(
        'No session remains on this closed task.',
      )
      expect(continuationPresenceLine('spinoff', [])).toBe('No session remains here.')
    })

    it('reads sessions on every kind, not just the duplicate that surfaced it', () => {
      const live = [session('s', { agentKind: 'claude-code' })]
      expect(continuationPresenceLine('duplicate', live)).toBe('Claude Code is still on this task.')
      expect(continuationPresenceLine('superseded', live)).toBe(
        'Claude Code is still on this task.',
      )
      expect(continuationPresenceLine('spinoff', live)).toBe('Claude Code is still on this task.')
    })

    it('ignores sessions that genuinely left', () => {
      expect(
        continuationPresenceLine('duplicate', [
          session('gone', { status: 'exited' }),
          session('retired', { archived: true }),
        ]),
      ).toBe('No session remains on this closed task.')
    })

    it('counts rather than names once there is more than one', () => {
      expect(
        continuationPresenceLine('duplicate', [
          session('a'),
          session('b', { status: 'hibernated' }),
        ]),
      ).toBe('2 sessions are still on this task.')
    })
  })

  it('sinks proposals into their own tail, with no tree guide', () => {
    deck()
    const proposed = screen.getByTestId('flight-proposed')
    expect(proposed.textContent).toContain('Proposed')
    const row = proposed.querySelector('[data-flight-issue="p1"]')
    expect(row).not.toBeNull()
    // Out of the tree means out of the tree: no depth, and no rail or elbow
    // drawn into the section.
    expect(row?.getAttribute('data-depth')).toBeNull()
    expect(screen.getByTestId('flight-deck-rows').querySelector('[data-flight-issue="p1"]')).toBe(
      row,
    )
    const tree = document.querySelector('[data-flight-issue="t1"]')
    expect(tree?.getAttribute('data-depth')).toBe('1')
  })

  it('keeps one fixed scrollport around sticky mission chrome and growing rows', () => {
    deck()

    const scroller = screen.getByTestId('flight-deck-scroller')
    const rows = screen.getByTestId('flight-deck-rows')
    const chrome = scroller.querySelector('.deck-chrome')

    expect(scroller.className).toContain('overflow-y-auto')
    expect(chrome?.classList.contains('sticky')).toBe(true)
    expect(scroller.contains(rows)).toBe(true)
    expect(rows.className).toContain('flex-none')
    expect(rows.className).not.toContain('overflow-y-auto')
  })

  it('reveals a session below the sticky mission chrome', () => {
    deck()
    const row = document.querySelector<HTMLElement>('[data-flight-session="s1"]')
    if (!row) throw new Error('no agent row')
    row.scrollIntoView = vi.fn()

    act(() => {
      window.dispatchEvent(new CustomEvent(REVEAL_IN_DECK_EVENT, { detail: 's1' }))
      vi.advanceTimersByTime(20)
    })

    expect(row.scrollIntoView).toHaveBeenCalledWith({ block: 'end' })
  })

  it('surfaces the archived sessions the tab strip dropped', () => {
    harness.sessions = [
      ...harness.sessions,
      session('gone', { issueId: 't1', archived: true, name: 'Retired agent' }),
    ]
    harness.issues = harness.issues.map((raw) => {
      const candidate = raw as Issue
      return candidate.id === 't1' ? { ...candidate, memberSessionIds: ['s1', 'gone'] } : candidate
    })
    deck()
    const toggle = screen.getByTestId('flight-archived-toggle')
    expect(toggle.textContent).toContain('1 archived session')
    expect(document.querySelector('[data-flight-session="gone"]')).toBeNull()
    act(() => {
      fireEvent.click(toggle)
    })
    expect(document.querySelector('[data-flight-session="gone"]')).not.toBeNull()
  })

  // POD-1314: a retirement reading is one operational fact. The responsive row
  // keeps the age visible and changes composition around it when space runs out.
  it('keeps a retired row’s complete state reading', () => {
    harness.sessions = [
      ...harness.sessions,
      session('gone', { issueId: 't1', status: 'exited', name: 'Retired agent' }),
    ]
    harness.issues = harness.issues.map((raw) => {
      const candidate = raw as Issue
      return candidate.id === 't1' ? { ...candidate, memberSessionIds: ['s1', 'gone'] } : candidate
    })
    deck()
    const row = document.querySelector('[data-flight-session="gone"]')
    expect(row).not.toBeNull()
    expect(row?.getAttribute('data-retired')).toBe('true')
    const state = row?.querySelector('.deck-agent-state')
    expect(state?.textContent).toContain('Retired')
    // Both halves remain in the state cell at every panel width.
    expect(state?.querySelector('.deck-agent-elapsed')).not.toBeNull()
    expect(row?.querySelector('[title]')?.getAttribute('title')).toContain('Retired · ')
  })

  it('offers session lifecycle from the row itself', () => {
    deck()
    expect(screen.getByRole('button', { name: 'Session actions for s2' })).toBeTruthy()
  })
})

/**
 * THE TASK MENU (POD-771). A strip answers the same gesture its agent rows do,
 * with the menu the board and the sidebar already serve — so what is asserted
 * here is the JOIN (the deck reaches the shared tree, on the right issue), not
 * the tree's contents, which `issue-menu-config.test.ts` owns.
 */
describe('flight deck task menu (POD-771)', () => {
  const stripOf = (id: string): HTMLElement => {
    const row = document.querySelector(`[data-flight-issue="${id}"] .deck-strip`)
    if (!row) throw new Error(`no strip ${id}`)
    return row as HTMLElement
  }

  it('right-clicking a task opens the shared task menu on THAT task', () => {
    deck()
    fireEvent.contextMenu(stripOf('t1'))
    expect(screen.getByText('Set status')).toBeTruthy()
    // The menu's header names the task it will act on, not the mission.
    expect(screen.getByText('Task t1')).toBeTruthy()
  })

  it('reaches top level from a sub-task, naming where it comes out of', () => {
    deck()
    fireEvent.contextMenu(stripOf('t4'))
    // t4 hangs under t3, so the placement correction is the one that applies —
    // and it states the OUTCOME, which is the row appearing in the sidebar.
    fireEvent.click(screen.getByText('Move to top level (out of T3)'))
    expect(harness.setPlacement).toHaveBeenCalledWith({
      id: 't4',
      placement: 'own',
      originId: 't3',
    })
  })

  it('gives a proposal the same menu, from its own tail', () => {
    deck()
    const proposal = document.querySelector('[data-flight-issue="p1"] button')
    expect(proposal).not.toBeNull()
    fireEvent.contextMenu(proposal as HTMLElement)
    expect(screen.getByText('Set status')).toBeTruthy()
    expect(screen.getByRole('menuitem', { name: 'Start issue' })).toBeTruthy()
    expect(screen.queryByRole('menuitem', { name: /Run now/ })).toBeNull()
  })

  it('starts a proposed task directly from its Flight Deck menu', () => {
    deck()
    const proposal = document.querySelector('[data-flight-issue="p1"] button')
    fireEvent.contextMenu(proposal as HTMLElement)
    fireEvent.click(screen.getByRole('menuitem', { name: 'Start issue' }))
    expect(harness.startIssue).toHaveBeenCalledWith({ id: 'p1' })
  })

  it('shows the hover affordance for operators who never right-click', () => {
    deck()
    expect(screen.getByRole('button', { name: 'Task actions for Task t1' })).toBeTruthy()
  })
})

/**
 * The lead-rail spine (POD-758) — the rules that are structural rather than
 * cosmetic, so a refactor that quietly reverts one of them is caught here.
 */
describe('flight deck spine (POD-758)', () => {
  const strip = (id: string): HTMLElement => {
    const row = document.querySelector(`[data-flight-issue="${id}"]`)
    if (!row) throw new Error(`no strip ${id}`)
    return row as HTMLElement
  }

  // A collapsed task is a CENSUS, not a roster: one harness icon per session,
  // and the name only once the strip is open.
  it('shows a harness icon per session on a folded strip, and no names', () => {
    deck()
    // t1 arrives folded (one session, no children). The band itself carries the
    // census and no name — the collapsed agent row stays mounted underneath it,
    // because the fold is a height collapse rather than an unmount.
    const band = strip('t1').querySelector('.deck-strip')
    expect(band?.querySelector('[data-testid="flight-crew"]')).not.toBeNull()
    expect(band?.textContent).not.toContain('s1')
    // t2 arrives open, so its agents are rows with names — and no census.
    expect(strip('t2').querySelector('[data-testid="flight-crew"]')).toBeNull()
    expect(strip('t2').textContent).toContain('s2')
  })

  // The ref is the handle the operator types and pastes, so the row prints it.
  it('prints a session’s permanent ref on its agent row', () => {
    harness.sessions = harness.sessions.map((raw) => {
      const meta = raw as SessionMeta
      return meta.sessionId === 's2' ? { ...meta, displayRef: 'POD-2-A' } : meta
    })
    deck()
    expect(strip('t2').textContent).toContain('POD-2-A')
  })

  it('keeps task identity separate from the metadata that can wrap below it', () => {
    deck()
    const band = strip('t1').querySelector('.deck-strip')
    const identity = band?.querySelector('.deck-task-identity')
    const metadata = band?.querySelector('.deck-task-meta')

    expect(identity?.textContent).toContain('Task t1')
    expect(metadata?.querySelector('[data-operational-state]')).not.toBeNull()
    expect(identity?.parentElement).toBe(metadata?.parentElement)
  })

  it('does not reserve an empty role column for a lone session', () => {
    deck()
    const row = document.querySelector('[data-flight-session="s1"]')

    expect(row).not.toBeNull()
    expect(row?.querySelector('.deck-agent-role')).toBeNull()
  })

  // Colour in this column is a MARK, never a surface: a task keeps its grey
  // fill in every state and says "selected" with an outline and a gutter tick.
  it('keeps the task fill grey when a strip is selected', () => {
    deck()
    const band = strip('t2').querySelector('.deck-strip')
    expect(band?.className).toContain('bg-tabstrip')
    expect(band?.className).not.toContain('issue-mix')
  })

  // The held seat is a dotted chip in the strip's chip slot, not a row of its
  // own — "nobody is here" read exactly where somebody would be.
  it('holds an empty task’s seat as a chip on the strip', () => {
    harness.issues = [
      ...harness.issues,
      issue('t5', { parentId: 'root', stage: 'planning', title: 'Unstaffed' }),
    ]
    deck()
    const seat = strip('t5').querySelector('[data-testid="flight-reserved-slot"]')
    expect(seat).not.toBeNull()
    expect(seat?.textContent).toBe('seat open')
    // Inside the strip itself, so it costs the spine no row.
    expect(
      strip('t5')
        .querySelector('.deck-strip')
        ?.contains(seat as Node),
    ).toBe(true)
  })

  // Nothing in the spine is hidden by default any more: the roster's own
  // "N finished agents" fold is gone, and the view bar does that job.
  it('shows every root agent, with no roster fold', () => {
    harness.issues = harness.issues.map((raw) => {
      const candidate = raw as Issue
      return candidate.id === 'root'
        ? { ...candidate, memberSessionIds: ['r1', 'r2', 'r3', 'r4'] }
        : candidate
    })
    harness.sessions = [
      ...harness.sessions,
      ...['r1', 'r2', 'r3', 'r4'].map((id) =>
        session(id, { issueId: 'root', status: 'exited', name: `Retired ${id}` }),
      ),
    ]
    deck()
    expect(screen.queryByTestId('flight-roster-fold')).toBeNull()
    for (const id of ['r1', 'r2', 'r3', 'r4']) {
      expect(document.querySelector(`[data-flight-session="${id}"]`)).not.toBeNull()
    }
  })

  // The mission's lead owns the spine's rail and is the one agent row with a
  // fill; the `coord` badge it used to wear is retired.
  it('names the mission lead with the rail and the word, not a badge', () => {
    harness.issues = harness.issues.map((raw) => {
      const candidate = raw as Issue
      return candidate.id === 'root'
        ? { ...candidate, memberSessionIds: ['lead'], coordinatorSessionId: 'lead' }
        : candidate
    })
    harness.sessions = [...harness.sessions, session('lead', { issueId: 'root', name: 'Lead' })]
    deck()
    const row = document.querySelector('[data-flight-session="lead"]')
    expect(row?.className).toContain('deck-lead-fill')
    expect(row?.querySelector('[data-session-role="coordinator"]')?.textContent).toBe('coordinator')
    // The rail its branch descends on carries the mission tone.
    expect(document.querySelector('.deck-rail-mission')).not.toBeNull()
  })
})

/**
 * THE SPINE IS ONE LINE, AND THE GUTTER HOLDS ONE GRAMMAR (POD-1226).
 *
 * happy-dom has no layout, so neither of these can be checked by measuring — but
 * both defects were structural rather than metric, and the structure is exactly
 * what a DOM test can hold still. The jog was four segments drawn with a
 * hardcoded hairline while the fifth was drawn from `railFor`, so the invariant
 * is "every vertical segment at ROOT_RAIL shares one class and one width". The
 * collision was an amber rule on the row's own edge — which is the agent tile's
 * edge — so the invariant is "attention is a tick, and the row carries no inset
 * rule". The pixel side is covered by the harness in `harness/deck-entry.tsx`.
 */
describe('flight deck spine geometry (POD-1226)', () => {
  /**
   * Every VERTICAL mark the deck draws at the mission's own rail, HOWEVER it is
   * drawn. The elbows start on the same left edge and are excluded by their
   * `h-px` class — they are the line arriving at a row, not the line itself.
   *
   * Deliberately NOT filtered on having an inline width: the defect being held
   * shut here was four segments whose width came from a `w-px` utility class
   * while a fifth took it from `railFor`, so a filter that only admitted the
   * fifth kind could not see the defect at all. (It did not: the first version
   * of this test passed with the jog planted back in.)
   */
  const spineSegments = (): HTMLElement[] =>
    [...document.querySelectorAll<HTMLElement>('span[aria-hidden]')].filter(
      (el) => el.style.left === '16px' && !el.className.includes('h-px'),
    )

  const withLead = (): void => {
    harness.issues = harness.issues.map((raw) => {
      const candidate = raw as Issue
      return candidate.id === 'root'
        ? { ...candidate, memberSessionIds: ['lead'], coordinatorSessionId: 'lead' }
        : candidate
    })
    harness.sessions = [...harness.sessions, session('lead', { issueId: 'root', name: 'Lead' })]
  }

  /** A segment's INK, not its positioning — the segments are anchored
   *  differently (`bottom-0 h-4`, `inset-y-0`, an explicit height) and only the
   *  tone and the width are the thing that must agree. */
  const toneOf = (el: HTMLElement): string =>
    [...el.classList].find((c) => c.startsWith('deck-rail-') || c.startsWith('bg-')) ?? ''

  it('draws the whole spine — chrome and rows — from one rail', () => {
    withLead()
    deck()
    const segments = spineSegments()
    // The list's top pad, the gap under the root roster, and the root rows' own
    // rail. (The header's descent and the view bar's were removed in POD-1306 —
    // see the next test.)
    expect(segments.length).toBeGreaterThan(2)
    // Each one takes its width FROM THE RAIL OBJECT, so a hardcoded `w-px`
    // anywhere on the spine fails here rather than at a jog on somebody's screen.
    expect(segments.filter((el) => el.style.width === '')).toEqual([])
    expect([...new Set(segments.map((el) => el.style.width))]).toEqual(['2px'])
    expect([...new Set(segments.map(toneOf))]).toEqual(['deck-rail-mission'])
  })

  it('falls back to one hairline spine on a mission with no lead', () => {
    deck()
    const segments = spineSegments()
    expect(segments.filter((el) => el.style.width === '')).toEqual([])
    expect([...new Set(segments.map((el) => el.style.width))]).toEqual(['1px'])
    expect([...new Set(segments.map(toneOf))]).toEqual(['bg-hairline-soft'])
  })

  /**
   * THE SPINE STARTS AT THE LIST (POD-1306). The header is padded to 16px, which
   * is ROOT_RAIL itself, so any segment drawn above the list lands UNDER the
   * title and the gauge chip's left border rather than beside them — which is
   * what made the descent read as a stray tick dangling off the chip. The
   * invariant is positional, so it survives without layout: nothing outside the
   * scrolling list may draw a vertical mark at the mission's own rail.
   */
  it('draws no spine above the list — not in the header, not behind the tabs', () => {
    withLead()
    deck()
    const rows = document.querySelector('[data-testid="flight-deck-rows"]')
    if (!rows) throw new Error('no rows list')
    const above = spineSegments().filter((el) => !rows.contains(el))
    expect(above).toEqual([])
    // And the list itself still opens with one, so the tree starts on a rail
    // rather than on an elbow arriving out of nothing.
    expect(spineSegments().length).toBeGreaterThan(0)
  })

  /**
   * SELECTION STANDS ON THE RAIL, NOT AGAINST THE ROW (POD-1306). Landing the
   * tick's right edge on the row's own left edge put a 3×15 bar hard against the
   * 20px agent tile, which reads as the spine running behind the icon. The tick
   * belongs on the rail it is about, leaving the whole gutter to the elbow.
   */
  it('leaves the gutter between the rail and the tile to the elbow', () => {
    harness.paneA = 's1'
    deck()
    const row = document.querySelector<HTMLElement>('[data-flight-session="s1"]')
    if (!row) throw new Error('no agent row')
    // The tick's colour moved to `.deck-mark-active` when the active and
    // pointed marks split hues (POD-1480); its geometry — what this test is
    // about — is still inline.
    const tick = row.querySelector<HTMLElement>('span[aria-hidden].deck-mark-active')
    // `not.toBeNull`, not `toBeDefined`: `querySelector` misses with null, and
    // `expect(null).toBeDefined()` passes — the guard has to actually guard.
    expect(tick).not.toBeNull()
    // The row's own left edge is `AGENT_INDENT` from its block; the tick sits on
    // the rail at `AGENT_RAIL`, so it stops well short of the tile.
    const left = Number.parseFloat(tick?.style.left ?? 'NaN')
    expect(left + 3).toBeLessThan(0)
  })

  it('marks an asking agent with a gutter tick, never a rule on the row', () => {
    harness.sessions = harness.sessions.map((raw) => {
      const meta = raw as SessionMeta
      return meta.sessionId === 's1'
        ? { ...meta, agentState: { phase: 'needs_user', since: '2026-01-01T00:00:00.000Z' } }
        : meta
    })
    deck()
    const row = document.querySelector<HTMLElement>('[data-flight-session="s1"]')
    if (!row) throw new Error('no asking row')
    expect(row.dataset.needsYou).toBe('true')
    // No 2px amber rule inset on the row's left edge — that edge is the agent
    // tile's edge, and the rule was painted across the tile's own corner.
    expect(row.className).not.toContain('inset_2px')
    // The ask is a tick standing OUTSIDE the rail, at the strips' own offset.
    const tick = [...row.querySelectorAll<HTMLElement>('span[aria-hidden]')].find(
      (el) => el.style.background === 'var(--attention)',
    )
    expect(tick).toBeDefined()
    expect(tick?.style.width).toBe('3px')
    expect(tick?.style.height).toBe('15px')
  })

  it('keeps every agent row in the shared state column without discarding metadata', () => {
    deck()
    for (const row of document.querySelectorAll('[data-flight-session]')) {
      const state = row.querySelector('.deck-agent-state')
      const button = row.querySelector('.deck-agent')
      // State keeps the same trailing-edge floor as task strips. The four facts
      // remain direct grid items so the container query can recompose them into
      // two lines without deleting or duplicating content.
      expect(state?.className).toContain('deck-state-col')
      expect(button?.querySelector(':scope > .deck-agent-name')).not.toBeNull()
      expect(button?.querySelector(':scope > .deck-agent-ref')).not.toBeNull()
      expect(button?.querySelector(':scope > .deck-agent-state')).not.toBeNull()
    }
  })

  it('keeps the full agent reading on the row tooltip', () => {
    harness.issues = harness.issues.map((raw) => {
      const candidate = raw as Issue
      return candidate.id === 'root'
        ? { ...candidate, memberSessionIds: ['lead'], coordinatorSessionId: 'lead' }
        : candidate
    })
    harness.sessions = [
      ...harness.sessions,
      session('lead', {
        issueId: 'root',
        name: 'Lead',
        displayRef: 'POD-1-A',
        agentState: { phase: 'needs_user', since: '2026-01-01T00:00:00.000Z' },
      }),
    ]
    deck()
    const button = document
      .querySelector('[data-flight-session="lead"]')
      ?.querySelector('.deck-agent')
    // The tooltip mirrors the complete visible reading and remains useful when
    // a genuinely exceptional value has to wrap in the narrow composition.
    expect(button?.getAttribute('title')).toContain('POD-1-A')
    expect(button?.getAttribute('title')).toContain('Needs you')
    expect(button?.getAttribute('title')).toMatch(/ago|just now/)
    expect(button?.querySelector('[data-session-role="coordinator"]')?.textContent).toBe(
      'coordinator',
    )
  })
})

/**
 * POINTING AT A TAB POINTS AT ITS ROW (POD-1067). The strip and the spine draw
 * the same session, and the link between them is one transient mark on the row
 * — no selection, no scroll, nothing that survives the pointer.
 */
describe('flight deck tab-strip hover link', () => {
  const pointed = (id: string): string | null =>
    document.querySelector(`[data-flight-session="${id}"]`)?.getAttribute('data-pointed') ?? null

  afterEach(() => {
    setHoveredSession(null)
  })

  it('marks the pointed session and no other', () => {
    deck()
    expect(pointed('s2')).toBeNull()

    act(() => setHoveredSession('s2'))
    expect(pointed('s2')).toBe('true')
    expect(pointed('s3')).toBeNull()

    act(() => setHoveredSession(null))
    expect(pointed('s2')).toBeNull()
  })

  // Crossing from one tab straight to its neighbour can deliver the old tab's
  // leave AFTER the new tab's enter; clearing by id makes that a no-op rather
  // than a blank.
  it('ignores a stale clear from the tab the pointer already left', () => {
    deck()
    act(() => setHoveredSession('s2'))
    act(() => clearHoveredSession('s3'))
    expect(pointed('s2')).toBe('true')

    act(() => clearHoveredSession('s2'))
    expect(pointed('s2')).toBeNull()
  })

  /**
   * TWO QUESTIONS, TWO HUES, ONE DEVICE (POD-1480). Where you ARE and where you
   * are POINTING have to be readable at the same time and told apart at a
   * glance — the previous 100% / 45% of one hue was neither.
   */
  const mark = (id: string): Element | null =>
    document.querySelector(`[data-flight-session="${id}"] .deck-mark-active`) ??
    document.querySelector(`[data-flight-session="${id}"] .deck-mark-pointed`)

  it('marks the active row and the pointed row at once, in different hues', () => {
    harness.paneA = 's1'
    deck()

    // The active row carries its mark with no pointer involved at all.
    expect(mark('s1')?.className).toContain('deck-mark-active')
    expect(mark('s2')).toBeNull()

    act(() => setHoveredSession('s2'))

    // Both marks stand. Neither replaces the other, and they are not the same
    // colour class — that IS the distinction.
    expect(mark('s1')?.className).toContain('deck-mark-active')
    expect(mark('s2')?.className).toContain('deck-mark-pointed')
  })

  it('keeps the active mark when the pointer lands on the active row', () => {
    harness.paneA = 's1'
    deck()

    act(() => setHoveredSession('s1'))

    // You are already there, so pointing at it says nothing new: the row stays
    // marked as active rather than downgrading to the pointed hue.
    expect(mark('s1')?.className).toContain('deck-mark-active')
    expect(pointed('s1')).toBe('true')
  })

  it('gives the active row a ground, so a hover cannot outrank it', () => {
    harness.paneA = 's1'
    deck()

    const row = document.querySelector('[data-flight-session="s1"]')
    expect(row?.className).toContain('deck-agent-active')

    act(() => setHoveredSession('s2'))
    expect(row?.className).toContain('deck-agent-active')
  })

  /**
   * The active row may not borrow the neutral wash. `--muted` is LESS extreme
   * than the active ground in both appearances, so a row that took it would
   * step back under the pointer while every other row stepped forward — the
   * defect this whole change exists to fix, relocated to the self-hover case.
   */
  it('does not let the neutral wash paint over the active row', () => {
    harness.paneA = 's1'
    deck()
    const button = document.querySelector('[data-flight-session="s1"] button.deck-agent')
    if (!button) throw new Error('no agent button')

    // Not even at rest: the hover utility itself is withheld, because a real
    // pointer on the row would otherwise do what the tab strip is stopped from.
    expect(button.className).not.toContain('hover:bg-muted')

    act(() => setHoveredSession('s1'))
    expect(button.className).not.toContain('bg-muted')
  })

  /** The rows that have no ground of their own still take it, unchanged. */
  it('still washes a pointed row that is not the active one', () => {
    harness.paneA = 's1'
    deck()
    const button = document.querySelector('[data-flight-session="s2"] button.deck-agent')
    if (!button) throw new Error('no agent button')

    act(() => setHoveredSession('s2'))
    expect(button.className).toContain('bg-muted')
  })
})

/**
 * THE DECK WITH NO MISSION UNDER THE SELECTION (POD-1139).
 *
 * Three different facts, three different answers, and the discriminator is the
 * focused session itself — its kind, then whether it knows its task. The screen
 * this replaced ("Ready when you are", over a copy of the right dock's
 * Task/Plan/Team rows) gave all three the same agent words, the shell included,
 * and a shell is never going to organize anything.
 */
describe('flight deck without a mission', () => {
  beforeEach(() => {
    harness.selectedIssueId = null
  })

  it('offers the ghost tree and its advice when nothing is focused', () => {
    deck()
    expect(screen.getByTestId('flight-empty')).toBeTruthy()
    expect(screen.getByText('Every agent, in one tree')).toBeTruthy()
  })

  // A panel-menu agent and a resumed conversation both arrive with no vessel,
  // and "pick a task or start one" is the whole answer for them — the same
  // answer the unfocused column gives, so it is the same column.
  it('gives a session on no task the empty deck, not a screen of its own', () => {
    harness.sessions = [session('loose', { issueId: null })]
    harness.paneA = 'loose'
    deck()
    expect(screen.getByTestId('flight-empty')).toBeTruthy()
    expect(screen.queryByTestId('flight-settling')).toBeNull()
  })

  // The composer's spawn paints the vessel and the session together, so the
  // session knows its task before the selection does. That gap is a load.
  it('ghosts, wordlessly, while a spawned session waits for its selection', () => {
    harness.sessions = [session('fresh', { issueId: 'root' })]
    harness.paneA = 'fresh'
    deck()
    expect(screen.getByTestId('flight-settling')).toBeTruthy()
    expect(screen.getByTestId('flight-ghost-settling')).toBeTruthy()
    // Nothing to read, because a beat later there is a real tree here.
    expect(screen.queryByText('Every agent, in one tree')).toBeNull()
    expect(screen.getByTestId('flight-settling').textContent).toBe('')
  })

  it('tells a shell what it is instead of promising it an agent', () => {
    harness.sessions = [session('sh', { agentKind: 'shell', issueId: null })]
    harness.paneA = 'sh'
    deck()
    expect(screen.getByTestId('flight-shell')).toBeTruthy()
    expect(screen.getByText('A shell joins no task')).toBeTruthy()
    expect(screen.queryByTestId('flight-empty')).toBeNull()
  })

  // A shell that DOES sit in a started worktree (`issue add-shell`) still gets
  // the shell answer rather than the load: it is not waiting for anything.
  it('keeps the shell answer even when the shell carries a task id', () => {
    harness.sessions = [session('sh', { agentKind: 'shell', issueId: 'root' })]
    harness.paneA = 'sh'
    deck()
    expect(screen.getByTestId('flight-shell')).toBeTruthy()
    expect(screen.queryByTestId('flight-settling')).toBeNull()
  })
})

/**
 * THE VIEW BAR ACTUALLY NARROWS THE COLUMN (POD-1245).
 *
 * `Working` and `Needs you` both looked broken in the field — an operator with
 * that view on was reading a spine of finished and cancelled tasks. Two separate
 * causes, and the tests below hold each at the level it is fixed: the viewmodel
 * decides WHICH rows survive (mission.test.ts), and this file decides what a row
 * that survived only as somebody else's path is allowed to draw.
 */
describe('flight deck view filters (POD-1245)', () => {
  const strip = (id: string): HTMLElement => {
    const row = document.querySelector(`[data-flight-issue="${id}"]`)
    if (!row) throw new Error(`no strip ${id}`)
    return row as HTMLElement
  }
  const band = (id: string): HTMLElement => {
    const el = strip(id).querySelector('.deck-strip')
    if (!el) throw new Error(`no band ${id}`)
    return el as HTMLElement
  }

  // root ── mid (done, quiet) ── leaf (in review — the one thing asking)
  beforeEach(() => {
    harness.issues = [
      issue('root', { title: 'Mission' }),
      issue('mid', {
        parentId: 'root',
        title: 'Finished parent',
        stage: 'done',
        memberSessionIds: ['busy', 'busy2'],
      }),
      issue('leaf', { parentId: 'mid', title: 'Wants a decision', stage: 'review' }),
    ]
    harness.sessions = [session('busy', { issueId: 'mid' }), session('busy2', { issueId: 'mid' })]
  })

  it('drops a finished task whose only agent is parked, in Working', () => {
    harness.issues = [
      issue('root', { title: 'Mission' }),
      issue('parked', {
        parentId: 'root',
        title: 'Parked',
        stage: 'done',
        memberSessionIds: ['p'],
      }),
      issue('running', {
        parentId: 'root',
        title: 'Running',
        stage: 'in_progress',
        memberSessionIds: ['r'],
      }),
    ]
    harness.sessions = [
      session('p', { issueId: 'parked', status: 'hibernated' }),
      session('r', { issueId: 'running', agentState: WORKING }),
    ]
    harness.ui.set('podium.flightDeck.mode', 'working')
    deck()
    expect(document.querySelector('[data-flight-issue="parked"]')).toBeNull()
    expect(document.querySelector('[data-flight-issue="running"]')).not.toBeNull()
  })

  it('still draws the tree down to the match in Needs you', () => {
    harness.ui.set('podium.flightDeck.mode', 'needs-you')
    deck()
    // The path survives — an exception you cannot place is not useful.
    expect(strip('mid')).toBeTruthy()
    expect(strip('leaf')).toBeTruthy()
  })

  // The heart of it: a path row is scaffolding, and scaffolding does not carry a
  // fill, a state word, or a crew of agents that are not asking for anything.
  it('renders a path-only row as scaffolding, not as a second thing needing you', () => {
    harness.ui.set('podium.flightDeck.mode', 'needs-you')
    deck()
    const context = band('mid')
    expect(context.className).toContain('bg-transparent')
    expect(context.className).not.toContain('bg-tabstrip')
    // Its two agents came with it before; now neither renders.
    expect(strip('mid').textContent).not.toContain('busy')
    expect(strip('mid').textContent).not.toContain('busy2')
    // And it no longer reports a state of its own.
    expect(strip('mid').textContent).not.toContain('done')
    // The match itself is still a full strip.
    expect(band('leaf').className).toContain('bg-tabstrip')
  })

  it('leaves every row a full strip in Full spine', () => {
    harness.ui.set('podium.flightDeck.mode', 'full')
    deck()
    expect(band('mid').className).toContain('bg-tabstrip')
    expect(strip('mid').textContent).toContain('busy')
  })

  /**
   * POD-1452. This view was exempt from both rules above, because it matched
   * whole open TASKS: every row it kept was live work in its own right and its
   * crew came with it. It matches agents now, so the same fixture reads the same
   * way here — the row on the path to the working agent is scaffolding, and the
   * two idle agents on it are not what `Working` means.
   */
  it('renders a path-only row as scaffolding in Working too', () => {
    harness.issues = [
      issue('root', { title: 'Mission' }),
      issue('mid', {
        parentId: 'root',
        title: 'Finished parent',
        stage: 'done',
        memberSessionIds: ['busy', 'busy2'],
      }),
      issue('leaf', {
        parentId: 'mid',
        title: 'Wants a decision',
        stage: 'review',
        memberSessionIds: ['runner'],
      }),
    ]
    harness.sessions = [
      session('busy', { issueId: 'mid' }),
      session('busy2', { issueId: 'mid' }),
      session('runner', { issueId: 'leaf', agentState: WORKING }),
    ]
    harness.ui.set('podium.flightDeck.mode', 'working')
    deck()
    expect(band('mid').className).toContain('bg-transparent')
    expect(strip('mid').textContent).not.toContain('busy')
    expect(band('leaf').className).toContain('bg-tabstrip')
    expect(document.querySelector('[data-flight-session="runner"]')).not.toBeNull()
  })

  // The other half: an open task nobody is on is not active work, whatever its
  // stage says (POD-1452).
  it('drops an open task with no agent on it, in Working', () => {
    harness.ui.set('podium.flightDeck.mode', 'working')
    deck()
    expect(document.querySelector('[data-flight-issue="leaf"]')).toBeNull()
    expect(screen.getByText('No agent in this mission is working right now.')).toBeTruthy()
  })

  /**
   * THE TWO NARROWED VIEWS ARE DISJOINT (POD-1452) — and this is the shape that
   * makes the split safe.
   *
   * An agent stopped on a question is not working, so it leaves `Working`
   * entirely. On a mission where that is the ONLY agent, `Working` therefore
   * draws a blank column — which reads as "nothing here" when the truth is "all
   * of it is waiting on you". The empty line is the only thing on screen at that
   * moment, so it is where the count belongs, and it points at the tab that has
   * them.
   */
  it('sends an asking agent to Needs you and counts it on the empty Working column', () => {
    harness.issues = [
      issue('root', { title: 'Mission' }),
      issue('leaf', { parentId: 'root', title: 'Wants a decision', memberSessionIds: ['asker'] }),
    ]
    harness.sessions = [
      session('asker', {
        issueId: 'leaf',
        agentState: { phase: 'needs_user', since: '2026-01-01T00:00:00.000Z' },
      }),
    ]
    harness.ui.set('podium.flightDeck.mode', 'working')
    deck()
    expect(document.querySelector('[data-flight-session="asker"]')).toBeNull()
    expect(screen.getByText('No agent is working — 1 is waiting on you.')).toBeTruthy()
    cleanup()
    harness.ui.set('podium.flightDeck.mode', 'needs-you')
    deck()
    expect(document.querySelector('[data-flight-session="asker"]')).not.toBeNull()
  })

  /**
   * THE ONE-TASK MISSION (POD-1356) — where the bar had no effect at all.
   *
   * With no sub-tasks the whole column IS the header's roster, and that roster
   * was read with `matched` forced true: no view could remove an agent from it,
   * so all three views drew the same screen. The mission ROW is still exempt —
   * the header names what is on screen — but its crew is content.
   */
  describe('a mission with no sub-tasks', () => {
    beforeEach(() => {
      harness.issues = [issue('root', { title: 'Mission', memberSessionIds: ['idle'] })]
      harness.sessions = [session('idle', { issueId: 'root' })]
    })

    it('shows the mission agent in Full', () => {
      harness.ui.set('podium.flightDeck.mode', 'full')
      deck()
      expect(document.querySelector('[data-flight-session="idle"]')).not.toBeNull()
    })

    it('drops it in Needs you and names the view that emptied the column', () => {
      harness.ui.set('podium.flightDeck.mode', 'needs-you')
      deck()
      expect(document.querySelector('[data-flight-session="idle"]')).toBeNull()
      expect(screen.getByText('No agent in this mission is asking for you.')).toBeTruthy()
      // The old line claimed an unstaffed mission, about one with a live agent.
      expect(screen.queryByText('No sessions or sub-tasks are attached.')).toBeNull()
    })
  })
})
