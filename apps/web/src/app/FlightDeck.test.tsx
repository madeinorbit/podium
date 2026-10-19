import '@/test-support/mock-pool-fixture'
import { readFileSync, writeFileSync } from 'node:fs'
import { asIssueId, type TaskCostWire } from '@podium/model/browser'
import { resetPolledQueryCache } from '@/lib/use-polled-query'
import { DEFAULT_SETTINGS, nativeAccountId } from '@podium/runtime'
// @vitest-environment happy-dom
import { withKeyedInputs } from '@podium/client-core/test-support/keyed-inputs'
import {
  ConversationCache,
  type ConversationCacheOptions,
  DraftStore,
} from '@podium/client-core/conversation'
import { dedupeSessions } from '../../../../tests/worklist/diagnostics/reference-state'
import { createKernelReplica, createSideCache, memoryStorage } from '@podium/client-core/replica'
import { allIssueViewModels } from '../../../../tests/worklist/diagnostics/reference/issue-view-models'
import { type SessionView, sessionViews } from '@podium/client-core/session-values'
import { buildFlightDeckRows, missionIssueIds } from '@podium/client-core/values'

import { act, cleanup, fireEvent, render, screen, waitFor, } from '@testing-library/react'
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { IssueExplorerProvider } from '@/features/issues/explorer/explorer-context'
import { ConfirmProvider } from '@/lib/hooks/use-confirm'
import { fixtureStoreSnapshot } from '@/test-support/fixture-store'
import { syncPoolFixture } from '@/test-support/pool-fixture'
import { buildCorpus } from '../../../../tests/worklist/harness/src/fixture/corpus'
import { seedCacheFromCorpus } from '../../../../tests/worklist/shared/src/scenarios'
import {
  continuationPresenceLine,
  deckTaskUnread,
  defaultFolded,
  FlightDeck,
  isFolded,
  readFolds,
  writeFolds,
} from './FlightDeck'
import { defaultWaterfallRowZoom, defaultWaterfallTaskWidth } from './FlightDeckWaterfall'
import { OperatorFocusProvider } from './operator-focus'
import { clearHoveredSession, setHoveredSession } from './session-hover'
import { OPEN_RIGHT_PANEL_EVENT, REVEAL_IN_DECK_EVENT, RIGHT_PANEL_KEY } from './shell-state'
import { useRuntimeSelector as selectFixtureSnapshot } from './store'

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
  costAnswer: null as TaskCostWire | null,
  codingHarness: 'claude-code' as 'claude-code' | 'codex',
  selectedIssueId: null as string | null,
  paneA: null as string | null,
  paneB: null as string | null,
  split: false,
  focusedPane: 'A' as 'A' | 'B',
  coarseNow: Date.parse('2026-01-01T00:10:00.000Z'),
  display: 'compact' as 'compact' | 'expanded',
  onDisplayChange: vi.fn(),
  openSessionTab: vi.fn(),
  openSessionAtTranscript: vi.fn(),
  focusIssueSession: vi.fn(async () => null),
  setPanelMode: vi.fn(),
  preferPanelMode: vi.fn(),
  setSelectedIssueId: vi.fn(),
  setIssueTucked: vi.fn(async () => undefined),
  updateIssue: vi.fn(async (_id: string, _patch: unknown) => undefined),
  closeIssue: vi.fn(async (_id: string, _reason?: string) => undefined),
  ui: new Map<string, string>(),
  listeners: new Set<(keys: ReadonlySet<string>) => void>(),
  setPlacement: vi.fn(async (_input: unknown) => undefined),
  startIssue: vi.fn(async (_input: unknown) => undefined),
  addSession: vi.fn(async (_input: unknown) => undefined),
  transcriptRead: vi.fn(
    async (_input: unknown): Promise<{ items: unknown[]; hasMore: boolean; head?: string }> => ({
      items: [],
      hasMore: false,
    }),
  ),
  issueEvents: vi.fn(async (_input: unknown): Promise<unknown[]> => []),
  issueVisitBaseline: null as { issueId: string; readAt: string | null; openedAt: string } | null,
  replica: {
    transcriptWindow: vi.fn(() => undefined),
    putTranscriptWindow: vi.fn(),
  },
  trpc: {
    settings: { get: { query: async () => ({ ...DEFAULT_SETTINGS, roles: { ...DEFAULT_SETTINGS.roles,
      coding: { ...DEFAULT_SETTINGS.roles.coding, accountId: nativeAccountId(harness.codingHarness) } } }) } },
    features: { state: { query: async () => null } },
    // The mission header asks what the mission cost (POD-1862). These decks
    // have no figure, which is the ordinary case and renders no chip at all —
    // but the procedure has to EXIST, or the read throws inside the effect.
    cost: {
      task: { query: async () => harness.costAnswer },
      tasks: { query: async () => [] },
    },
    issues: {
      setPlacement: { mutate: (input: unknown) => harness.setPlacement(input) },
      start: { mutate: (input: unknown) => harness.startIssue(input) },
      addSession: { mutate: (input: unknown) => harness.addSession(input) },
      events: { query: (input: unknown) => harness.issueEvents(input) },
    },
    sessions: {
      transcriptRead: { query: (input: unknown) => harness.transcriptRead(input) },
    },
  } as unknown,
}))

const uiState = {
  get: (key: string): string | null => harness.ui.get(key) ?? null,
  set: (key: string, value: string | null): void => {
    if (value === null) harness.ui.delete(key)
    else harness.ui.set(key, value)
    for (const listener of harness.listeners) listener(new Set([key]))
  },
  subscribe: (cb: (keys: ReadonlySet<string>) => void): (() => void) => {
    harness.listeners.add(cb)
    return () => {
      harness.listeners.delete(cb)
    }
  },
}

const drafts = new DraftStore({
  storage: { get: () => null, set: () => {} },
  hub: {
    on: () => () => {},
    sendDraftEdit: () => false,
    connectionHealth: () => ({ status: 'ok' }),
  } as never,
})
afterAll(() => drafts.dispose())
let conversations: ConversationCache | undefined
afterEach(() => {
  conversations?.dispose()
  conversations = undefined
})
const owner = withKeyedInputs({
  ownConversations: (options: ConversationCacheOptions) =>
    (conversations ??= new ConversationCache(options)),
  drafts,
  getSnapshot: () =>
    fixtureStoreSnapshot(
      selectFixtureSnapshot((state) => state),
      () =>
        syncPoolFixture(
          selectFixtureSnapshot((state) => state),
          true,
        ),
    ),
  subscribe: () => () => {},
})
// The owned conversation hook imports its provider directly. Both access
// paths must borrow the same fixture principal.
vi.mock('../../../../packages/client-core/src/react/provider', async (original) => ({
  ...(await original<typeof import('../../../../packages/client-core/src/react/provider')>()),
  useStoreHandle: () => owner,
}))
vi.mock('@podium/client-core/react', async (original) => ({
  ...(await original<typeof import('@podium/client-core/react')>()),
  useStoreHandle: () => owner,
}))

vi.mock('./store', () => ({
  useRuntimeSelector: (select: (store: Record<string, unknown>) => unknown) =>
    select({
      issues: harness.issues,
      sessions: harness.sessions,
      repos: harness.repos,
      selectedIssueId: harness.selectedIssueId,
      paneA: harness.paneA,
      paneB: harness.paneB,
      split: harness.split,
      focusedPane: harness.focusedPane,
      coarseNow: harness.coarseNow,
      uiState,
      setSelectedWorktree: vi.fn(),
      setSelectedIssueId: harness.setSelectedIssueId,
      openSessionTab: harness.openSessionTab,
      openSessionAtTranscript: harness.openSessionAtTranscript,
      issueVisitBaseline: harness.issueVisitBaseline,
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
      replica: harness.replica,
      hub: { subscribeTranscript: () => () => {} },
      trpc: harness.trpc,
    }),
  useSessionDraft: () => '',
}))

// WorkerLabel reads served harness descriptors through the real provider;
// this fixture supplies bundled descriptors alongside its local store stub.
vi.mock('@/lib/use-harness-descriptors', () => ({
  useHarnessDescriptors: () => ({ served: undefined, status: 'unavailable' }),
}))

vi.mock('@/lib/use-feature', () => ({
  useFeature: () => false,
}))

type Issue = Record<string, unknown>

const issue = (id: string, over: Issue = {}): Issue => ({
  id,
  seq: Number(id.replace(/\D/g, '')) || 1,
  prefix: 'POD',
  displayRef: `POD-${Number(id.replace(/\D/g, '')) || 1}`,
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
const session = (id: string, over: Record<string, unknown> = {}): SessionView =>
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
  }) as unknown as SessionView

/** An agent mid-turn — what `Working` asks about, once per agent (POD-1452). */
const WORKING = { phase: 'working', since: '2026-01-01T00:00:00.000Z' } as const

