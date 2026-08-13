// @vitest-environment happy-dom
import type { SessionMeta } from '@podium/model'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  deckTaskUnread,
  defaultFolded,
  FlightDeck,
  isFolded,
  readFolds,
  writeFolds,
} from './FlightDeck'
import { OperatorFocusProvider } from './operator-focus'

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
  openSessionTab: vi.fn(),
  setPanelMode: vi.fn(),
  setSelectedIssueId: vi.fn(),
  setIssueTucked: vi.fn(async () => undefined),
  ui: new Map<string, string>(),
  listeners: new Set<() => void>(),
  setPlacement: vi.fn(async (_input: unknown) => undefined),
  startIssue: vi.fn(async (_input: unknown) => undefined),
  trpc: {
    features: { state: { query: async () => null } },
    issues: {
      setPlacement: { mutate: (input: unknown) => harness.setPlacement(input) },
      start: { mutate: (input: unknown) => harness.startIssue(input) },
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
      repos: [],
      selectedIssueId: 'root',
      paneA: null,
      paneB: null,
      split: false,
      drafts: {},
      coarseNow: Date.parse('2026-01-01T00:10:00.000Z'),
      uiState,
      setSelectedWorktree: vi.fn(),
      setSelectedIssueId: harness.setSelectedIssueId,
      openSessionTab: harness.openSessionTab,
      setPanelMode: harness.setPanelMode,
      setView: vi.fn(),
      markIssueRead: vi.fn(async () => undefined),
      markIssueUnread: vi.fn(async () => undefined),
      updateIssue: vi.fn(async () => undefined),
      deleteIssue: vi.fn(async () => undefined),
      closeIssue: vi.fn(async () => undefined),
      deferIssue: vi.fn(async () => undefined),
      undeferIssue: vi.fn(async () => undefined),
      setIssueLabels: vi.fn(async () => undefined),
      setIssuePlacement: (id: string, placement: string, originId: string) =>
        harness.setPlacement({ id, placement, originId }),
      restoreIssue: vi.fn(async () => undefined),
      markSessionRead: vi.fn(async () => undefined),
      setIssueTucked: harness.setIssueTucked,
      renameSession: vi.fn(async () => undefined),
      // The shared task menu reads these; the deck itself never does.
      machines: [],
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

const deck = (): void => {
  render(
    <OperatorFocusProvider missionId="root">
      <FlightDeck onCollapse={vi.fn()} />
    </OperatorFocusProvider>,
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
  harness.openSessionTab.mockClear()
  harness.setPanelMode.mockClear()
  harness.setSelectedIssueId.mockClear()
  harness.setIssueTucked.mockClear()
  harness.startIssue.mockClear()
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

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

const chevron = (title: string): HTMLElement =>
  screen.getByRole('button', { name: new RegExp(`^(Expand|Collapse) ${title}$`) })

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
      issue: { id: 't1', readAt: '2026-01-01T00:10:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' },
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
      issue: { id: 't3', readAt: '2026-01-01T00:10:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' },
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

  it('reopens the Task dock when an issue is picked', () => {
    const openPanel = vi.fn()
    window.addEventListener('podium:open-right-panel', openPanel, { once: true })
    deck()

    fireEvent.click(taskRow('t2'))
    settle()

    expect(openPanel).toHaveBeenCalledTimes(1)
    expect((openPanel.mock.calls[0]?.[0] as CustomEvent).detail).toBe('issue')
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
    expect(screen.getByText('Left this mission')).toBeTruthy()
    expect(screen.getByTestId('flight-departure').textContent).toContain('POD-963')

    fireEvent.click(screen.getByRole('button', { name: 'Open POD-963' }))
    expect(harness.setSelectedIssueId).toHaveBeenCalledWith('tip')
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
    expect(screen.getByText('Set stage')).toBeTruthy()
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
    expect(screen.getByText('Set stage')).toBeTruthy()
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