function DeckHarness() {
  return (
    // ConfirmProvider because the task menu's Archive/Delete now use the
    // app-wide dialog (POD-1077), exactly as AppShell supplies it in the app.
    <ConfirmProvider>
      <OperatorFocusProvider missionId="root">
        {/* The explorer's stack lives above the dock in the app, and the deck
            reads it to know which task the dock is already showing — so the
            harness supplies the real provider rather than the default context. */}
        <IssueExplorerProvider>
          <FlightDeck
            onCollapse={vi.fn()}
            display={harness.display}
            onDisplayChange={harness.onDisplayChange}
          />
        </IssueExplorerProvider>
      </OperatorFocusProvider>
    </ConfirmProvider>
  )
}

const deck = async (): Promise<ReturnType<typeof render>> => {
  let view!: ReturnType<typeof render>
  // The real pool imports preferences in a batch after the initial render.
  await act(async () => {
    view = render(<DeckHarness />)
  })
  return view
}

/** Lets the double-click window and other pending timers flush. */
const settle = async (): Promise<void> => {
  await act(async () => {
    vi.advanceTimersByTime(400)
  })
}

it('keeps explicit Full expansion reachable without forcing compact or hiding collapse', async () => {
  harness.display = 'expanded'
  await deck()
  expect(harness.onDisplayChange).not.toHaveBeenCalled()
  expect(screen.getByTestId('flight-deck-scroller').classList.contains('flight-full-panel')).toBe(true)
  const compact = screen.getByRole('button', { name: 'Use compact Flight Deck' })
  expect(compact.getAttribute('aria-pressed')).toBe('true')
  fireEvent.click(compact)
  expect(harness.onDisplayChange).toHaveBeenCalledExactlyOnceWith('compact')
  // Expand and collapse are the eyebrow's own controls; no view bar sits below.
  expect(screen.getByRole('button', { name: 'Collapse Flight Deck' }).parentElement).toBe(compact.parentElement)
  expect(screen.queryByRole('group', { name: 'Deck view' })).toBeNull()
})

describe('mission header picks (POD-1639)', () => {
  const title = (): HTMLElement => screen.getByTitle(/^Focus POD-/)
  /** Every `podium:open-right-panel` detail the deck asked for, in order. */
  const panelRequests = (): string[] => {
    const details: string[] = []
    const listener = (event: Event): void => {
      details.push(String((event as CustomEvent).detail))
    }
    window.addEventListener(OPEN_RIGHT_PANEL_EVENT, listener)
    afterEachListeners.push(() => window.removeEventListener(OPEN_RIGHT_PANEL_EVENT, listener))
    return details
  }

  it('closes the dock when it already shows the mission', async () => {
    // The explorer follows the selected mission, so its root is on screen.
    harness.ui.set(RIGHT_PANEL_KEY, 'issue')
    const details = panelRequests()
    await deck()
    fireEvent.click(title())
    await settle()
    expect(details).toEqual(['close'])
  })

  it('opens the dock when it is closed', async () => {
    const details = panelRequests()
    await deck()
    fireEvent.click(title())
    await settle()
    fireEvent.click(title())
    await settle()
    expect(details).toEqual(['issue', 'issue'])
  })
})

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true })
  harness.ui.clear()
  harness.costAnswer = null
  resetPolledQueryCache()
  harness.listeners.clear()
  harness.repos = []
  harness.machines = []
  harness.codingHarness = 'claude-code'
  harness.selectedIssueId = 'root'
  harness.paneA = null
  harness.paneB = null
  harness.split = false
  harness.focusedPane = 'A'
  harness.coarseNow = Date.parse('2026-01-01T00:10:00.000Z')
  harness.display = 'compact'
  harness.onDisplayChange.mockClear()
  harness.openSessionTab.mockClear()
  harness.openSessionAtTranscript.mockClear()
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
  harness.transcriptRead.mockClear()
  harness.issueEvents.mockClear()
  harness.replica.transcriptWindow.mockClear()
  harness.replica.putTranscriptWindow.mockClear()
  harness.issueVisitBaseline = null
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
const scrollHeightDescriptor = Object.getOwnPropertyDescriptor(
  HTMLElement.prototype,
  'scrollHeight',
)

describe('waterfall automatic geometry', () => {
  it('uses the available height for sparse and crowded crews', () => {
    expect(defaultWaterfallRowZoom(700, [1, 1, 2])).toBe(1.55)
    expect(defaultWaterfallRowZoom(240, [3, 4, 2, 5, 3])).toBe(0.72)
    const middle = defaultWaterfallRowZoom(320, [2, 2, 2, 2])
    expect(middle).toBeGreaterThan(0.72)
    expect(middle).toBeLessThan(1.55)
  })

  it('gives long task titles more room while preserving the timeline', () => {
    const short = defaultWaterfallTaskWidth(['Build'], 680, true)
    const long = defaultWaterfallTaskWidth(
      ['Coordinate the production database migration and verification'],
      680,
      true,
    )
    expect(long).toBeGreaterThan(short)
    expect(long).toBeLessThanOrEqual(300)
    expect(defaultWaterfallTaskWidth(['Long task title'], 300, false)).toBe(168)
  })
})

afterEach(() => {
  for (const off of afterEachListeners.splice(0)) off()
  cleanup()
  vi.useRealTimers()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  if (scrollHeightDescriptor)
    Object.defineProperty(HTMLElement.prototype, 'scrollHeight', scrollHeightDescriptor)
  else Reflect.deleteProperty(HTMLElement.prototype, 'scrollHeight')
})

describe('mission key uniqueness', () => {
  it('keeps header controls distinct when switching missions with no duplicate members', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
    harness.issues = [issue('root'), issue('next')]
    harness.sessions = []
    const rendered = await deck()
    expect(screen.getByRole('button', { name: 'Add agent to mission' })).toBeTruthy()

    harness.selectedIssueId = 'next'
    rendered.rerender(<DeckHarness />)
    expect(screen.getByRole('button', { name: 'Add agent to mission' })).toBeTruthy()
    expect(
      errors.mock.calls.filter(([message]) =>
        String(message).includes('Encountered two children with the same key'),
      ),
    ).toEqual([])
  })

  it('keeps baseline corpus mission membership and deck rows unique', () => {
    // Use the original buildCorpus(1, 1), normalized replica and runtime session
    // order. The fixture's resume twins remain intact in the input corpus.
    const corpus = buildCorpus(1, 1)
    const replica = createKernelReplica({
      cache: seedCacheFromCorpus(corpus),
      side: createSideCache({ storage: memoryStorage(), enumerateKeys: () => [] }),
    })
    const models = allIssueViewModels(replica)
    const sessions = dedupeSessions(
      sessionViews([...replica.rows('sessions')], {
        userId: 'operator',
        userStates: [...replica.rows('sessionUserStates')],
        machines: [...replica.rows('machines')],
        repos: [...replica.rows('repos')],
      }),
    )
    expect(corpus.issues).toHaveLength(4867)
    expect(new Set(corpus.issues.map((row) => row.id)).size).toBe(corpus.issues.length)
    expect(corpus.sessions).toHaveLength(4304)
    expect(sessions).toHaveLength(4302)
    expect(models).toHaveLength(corpus.issues.length)
    expect(new Set(models.map((row) => row.id)).size).toBe(models.length)

    for (const [rootId, rowCount] of [
      ['i1884', 362],
      ['i3777', 135],
      ['i1313', 1],
    ] as const) {
      const members = [...missionIssueIds(models, rootId, sessions)]
      const rows = buildFlightDeckRows(models, sessions, rootId)
      const rowIds = rows.map((row) => row.issue.id)
      expect(new Set(members).size, rootId).toBe(members.length)
      expect(new Set(rowIds).size, rootId).toBe(rowIds.length)
      expect(rows, rootId).toHaveLength(rowCount)
      expect(
        rows.filter((row) => row.issue.id === rootId),
        rootId,
      ).toHaveLength(1)
      expect(
        rowIds.every((id) => members.includes(id)),
        rootId,
      ).toBe(true)
    }
  })
})

const chevron = (title: string): HTMLElement =>
  screen.getByRole('button', { name: new RegExp(`^(Expand|Collapse) ${title}$`) })

describe('the cold deck (POD-1112)', () => {
  /** The composer's placeholder: a draft issue minted so a session has somewhere
   *  to live. After a reload the selection can still point at one whose session
   *  never started. */
  const vessel = (over: Issue = {}): Issue =>
    issue('v1', { title: 'Draft', stage: 'backlog', isDraftVessel: true, ...over })

  it('shows the empty state for a selection left on an empty draft vessel', async () => {
    harness.issues = [vessel()]
    harness.sessions = []
    harness.selectedIssueId = 'v1'
    await deck()
    expect(screen.getByTestId('flight-empty')).toBeTruthy()
    // Not the mission chrome the vessel used to get: no header, no filters.
    expect(screen.queryByText('Draft')).toBeNull()
    expect(screen.queryByRole('group', { name: 'Task filters' })).toBeNull()
  })

  it('still shows the mission once the vessel has its session', async () => {
    harness.issues = [vessel({ memberSessionIds: ['s-new'] })]
    harness.sessions = [session('s-new', { issueId: 'v1' })]
    harness.selectedIssueId = 'v1'
    await deck()
    expect(screen.queryByTestId('flight-empty')).toBeNull()
    expect(screen.getByRole('group', { name: 'Task filters' })).toBeTruthy()
  })

  it('names an unnamed mission from the shared draft fallback, not the harness title', async () => {
    harness.issues = [vessel({ memberSessionIds: ['s-new'] })]
    harness.sessions = [
      session('s-new', {
        issueId: 'v1',
        name: undefined,
        title: 'Unrelated older conversation',
      }),
    ]
    harness.selectedIssueId = 'v1'
    await deck()
    expect(document.querySelector('.shell-type-column-title')?.textContent).toBe(
      'New Claude session',
    )
  })

  it('shows an optimistic rename before the server clears the draft flag', async () => {
    harness.issues = [vessel({ title: 'Renamed mission', memberSessionIds: ['s-new'] })]
    harness.sessions = [session('s-new', { issueId: 'v1', name: 'Agent label' })]
    harness.selectedIssueId = 'v1'
    await deck()
    expect(document.querySelector('.shell-type-column-title')?.textContent).toBe('Renamed mission')
  })

  it('shows the empty state when nothing at all is selected', async () => {
    harness.selectedIssueId = null as unknown as string
    await deck()
    expect(screen.getByTestId('flight-empty')).toBeTruthy()
  })
})

describe('Full task filters', () => {
  it('keeps the coordinator visible for every filter, Done and a search with no matches', async () => {
    harness.issues = [
      issue('root', { coordinatorSessionId: 'coord', memberSessionIds: ['coord'] }),
      issue('t1', { parentId: 'root', memberSessionIds: ['s1'] }),
      issue('t2', { parentId: 'root', stage: 'backlog' }),
      issue('t3', { parentId: 'root', stage: 'done', closedAt: '2026-01-01T00:00:00Z' }),
    ]
    harness.sessions = [
      session('coord', { issueId: 'root', agentState: { phase: 'idle' } }),
      session('s1', { issueId: 't1', agentState: WORKING }),
    ]
    await deck()
    const coordinator = () => document.querySelector('[data-flight-session="coord"]')
    for (const name of ['All 3', 'Needs you 0', 'Active 1', 'Up next 1', 'Done 1']) {
      await act(async () => { fireEvent.click(screen.getByRole('button', { name })) })
      expect(coordinator()).not.toBeNull()
      expect(harness.ui.has('podium.flightDeck.mode')).toBe(false)
    }
    fireEvent.click(screen.getByRole('button', { name: 'Search this mission' }))
    fireEvent.change(screen.getByRole('textbox', { name: 'Search this mission' }), {
      target: { value: 'no task matches' },
    })
    expect(coordinator()).not.toBeNull()
    expect(screen.getByText('Nothing in this mission matches that.')).toBeDefined()
  })

  it('reveals a finished session from a narrowed Full filter and search', async () => {
    harness.issues = [
      issue('root'), issue('t1', { parentId: 'root', stage: 'done',
        closedAt: '2026-01-01T00:00:00Z', memberSessionIds: ['s1'] }),
    ]
    harness.sessions = [session('s1', { issueId: 't1', agentState: { phase: 'ended' } })]
    await deck()
    fireEvent.click(screen.getByRole('button', { name: 'Up next 0' }))
    expect(screen.getByText('No tasks match this filter.')).toBeDefined()
    fireEvent.click(screen.getByRole('button', { name: 'Search this mission' }))
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'no match' } })
    await act(async () => {
      window.dispatchEvent(new CustomEvent(REVEAL_IN_DECK_EVENT, { detail: 's1' }))
    })
    expect(screen.getByRole('button', { name: 'All 1' }).getAttribute('aria-pressed')).toBe('true')
    expect(screen.getByRole('button', { name: 'Done 1' }).getAttribute('aria-pressed')).toBe('true')
    expect(screen.queryByRole('textbox')).toBeNull()
    expect(document.querySelector('[data-flight-session="s1"]')).not.toBeNull()
  })
})

describe('Full mission header', () => {
  const description = () => screen.getByTestId('full-mission-description')
  const details = () => fireEvent.click(screen.getByRole('button', { name: 'Read more' }))

  it('expands human markdown sections and Acceptance, with no agent brief or invented columns', async () => {
    harness.issues = [issue('root', {
      description: 'A human summary.\n\n## Delivery\n\n- Keep the authored structure.\n- **Ship** the increment.',
      brief: 'SECRET AGENT INSTRUCTIONS',
      activityNotes: 'Agent progress update',
      acceptance: '- Human can read the result.\n- Existing actions still work.',
    })]
    harness.sessions = []
    await deck()
    expect(description().querySelector('.flight-full-description-summary')).toBeTruthy()
    expect(description().textContent).toContain('A human summary.')
    expect(screen.queryByRole('region', { name: 'Acceptance' })).toBeNull()
    captureHeader('Two-line human summary')
    details()
    expect(screen.getByRole('button', { name: 'Collapse' }).getAttribute('aria-expanded')).toBe('true')
    expect(description().querySelector('h2')?.textContent).toBe('Delivery')
    expect(description().querySelector('strong')?.textContent).toBe('Ship')
    expect(screen.getByRole('region', { name: 'Acceptance' }).querySelectorAll('li')).toHaveLength(2)
    for (const text of ['SECRET AGENT INSTRUCTIONS', 'Agent progress update', 'Goal', 'Scope']) {
      expect(description().textContent).not.toContain(text)
    }
    captureHeader('Expanded authored sections and Acceptance')
    fireEvent.click(screen.getByRole('button', { name: 'Collapse' }))
    expect(screen.getByRole('button', { name: 'Read more' }).getAttribute('aria-expanded')).toBe('false')
    expect(screen.queryByRole('region', { name: 'Acceptance' })).toBeNull()
  })

  it('keeps task details on the existing detail action', async () => {
    harness.issues = [issue('root', { description: 'Human description.' })]
    harness.sessions = []
    const opened = vi.fn()
    window.addEventListener(OPEN_RIGHT_PANEL_EVENT, opened)
    afterEachListeners.push(() => window.removeEventListener(OPEN_RIGHT_PANEL_EVENT, opened))
    await deck()
    details()
    fireEvent.click(screen.getByRole('button', { name: 'Open task details' }))
    expect(opened).toHaveBeenCalledTimes(1)
    expect((opened.mock.calls[0]?.[0] as CustomEvent).detail).toBe('issue')
    expect(harness.addSession).not.toHaveBeenCalled()
  })

  it('shows acceptance without substituting instructions when the description is absent', async () => {
    harness.issues = [issue('root', {
      brief: 'Agent-only instructions', activityNotes: 'Agent-only note', acceptance: 'A human check.',
    })]
    harness.sessions = []
    await deck()
    expect(description().textContent).toContain('No description yet.')
    details()
    expect(screen.getByRole('region', { name: 'Acceptance' }).textContent).toContain('A human check.')
    expect(description().textContent).not.toContain('Agent-only')
  })

  it('does not offer empty details and resets expansion on a different mission', async () => {
    harness.issues = [issue('root', { description: 'First mission.' }), issue('other')]
    harness.sessions = []
    const ui = await deck()
    details()
    harness.selectedIssueId = 'other'
    ui.rerender(<DeckHarness />)
    await waitFor(() => expect(description().textContent).toContain('No description yet.'))
    expect(screen.queryByRole('button', { name: 'Read more' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Collapse' })).toBeNull()
  })

  it('counts leaves consistently with the Full done line, without parents or phases', async () => {
    harness.issues = [
      issue('root'), issue('phase', { parentId: 'root', type: 'phase' }),
      issue('parent', { parentId: 'phase' }),
      issue('finished', { parentId: 'parent', stage: 'done', closedAt: '2026-01-01T00:00:00Z' }),
      issue('future', { parentId: 'parent', stage: 'backlog' }),
      issue('cancelled', { parentId: 'phase', stage: 'done', closedReason: 'cancelled', closedAt: '2026-01-01T00:00:00Z' }),
      issue('proposal', { parentId: 'root', stage: 'proposed' }),
    ]
    harness.sessions = []
    await deck()
    await waitFor(() => expect(screen.getByTestId('mission-gauge').getAttribute('aria-label')).toBe(
      '2 of 3 tasks done, 1 to go · 0 agents',
    ))
    expect(screen.getByRole('button', { name: /2 tasks done Show/ })).toBeTruthy()
    const before = screen.getByTestId('mission-gauge').getAttribute('aria-label')
    fireEvent.click(screen.getByRole('button', { name: /2 tasks done Show/ }))
    expect(screen.getByTestId('mission-gauge').getAttribute('aria-label')).toBe(before)
    captureHeader('Leaf totals · parents and phases excluded')
  })

  it('renders all four bands from the shared Full model', async () => {
    harness.issues = [issue('root', { description: 'A mission with work in every band.' }),
      issue('done', { parentId: 'root', stage: 'done', closedAt: '2026-01-01T00:00:00Z' }),
      issue('working', { parentId: 'root', memberSessionIds: ['worker'] }),
      issue('blocked', { parentId: 'root', stage: 'backlog', blocked: true,
        deps: [{ id: 'future', type: 'blocked-by' }] }),
      issue('future', { parentId: 'root', stage: 'backlog' }),
    ]
    harness.sessions = [session('worker', { issueId: 'working', agentState: WORKING })]
    await deck()
    expect(screen.getByTestId('mission-gauge').getAttribute('aria-label')).toBe(
      '1 of 4 tasks done, 1 underway, 1 blocked, 1 to go · 1 working',
    )
    captureHeader('Four bands · shared live leaf totals')
  })

  it('counts a standalone mission as its one task', async () => {
    harness.issues = [issue('root', { stage: 'backlog' })]
    harness.sessions = []
    await deck()
    expect(screen.getByTestId('mission-gauge').getAttribute('aria-label')).toBe(
      '0 of 1 task done, 1 to go · 0 agents',
    )
  })

  it('keeps the cost floor and live crew while Add agent uses the existing default action', async () => {
    harness.issues = [issue('root', { description: 'Human summary.', defaultAgent: 'codex', agentProfileId: 'profile' })]
    harness.sessions = [session('present', { issueId: 'root', agentState: WORKING })]
    const usage = { model: 'claude-opus-5', inputTokens: 1_000_000, outputTokens: 0,
      cacheReadTokens: 0, cacheCreationTokens: 0, cacheCreation1hTokens: 0, messages: 2 }
    harness.costAnswer = {
      issueId: asIssueId('root'), state: 'costed', own: { models: [usage], messages: 2, sessionCount: 1 },
      rollup: { models: [usage], messages: 2, sessionCount: 1 }, descendantCount: 0,
      provisional: false, floor: 'partial', uncostedSessionCount: 1, harnesses: ['codex'], sessions: [],
    } satisfies TaskCostWire
    await deck()
    await waitFor(() => expect(screen.getByTestId('mission-cost-chip').textContent).toContain('≥$'))
    expect(screen.getByTestId('mission-live-chip').textContent).toBe('1 working')
    expect(screen.getByRole('button', { name: 'Collapse Flight Deck' })).toBeTruthy()
    captureHeader('Live crew · partial cost · Add agent')
    fireEvent.click(screen.getByRole('button', { name: 'Add agent to mission' }))
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Add Codex (default)' }))
    await waitFor(() => expect(harness.addSession).toHaveBeenCalledWith({ id: 'root' }))
    expect(harness.focusIssueSession).toHaveBeenCalledWith('root', { excludeSessionIds: ['present'] })
  })
})

// Static review evidence comes from the tested header DOM, without browser driving.
const headerCaptures: { title: string; html: string }[] = []
function captureHeader(title: string) {
  if (!process.env['PODIUM_FULL_HEADER_REVIEW_HTML']) return
  headerCaptures.push({ title, html: document.querySelector('.deck-header')?.outerHTML ?? '' })
}
afterAll(() => {
  const path = process.env['PODIUM_FULL_HEADER_REVIEW_HTML']
  if (!path) return
  const sourceCss = readFileSync('src/styles.css', 'utf8')
  const css = sourceCss.split('/* Full mission header (v6).')[1]?.split('/* ── THE RUNNING')[0]
  const hatch = sourceCss.match(/\.gauge-hatch\s*\{[^}]+\}/)?.[0] ?? ''
  const tokens = readFileSync('src/index.css', 'utf8').split('[data-theme="podium"].dark {')[1]?.split('}')[0]
  writeFileSync(path, `<!doctype html><html lang="en"><meta charset="utf-8"><title>Full mission header</title><style>
    :root{${tokens}--font-mono:ui-monospace,monospace;--shell-type-micro:10.5px}
    *{box-sizing:border-box}body{margin:0;padding:24px;background:#16171a;color:#d7dae0;font:12px system-ui}main{max-width:1100px;margin:auto}article{margin:24px 0}button{font:inherit;color:inherit;background:none;border:0;cursor:pointer}svg{flex:none}.samples{display:flex;flex-wrap:wrap;align-items:start;gap:20px}.sample{flex:none;border:1px solid #33373f;border-radius:8px;background:#1d1f23;padding:12px 16px}.sample>p{color:#949aa4}.shell-type-micro{font-size:10.5px}.shell-type-column-title{margin:4px 0;font-weight:600}.deck-header>div:first-child{display:flex;align-items:center;gap:6px}.deck-header>div:first-child>span[aria-hidden]{flex:1}.deck-header button{flex-shrink:0}.deck-header h2{text-align:left}.deck-header .mt-2\\.5{margin-top:10px}.flight-full-gauge-row{display:flex;flex-wrap:wrap;align-items:center;margin-top:12px}.mission-gauge-full{display:flex;align-items:center}.mission-gauge-full [data-testid="mission-gauge-track"]{display:flex;height:26px;gap:2px;padding:2px;border-radius:8px;background:#16171a}.mission-gauge-full [data-testid="mission-live-chip"], [data-testid="mission-cost-chip"], button[aria-label="Add agent to mission"]{display:flex;align-items:center;flex:none;height:26px;gap:6px;padding:0 9px;border-radius:8px;background:#16171a;white-space:nowrap}[data-testid="mission-cost-chip"]{border:1px solid #3a3f48}
    /* Full mission header (v6).${css}\n${hatch}
  </style><main><h1>Full mission header</h1><p>Actual tested header DOM at 300px, 480px and 900px. Summary and band shedding use the source CSS. Actions wrap and retain their labels. Static captures; use Read more and Collapse in the live Full view.</p>${headerCaptures.map(c => `<article><h2>${c.title}</h2><div class="samples">${[300,480,900].map(w => `<div class="sample" style="width:${w}px"><p>${w}px</p>${c.html}</div>`).join('')}</div></article>`).join('')}</main></html>`)
})

describe('flight deck mission agent action', () => {
  it('adds the selected agent to the mission root, even while a sub-task is focused', async () => {
    harness.issues = harness.issues.map((candidate) =>
      (candidate as Issue).id === 'root'
        ? { ...(candidate as Issue), worktreePath: '/repo', defaultAgent: 'claude-code' }
        : candidate,
    )
    harness.selectedIssueId = 't1'
    await deck()

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
    await deck()

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
    await deck()

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
    await deck()

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
    harness.codingHarness = 'codex'
    harness.repos = [
      { path: '/repo', kind: 'repository', branch: 'main', machineId: 'mine', worktrees: [] },
    ]
    harness.machines = [
      {
        id: 'mine',
        name: 'mine',
        hostname: 'mine',
        online: true,
        serviceAssignment: { server: false, agentExecution: true },
        availability: { epoch: 'boot-1', server: false, daemon: true, supervisor: true },
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
            defaultAgent: 'auto',
          }
        : candidate,
    )
    await deck()

    fireEvent.click(screen.getByRole('button', { name: 'Add agent to mission' }))

    const cursor = await screen.findByRole('menuitem', { name: /Add Cursor/ })
    expect(cursor.textContent).toContain('not installed')
    expect(cursor.getAttribute('data-refused')).toBe('true')
    fireEvent.click(cursor)
    expect(harness.addSession).not.toHaveBeenCalled()

    const codex = await screen.findByRole('menuitem', { name: 'Add Codex (default)' })
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
    const lone = { descendantIds: [], sessions: [{}] as SessionView[] }
    const pair = { descendantIds: [], sessions: [{}, {}] as SessionView[] }
    const branch = { descendantIds: ['x'], sessions: [{}] as SessionView[] }
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

  it('applies the default rule to the rendered spine', async () => {
    await deck()
    expect(chevron('Task t1').getAttribute('aria-expanded')).toBe('false')
    expect(chevron('Task t2').getAttribute('aria-expanded')).toBe('false')
    expect(chevron('Task t3').getAttribute('aria-expanded')).toBe('true')
  })

  it('records the operator’s fold explicitly, so the default cannot undo it', async () => {
    await deck()
    await act(async () => {
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

describe('flight deck sections (POD-710 §4.3, §4.4)', () => {
  it('turns a superseded empty mission into a forward signpost with a tuck choice', async () => {
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

    await deck()

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

    await deck()

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

    await deck()
    fireEvent.click(screen.getByRole('button', { name: /Done & tuck/ }))

    expect(harness.closeIssue).not.toHaveBeenCalled()
    const concerns = await screen.findByTestId('issue-close-concerns')
    expect(concerns.textContent).toContain('2 commits awaiting delivery')

    fireEvent.click(screen.getByRole('button', { name: /Close anyway/ }))
    expect(harness.closeIssue).toHaveBeenCalledWith('root', 'done')
    await waitFor(() => expect(harness.setIssueTucked).toHaveBeenCalledWith('root', true))
  })

  it('turns a hopscotch-empty origin into a signpost to the live tip', async () => {
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

    await deck()

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

  it('names the agent still on a task closed as a duplicate', async () => {
    harness.issues = duplicateRoot(['s-dupe'])
    harness.sessions = [session('s-dupe', { issueId: 'root', agentKind: 'codex' })]

    await deck()

    const card = screen.getByTestId('flight-continuation')
    // The lineage half is a fact about issues and survives untouched — this is
    // the trail that guarding `issueContinuation` would have deleted.
    expect(card.textContent).toContain('The same work is tracked in POD-1160')
    expect(card.textContent).toContain('Codex is still on this task.')
    expect(card.textContent).not.toContain('No session remains')
  })

  it('counts a parked agent as present, because parking is not leaving', async () => {
    harness.issues = duplicateRoot(['s-dupe'])
    harness.sessions = [
      session('s-dupe', { issueId: 'root', agentKind: 'codex', status: 'hibernated' }),
    ]

    await deck()

    // `sessionPresentOnTask` is `!archived && status !== 'exited'`, and sessions
    // here park far more often than they exit. A fix that waited for the session
    // to END would have stayed wrong on POD-1217 indefinitely.
    expect(screen.getByTestId('flight-continuation').textContent).toContain(
      'Codex is parked on this task.',
    )
  })

  it('keeps the empty-task wording when the task really is empty', async () => {
    harness.issues = duplicateRoot()
    harness.sessions = []

    await deck()

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

  it('gives a retired mission the signpost box and a direct tuck', async () => {
    harness.issues = retiredRoot()
    harness.sessions = []

    await deck()

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

  it('says finished over work that completed, cancelled over work that did not', async () => {
    harness.issues = retiredRoot({ closedReason: 'done' })
    harness.sessions = []

    await deck()

    expect(screen.getByTestId('flight-retired').textContent).toContain('This task is finished.')
  })

  /** The card is the CLOSED ending only. Every other empty-spine note is a state
   *  to read and leave alone, and none of them can be tucked — `setTucked`
   *  refuses an unfinished issue. */
  it('leaves a vacated but unfinished mission as a status line', async () => {
    harness.issues = retiredRoot({ stage: 'in_progress', closedReason: null })
    harness.sessions = []

    await deck()

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

  it('sinks proposals into their own tail, with no tree guide', async () => {
    await deck()
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
    expect(tree?.getAttribute('data-depth')).toBe('0')
  })

  it('keeps a proposed parent reachable in the Full tail after it leaves the accepted tree', async () => {
    harness.issues.push(issue('proposal-parent', { parentId: 'root', stage: 'proposed', title: 'Proposed parent' }),
      issue('proposal-child', { parentId: 'proposal-parent' }))
    await deck()
    const proposal = screen.getByTestId('flight-proposed').querySelector('[data-flight-issue="proposal-parent"]')
    expect(proposal).not.toBeNull()
    expect(screen.getByTestId('flight-deck-v6-rows').querySelector('[data-flight-issue="proposal-parent"]')).toBeNull()
    fireEvent.contextMenu(proposal!.querySelector('button')!)
    expect(await screen.findByText('Set status')).toBeTruthy()
  })

  it('keeps one fixed scrollport around sticky mission chrome and growing rows', async () => {
    await deck()

    const scroller = screen.getByTestId('flight-deck-scroller')
    const rows = screen.getByTestId('flight-deck-rows')
    const chrome = scroller.querySelector('.deck-chrome')

    expect(scroller.className).toContain('overflow-y-auto')
    expect(chrome?.classList.contains('sticky')).toBe(true)
    expect(scroller.contains(rows)).toBe(true)
    expect(rows.className).toContain('flex-none')
    expect(rows.className).not.toContain('overflow-y-auto')
  })

  it('reveals a folded session below the sticky mission chrome', async () => {
    const scrollIntoView = vi.fn()
    vi.spyOn(HTMLElement.prototype, 'scrollIntoView').mockImplementation(scrollIntoView)
    await deck()
    expect(document.querySelector('[data-flight-session="s1"]')).toBeNull()
    await act(async () => {
      window.dispatchEvent(new CustomEvent(REVEAL_IN_DECK_EVENT, { detail: 's1' }))
    })
    act(() => vi.advanceTimersByTime(20))
    expect(document.querySelector('[data-flight-session="s1"]')).not.toBeNull()
    expect(scrollIntoView).toHaveBeenCalledWith({ block: 'end' })
  })

  it('surfaces the archived sessions the tab strip dropped', async () => {
    harness.sessions = [
      ...harness.sessions,
      session('gone', { issueId: 't1', archived: true, name: 'Retired agent' }),
    ]
    harness.issues = harness.issues.map((raw) => {
      const candidate = raw as Issue
      return candidate.id === 't1' ? { ...candidate, memberSessionIds: ['s1', 'gone'] } : candidate
    })
    await deck()
    const toggle = screen.getByTestId('flight-archived-toggle')
    expect(toggle.textContent).toContain('1 archived session')
    expect(document.querySelector('[data-flight-session="gone"]')).toBeNull()
    act(() => {
      fireEvent.click(toggle)
    })
    expect(document.querySelector('[data-flight-session="gone"]')).not.toBeNull()
  })

  it('reveals an offscreen archived session by index after opening its tail', async () => {
    const archived = Array.from({ length: 300 }, (_, index) =>
      session(`archived-${index}`, { issueId: 't1', archived: true }),
    )
    harness.sessions.push(...archived)
    harness.issues = harness.issues.map((raw) => {
      const candidate = raw as Issue
      return candidate.id === 't1'
        ? { ...candidate, memberSessionIds: ['s1', ...archived.map((row) => row.sessionId)] }
        : candidate
    })
    const scrollIntoView = vi.fn()
    vi.spyOn(HTMLElement.prototype, 'scrollIntoView').mockImplementation(scrollIntoView)
    await deck()
    expect(document.querySelector('[data-flight-session="archived-299"]')).toBeNull()
    await act(async () => {
      window.dispatchEvent(new CustomEvent(REVEAL_IN_DECK_EVENT, { detail: 'archived-299' }))
    })
    act(() => vi.advanceTimersByTime(40))
    expect(document.querySelector('[data-flight-session="archived-299"]')).not.toBeNull()
    expect(scrollIntoView).toHaveBeenCalledWith({ block: 'end' })
    expect(document.querySelectorAll('[data-flight-session]').length).toBeLessThan(32)
  })

  it('shows a stopped session as Done with total working time', async () => {
    harness.sessions.push(
      session('gone', {
        issueId: 't1',
        status: 'exited',
        name: 'Stopped agent',
        agentState: { phase: 'ended', since: '2026-01-01T00:00:00.000Z', workingMsTotal: 65000 },
      }),
    )
    harness.ui.set('podium.flightDeck.folds', writeFolds(new Map([['t1', 'open']]))!)
    await deck()
    const row = document.querySelector('[data-flight-session="gone"]')
    expect(row).not.toBeNull()
    expect(row?.querySelector('.flight-v6-state')?.textContent).toBe('Done∑ 1:05')
  })

  it('offers session lifecycle from the open card', async () => {
    harness.ui.set('podium.flightDeck.folds', writeFolds(new Map([['t2', 'open']]))!)
    await deck()
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

  it('right-clicking a task opens the shared task menu on THAT task', async () => {
    await deck()
    fireEvent.contextMenu(stripOf('t1'))
    expect(await screen.findByText('Set status')).toBeTruthy()
    // The menu's header names the task it will act on, not the mission.
    expect(screen.getByText('Task t1')).toBeTruthy()
  })

  it('reaches top level from a sub-task, naming where it comes out of', async () => {
    await deck()
    fireEvent.contextMenu(stripOf('t4'))
    // t4 hangs under t3, so the placement correction is the one that applies —
    // and it states the OUTCOME, which is the row appearing in the sidebar.
    fireEvent.click(await screen.findByText('Move to top level (out of POD-3)'))
    expect(harness.setPlacement).toHaveBeenCalledWith({
      id: 't4',
      placement: 'own',
      originId: 't3',
    })
  })

  it('gives a proposal the same menu, from its own tail', async () => {
    await deck()
    const proposal = document.querySelector('[data-flight-issue="p1"] button')
    expect(proposal).not.toBeNull()
    fireEvent.contextMenu(proposal as HTMLElement)
    expect(await screen.findByText('Set status')).toBeTruthy()
    expect(screen.getByRole('menuitem', { name: 'Start issue' })).toBeTruthy()
    expect(screen.queryByRole('menuitem', { name: /Run now/ })).toBeNull()
  })

  it('starts a proposed task directly from its Flight Deck menu', async () => {
    await deck()
    const proposal = document.querySelector('[data-flight-issue="p1"] button')
    fireEvent.contextMenu(proposal as HTMLElement)
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Start issue' }))
    expect(harness.startIssue).toHaveBeenCalledWith({ id: 'p1' })
  })

  it('shows the hover affordance for operators who never right-click', async () => {
    await deck()
    expect(screen.getByRole('button', { name: 'Task actions for Task t1' })).toBeTruthy()
  })

  it('uses the shared draft name in the strip and its rename editor', async () => {
    harness.issues = harness.issues.map((candidate) =>
      (candidate as Issue).id === 't1'
        ? { ...(candidate as Issue), title: 'Draft', isDraftVessel: true }
        : candidate,
    )
    harness.sessions = harness.sessions.map((candidate) => {
      const meta = candidate as SessionView
      return meta.sessionId === 's1'
        ? { ...meta, name: undefined, title: 'Unrelated older conversation' }
        : meta
    })
    const view = await deck()
    const strip = stripOf('t1')
    expect(strip.querySelector('.deck-task-content')?.textContent).toContain('New Claude session')

    fireEvent.contextMenu(strip)
    fireEvent.click(screen.getByRole('menuitem', { name: 'Rename' }))
    const editor = strip.querySelector('input')
    expect(editor).not.toBeNull()
    expect((editor as HTMLInputElement).value).toBe('New Claude session')

    // The draft's visible name can move while the uncontrolled editor is open.
    // Its seed and no-op comparison must stay on the title the operator opened.
    harness.sessions = harness.sessions.map((candidate) => {
      const meta = candidate as SessionView
      return meta.sessionId === 's1' ? { ...meta, name: 'Agent renamed while open' } : meta
    })
    view.rerender(<DeckHarness />)
    expect((editor as HTMLInputElement).value).toBe('New Claude session')

    fireEvent.blur(editor as HTMLInputElement)
    expect(harness.updateIssue).not.toHaveBeenCalled()
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
  it('shows a harness icon per session on a folded strip, and no names', async () => {
    await deck()
    // t1 arrives folded (one session, no children). The band itself carries the
    // census and no name — the collapsed agent row stays mounted underneath it,
    // because the fold is a height collapse rather than an unmount.
    const band = strip('t1').querySelector('.deck-strip')
    expect(band?.querySelector('[data-testid="v6-engines"]')).not.toBeNull()
    expect(band?.textContent).not.toContain('s1')
    expect(strip('t2').querySelector('[data-testid="v6-engines"]')).not.toBeNull()
    await act(async () => {
      fireEvent.click(chevron('Task t2'))
    })
    expect(strip('t2').querySelector('[data-testid="v6-engines"]')).toBeNull()
    expect(strip('t2').textContent).toContain('s2')
  })

  // The ref is the handle the operator types and pastes, so the row prints it.
  it('prints a session’s permanent ref on its agent row', async () => {
    harness.sessions = harness.sessions.map((raw) => {
      const meta = raw as SessionView
      return meta.sessionId === 's2' ? { ...meta, displayRef: 'POD-2-A' } : meta
    })
    await deck()
    await act(async () => {
      fireEvent.click(chevron('Task t2'))
    })
    expect(strip('t2').textContent).toContain('POD-2-A')
  })

  it('keeps task identity separate from the metadata that can wrap below it', async () => {
    await deck()
    const band = strip('t1').querySelector('.deck-strip')
    const identity = band?.querySelector('.flight-v6-title')
    const metadata = band?.querySelector('.flight-v6-state')

    expect(identity?.textContent).toContain('Task t1')
    expect(metadata?.getAttribute('data-word')).toBe('idle')
    expect(identity?.parentElement).toBe(metadata?.parentElement)
  })

  it('does not reserve an empty role column for a lone session', async () => {
    await deck()
    await act(async () => {
      fireEvent.click(chevron('Task t1'))
    })
    const row = document.querySelector('[data-flight-session="s1"]')

    expect(row).not.toBeNull()
    expect(row?.querySelector('.deck-agent-role')).toBeNull()
  })

  // Colour in this column is a MARK, never a surface: a task keeps its grey
  // fill in every state and says "selected" with an outline and a gutter tick.
  it('keeps the task fill grey when a strip is selected', async () => {
    await deck()
    const band = strip('t2').querySelector('.deck-strip')
    expect(band?.closest('.flight-v6-card')?.hasAttribute('data-selected')).toBe(false)
    expect(band?.className).not.toContain('issue-mix')
  })

  it('keeps an empty task compact with its shared Idle state and actions', async () => {
    harness.issues.push(issue('t5', { parentId: 'root', stage: 'planning', title: 'Unstaffed' }))
    await deck()
    expect(strip('t5').querySelector('.flight-v6-state')?.textContent).toBe('Idle')
    expect(screen.getByRole('button', { name: 'Task actions for Unstaffed' })).toBeTruthy()
    expect(strip('t5').querySelector('.flight-v6-sessions')).toBeNull()
  })

  it('names the mission coordinator in its own card above the task tree', async () => {
    harness.issues = harness.issues.map((raw) => {
      const candidate = raw as Issue
      return candidate.id === 'root'
        ? { ...candidate, memberSessionIds: ['lead'], coordinatorSessionId: 'lead' }
        : candidate
    })
    harness.sessions = [...harness.sessions, session('lead', { issueId: 'root', name: 'Lead' })]
    await deck()
    const row = document.querySelector('[data-flight-session="lead"]')
    expect(row?.getAttribute('data-seat')).toBe('coordinator')
    expect(row?.querySelector('.flight-full-coordinator-caption')?.textContent).toContain('Coordinator')
    expect(row?.closest('[data-testid="flight-full-coordinator"]')).not.toBeNull()
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
  it('keeps the Full coordinator above the tree without a legacy root rail', async () => {
    withLead()
    await deck()
    const segments = spineSegments()
    expect(segments).toEqual([])
    expect(screen.getByTestId('flight-full-coordinator').closest('.deck-chrome')).not.toBeNull()
  })

  it('leaves the Full tree without a legacy root rail when there is no lead', async () => {
    await deck()
    const segments = spineSegments()
    expect(segments).toEqual([])
  })

  /**
   * THE SPINE STARTS AT THE LIST (POD-1306). The header is padded to 16px, which
   * is ROOT_RAIL itself, so any segment drawn above the list lands UNDER the
   * title and the gauge chip's left border rather than beside them — which is
   * what made the descent read as a stray tick dangling off the chip. The
   * invariant is positional, so it survives without layout: nothing outside the
   * scrolling list may draw a vertical mark at the mission's own rail.
   */
  it('draws no spine above the list — not in the header, not behind the tabs', async () => {
    withLead()
    await deck()
    const rows = document.querySelector('[data-testid="flight-deck-rows"]')
    if (!rows) throw new Error('no rows list')
    const above = spineSegments().filter((el) => !rows.contains(el))
    expect(above).toEqual([])
    expect(document.querySelector('.flight-v6-guides')).not.toBeNull()
  })

  it('keeps session selection inside its inset rather than on the task or tree guide', async () => {
    harness.paneA = 's1'
    harness.ui.set('podium.flightDeck.folds', writeFolds(new Map([['t1', 'open']]))!)
    await deck()
    const row = document.querySelector<HTMLElement>('[data-flight-session="s1"]')!
    expect(row.dataset.selected).toBe('true')
    expect(row.querySelector('.deck-mark-active')).toBeNull()
    expect(row.closest('.flight-v6-card')?.hasAttribute('data-selected')).toBe(false)
  })

  it('marks an asking agent with the shared state inside its inset', async () => {
    harness.sessions = harness.sessions.map((raw) => {
      const meta = raw as SessionView
      return meta.sessionId === 's1'
        ? { ...meta, agentState: { phase: 'needs_user', since: '2026-01-01T00:00:00.000Z' } }
        : meta
    })
    await deck()
    const row = document.querySelector<HTMLElement>('[data-flight-session="s1"]')!
    expect(row.querySelector('[data-word="needs-you"]')?.textContent).toBe('Needs you')
    expect(row.className).not.toContain('inset_2px')
  })

  it('keeps state and permanent reference on each open session row', async () => {
    harness.ui.set(
      'podium.flightDeck.folds',
      writeFolds(
        new Map([
          ['t1', 'open'],
          ['t2', 'open'],
        ]),
      )!,
    )
    await deck()
    for (const row of document.querySelectorAll('[data-flight-session]')) {
      expect(row.querySelector('.flight-v6-state')).not.toBeNull()
      expect(row.querySelector('.flight-v6-ref')).not.toBeNull()
      expect(row.querySelector('.flight-v6-title')).not.toBeNull()
    }
  })

  it('keeps the full agent reading on the row tooltip', async () => {
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
    await deck()
    const button = document
      .querySelector('[data-flight-session="lead"]')
      ?.querySelector('.deck-agent')
    // The tooltip mirrors the complete visible reading and remains useful when
    // a genuinely exceptional value has to wrap in the narrow composition.
    expect(button?.getAttribute('title')).toContain('POD-1-A')
    expect(button?.getAttribute('title')).toContain('Needs you')
    expect(button?.getAttribute('title')).toContain('coordinator')
    expect(button?.querySelector('.flight-full-coordinator-caption')?.textContent).toContain('Coordinator')
  })
})

/**
 * POINTING AT A TAB POINTS AT ITS ROW (POD-1067). The strip and the spine draw
 * the same session, and the link between them is one transient mark on the row
 * — no selection, no scroll, nothing that survives the pointer.
 */
describe('flight deck tab-strip hover link', () => {
  beforeEach(() => {
    harness.ui.set(
      'podium.flightDeck.folds',
      writeFolds(
        new Map([
          ['t1', 'open'],
          ['t2', 'open'],
        ]),
      )!,
    )
  })
  afterEach(() => setHoveredSession(null))
  const row = (id: string) => document.querySelector<HTMLElement>(`[data-flight-session="${id}"]`)!

  it('marks the pointed session and no other', async () => {
    await deck()
    act(() => setHoveredSession('s2'))
    expect(row('s2').dataset.pointed).toBe('true')
    expect(row('s3').dataset.pointed).toBe('false')
    act(() => setHoveredSession(null))
    expect(row('s2').dataset.pointed).toBe('false')
  })

  it('ignores a stale clear from a neighbouring tab', async () => {
    await deck()
    act(() => setHoveredSession('s2'))
    act(() => clearHoveredSession('s3'))
    expect(row('s2').dataset.pointed).toBe('true')
    act(() => clearHoveredSession('s2'))
    expect(row('s2').dataset.pointed).toBe('false')
  })

  it('retains the selected session while another session is pointed', async () => {
    harness.paneA = 's1'
    await deck()
    act(() => setHoveredSession('s2'))
    expect(row('s1').dataset.selected).toBe('true')
    expect(row('s2').dataset.pointed).toBe('true')
    expect(row('s2').dataset.selected).toBe('false')
  })

  it('keeps selection when the pointer lands on the same session', async () => {
    harness.paneA = 's1'
    await deck()
    act(() => setHoveredSession('s1'))
    expect(row('s1').dataset.selected).toBe('true')
    expect(row('s1').dataset.pointed).toBe('true')
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

  it('offers the ghost tree and its advice when nothing is focused', async () => {
    await deck()
    expect(screen.getByTestId('flight-empty')).toBeTruthy()
    expect(screen.getByText('Every agent, in one tree')).toBeTruthy()
  })

  it('keeps the empty deck when the focused session has no task', async () => {
    harness.sessions = [session('loose', { issueId: null })]
    harness.paneA = 'loose'
    await deck()
    expect(screen.getByTestId('flight-empty')).toBeTruthy()
    expect(document.querySelector('[data-flight-session]')).toBeNull()
    expect(screen.queryByTestId('flight-settling')).toBeNull()
  })

  it('keeps unrelated agents out of the deck before any tab is open', async () => {
    harness.sessions = [
      session('plain', { issueId: null, displayRef: 'POD-DRAFT-1' }),
      session('contract', {
        issueId: null,
        displayRef: 'POD-DRAFT-2',
        lastActiveAt: '2026-01-01T00:05:00.000Z',
      }),
    ]
    await deck()
    expect(screen.getByTestId('flight-empty')).toBeTruthy()
    expect(document.querySelector('[data-flight-session]')).toBeNull()
    expect(screen.queryByText('POD-DRAFT-1')).toBeNull()
    expect(screen.queryByText('POD-DRAFT-2')).toBeNull()
  })

  // The composer's spawn paints the vessel and the session together, so the
  // session knows its task before the selection does. That gap is a load.
  it('ghosts, wordlessly, while a spawned session waits for its selection', async () => {
    harness.sessions = [session('fresh', { issueId: 'root' })]
    harness.paneA = 'fresh'
    await deck()
    expect(screen.getByTestId('flight-settling')).toBeTruthy()
    expect(screen.getByTestId('flight-ghost-settling')).toBeTruthy()
    // Nothing to read, because a beat later there is a real tree here.
    expect(screen.queryByText('Every agent, in one tree')).toBeNull()
    expect(screen.getByTestId('flight-settling').textContent).toBe('')
  })

  it('tells a shell what it is instead of promising it an agent', async () => {
    harness.sessions = [session('sh', { agentKind: 'shell', issueId: null })]
    harness.paneA = 'sh'
    await deck()
    expect(screen.getByTestId('flight-shell')).toBeTruthy()
    expect(screen.getByText('A shell joins no task')).toBeTruthy()
    expect(screen.queryByTestId('flight-empty')).toBeNull()
  })

  // A shell that DOES sit in a started worktree (`issue add-shell`) still gets
  // the shell answer rather than the load: it is not waiting for anything.
  it('keeps the shell answer even when the shell carries a task id', async () => {
    harness.sessions = [session('sh', { agentKind: 'shell', issueId: 'root' })]
    harness.paneA = 'sh'
    await deck()
    expect(screen.getByTestId('flight-shell')).toBeTruthy()
    expect(screen.queryByTestId('flight-settling')).toBeNull()
  })
})

describe('Full coordinator and session seats', () => {
  const row = (id: string) => document.querySelector<HTMLElement>(`[data-flight-session="${id}"]`)!
  const button = (id: string) => row(id).querySelector<HTMLButtonElement>('.deck-agent')!
  const selected = () => [...document.querySelectorAll('[data-flight-session][data-selected="true"]')]
    .map(node => node.getAttribute('data-flight-session'))
  const fixtures = () => {
    harness.issues = [
      issue('root', { title: 'Mission', coordinatorSessionId: 'coord' }),
      issue('phase', { parentId: 'root', type: 'phase', title: 'Build', coordinatorSessionId: 'lead' }),
      issue('task', { parentId: 'phase', title: 'Build storage', coordinatorSessionId: 'worker' }),
    ]
    harness.sessions = [
      session('root-helper', { issueId: 'root' }),
      session('phase-helper', { issueId: 'phase' }),
      session('task-helper', { issueId: 'task' }),
      session('coord', { issueId: 'root', displayRef: 'POD-1-C', agentState: WORKING }),
      session('lead', { issueId: 'phase', agentState: WORKING }),
      session('worker', { issueId: 'task', agentState: { phase: 'needs_user' } }),
    ]
  }

  it('selects exactly the focused pane session across coordinator, leads and every helper', async () => {
    fixtures()
    harness.split = true
    harness.paneA = 'coord'
    harness.paneB = 'lead'
    harness.focusedPane = 'B'
    const view = await deck()
    expect(selected()).toEqual(['lead'])
    expect(row('coord').dataset.seat).toBe('coordinator')
    expect(row('lead').dataset.seat).toBe('phase-lead')
    expect(row('worker').dataset.seat).toBe('worker')
    for (const id of ['root-helper', 'phase-helper', 'task-helper']) expect(row(id).dataset.seat).toBe('helper')
    const phase = document.querySelector('[data-phase-lead-slot="phase"]')!
    expect(phase.querySelector('[data-flight-session]')?.getAttribute('data-flight-session')).toBe('lead')
    expect(row('lead').textContent).toContain('phase lead')
    for (const id of ['coord', 'root-helper', 'phase-helper', 'worker', 'task-helper']) {
      harness.paneB = id
      view.rerender(<DeckHarness />)
      expect(selected()).toEqual([id])
    }
    harness.focusedPane = 'A'
    view.rerender(<DeckHarness />)
    expect(selected()).toEqual(['coord'])
    captureSeats('Mission · coordinator focused', view.container)
    harness.focusedPane = 'B'
    harness.paneB = 'file:readme'
    view.rerender(<DeckHarness />)
    expect(selected()).toEqual([])
    expect(document.querySelector('.flight-v6-card[data-selected], .flight-v6-strip[data-selected]')).toBeNull()
    expect(document.querySelectorAll('[data-flight-session]')).toHaveLength(6)
  })

  it('routes click, double click, Enter and Space through the existing conversation handler for all seats', async () => {
    fixtures()
    await deck()
    for (const id of ['coord', 'root-helper', 'lead', 'phase-helper', 'worker', 'task-helper']) {
      fireEvent.click(button(id))
      expect(harness.openSessionTab).toHaveBeenLastCalledWith(id, { permanent: false })
      fireEvent.doubleClick(button(id))
      expect(harness.openSessionTab).toHaveBeenLastCalledWith(id, { permanent: true })
      fireEvent.keyDown(button(id), { key: 'Enter' })
      expect(harness.openSessionTab).toHaveBeenLastCalledWith(id, { permanent: true })
      fireEvent.keyDown(button(id), { key: ' ' })
      expect(harness.openSessionTab).toHaveBeenLastCalledWith(id, { permanent: true })
    }
    expect(harness.openSessionTab).toHaveBeenCalledTimes(24)
    expect(screen.getByRole('button', { name: 'Session actions for coord' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Phase actions for Build' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Task actions for Build storage' })).toBeTruthy()
  })

  it('keeps a simple issue, its pending offer and selected helper stable as child tasks and phases arrive', async () => {
    const offer = { message: 'Approve the design', createdAt: '2026-01-01T00:00:00.000Z', actions: [] }
    harness.issues = [issue('root', { title: 'Sync comparison', coordinatorSessionId: 'coord' })]
    harness.sessions = [session('coord', { issueId: 'root', offer, agentState: { phase: 'idle' } })]
    harness.paneA = 'coord'
    const view = await deck()
    const coordinator = row('coord')
    expect(coordinator.dataset.word).toBe('needs-you')
    expect(coordinator.textContent).toContain('Needs you')
    expect(coordinator.textContent).not.toContain(offer.message)
    expect(selected()).toEqual(['coord'])
    expect(document.querySelector('[data-flight-issue="root"]')).toBeNull()
    captureSeats('Simple issue · pending offer opens in conversation', view.container)
    fireEvent.click(button('coord'))
    expect(harness.openSessionTab).toHaveBeenLastCalledWith('coord', { permanent: false })
    harness.sessions = [...harness.sessions, session('helper', { issueId: 'root', agentState: { phase: 'idle' } })]
    harness.paneA = 'helper'
    harness.issues = [
      ...harness.issues,
      issue('child', { parentId: 'root', title: 'Check sync', stage: 'backlog' }),
      issue('proposal', { parentId: 'root', title: 'Suggested follow-up', stage: 'proposed' }),
    ]
    view.rerender(<DeckHarness />)
    await waitFor(() => expect(row('helper')).not.toBeNull())
    expect(row('coord')).toBe(coordinator)
    expect(selected()).toEqual(['helper'])
    expect(document.querySelector('[data-flight-issue="child"]')).not.toBeNull()
    expect(document.querySelector('[data-flight-issue="root"]')).toBeNull()
    expect(screen.getByTestId('flight-proposed').textContent).toContain('Suggested follow-up')
    expect((harness.sessions[0] as SessionView).offer).toBe(offer)
    captureSeats('Simple issue · helper focused and flat child', view.container)
    harness.issues = [...harness.issues, issue('phase', { parentId: 'root', type: 'phase', title: 'Verify' })]
    view.rerender(<DeckHarness />)
    await waitFor(() => expect(document.querySelector('[data-flight-phase="phase"]')).not.toBeNull())
    expect(row('coord')).toBe(coordinator)
    expect(row('coord').dataset.word).toBe('needs-you')
    expect(selected()).toEqual(['helper'])
    const card = screen.getByTestId('flight-full-coordinator')
    const filters = screen.getByRole('group', { name: 'Task filters' })
    expect(card.compareDocumentPosition(filters) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })

  it('does not assign a coordinator or phase lead from the first or original conversation', async () => {
    harness.issues = [issue('root'), issue('phase', { parentId: 'root', type: 'phase' })]
    harness.sessions = [
      session('original', { issueId: 'root' }),
      session('other', { issueId: 'root' }),
      session('unmarked-lead', { issueId: 'phase' }),
    ]
    harness.paneA = 'other'
    await deck()
    expect(document.querySelector('[data-seat="coordinator"], [data-seat="phase-lead"]')).toBeNull()
    expect(row('original').dataset.seat).toBe('helper')
    expect(row('other').dataset.seat).toBe('helper')
    expect(row('unmarked-lead').dataset.seat).toBe('helper')
    expect(selected()).toEqual(['other'])
    expect(document.querySelector('.flight-full-phase-content')?.getAttribute('data-has-lead')).toBe('false')
  })

  it('keeps the existing empty state with no live sessions and puts stopped sessions in the archive', async () => {
    harness.issues = [issue('root', { coordinatorSessionId: 'stopped' })]
    harness.sessions = [session('stopped', { issueId: 'root', status: 'exited', exitCode: 0, archived: true })]
    await deck()
    expect(screen.queryByTestId('flight-full-coordinator')).toBeNull()
    expect(screen.getByTestId('flight-deck-tail').textContent).toContain('Agent left · choose a handoff')
    expect(screen.getByRole('button', { name: /archived session/i })).toBeTruthy()
  })

  it('gives a focused archived conversation the same selected row as live seats', async () => {
    fixtures()
    harness.sessions = [...harness.sessions, session('archived', { issueId: 'root', archived: true, status: 'exited' })]
    harness.split = true
    harness.paneA = 'coord'
    harness.paneB = 'archived'
    harness.focusedPane = 'B'
    const view = await deck()
    fireEvent.click(screen.getByRole('button', { name: /archived session/i }))
    expect(selected()).toEqual(['archived'])
    expect(row('archived').className).toBe(row('coord').className)
    expect(row('archived').textContent).toContain('Done')
    fireEvent.keyDown(button('archived'), { key: 'Enter' })
    expect(harness.openSessionTab).toHaveBeenLastCalledWith('archived', { permanent: true })
    captureSeats('Archived conversation · focused pane', view.container)
  })
})

// Review evidence comes from the actual rendered acceptance fixtures and the
// source CSS. It is deliberately static: routing is covered hermetically above.
const seatCaptures: { title: string; html: string }[] = []
function captureSeats(title: string, node: HTMLElement) {
  if (process.env['PODIUM_FULL_SEATS_REVIEW_HTML']) seatCaptures.push({ title, html: node.innerHTML })
}
afterAll(() => {
  const path = process.env['PODIUM_FULL_SEATS_REVIEW_HTML']
  if (!path) return
  const css = readFileSync('src/styles.css', 'utf8').split('/* Full flight deck v6.')[1]
  const tokens = readFileSync('src/index.css', 'utf8').split('[data-theme="podium"].dark {')[1]?.split('}')[0]
  writeFileSync(path, `<!doctype html><html lang="en"><meta charset="utf-8"><title>Full coordinator and session seats</title><style>
  :root{${tokens} --font-mono:ui-monospace,monospace;--motion-working:#6f9dff;--motion-total:#848a94}
  *{box-sizing:border-box}body{margin:0;padding:24px;background:#16171a;color:#d7dae0;font:13px system-ui}main{max-width:980px;margin:auto}h1{font-size:18px}h2{font-size:14px;margin-top:28px}p{color:#949aa4;line-height:1.5}button{font:inherit;color:inherit;background:none;border:0;padding:0}svg{flex:none}.size-5{width:20px;height:20px}.size-4{width:16px;height:16px}.flex{display:flex}.flex-none{flex:none}.items-center{align-items:center}.justify-center{justify-content:center}.border{border:1px solid #3a3f48}.rounded{border-radius:4px}.rounded-\\[6px\\]{border-radius:6px}.deck-header{padding:12px}.deck-chrome{background:#1e2025}.deck-chrome>div:not(.deck-header){padding:6px 12px}.deck-header button{margin-right:10px}.deck-rows{padding:8px}.deck-chrome>div>div{display:flex;gap:8px}
  /* Full flight deck v6.${css}
  </style><main><h1>Full coordinator and session seats</h1><p>Actual rendered acceptance fixtures. The focused pane selects one session. The coordinator stays above filters; phase leads sit first inside their phases. Offers open in the conversation. Static captures.</p>${seatCaptures.map(c => `<article><h2>${c.title}</h2>${c.html}</article>`).join('')}</main></html>`)
})

describe('Full phase sections', () => {
  it('puts done restoration above unphased work and phase sections while retaining the tail', async () => {
    harness.issues = [
      issue('root', { title: 'Mission' }),
      issue('phase', { parentId: 'root', type: 'phase', title: 'Build', sortKey: 'a' }),
      issue('work', { parentId: 'phase', title: 'Unfinished work' }),
      issue('done', { parentId: 'phase', title: 'Finished work', stage: 'done', closedAt: '2026-01-01T00:00:00.000Z' }),
      issue('loose', { parentId: 'root', title: 'Loose work', sortKey: 'z' }),
      issue('proposal', { parentId: 'root', title: 'Suggested follow-up', stage: 'proposed' }),
    ]
    harness.sessions = []
    const current = await deck()
    const groups = current.getByTestId('flight-deck-full-groups')
    const order = () => [...groups.querySelectorAll('[data-flight-issue], [data-flight-phase]')]
      .map(node => node.getAttribute('data-flight-issue') ?? node.getAttribute('data-flight-phase'))
    expect(order()).toEqual(['loose', 'phase', 'work'])
    const tail = current.getByTestId('flight-deck-tail')
    expect(tail.textContent).toContain('Suggested follow-up')
    expect(tail.querySelector('[data-flight-issue="proposal"]')).not.toBeNull()
    fireEvent.click(screen.getByRole('button', { name: '1 task done Show' }))
    expect(order()).toEqual(['loose', 'phase', 'done', 'work'])
    expect(harness.closeIssue).not.toHaveBeenCalled()
    expect(harness.updateIssue).not.toHaveBeenCalled()
  })
})
