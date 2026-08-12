// @vitest-environment happy-dom
import type { SessionMeta } from '@podium/model'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { defaultFolded, FlightDeck, isFolded, readFolds, writeFolds } from './FlightDeck'
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
  ui: new Map<string, string>(),
  listeners: new Set<() => void>(),
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
      openSessionTab: harness.openSessionTab,
      setPanelMode: harness.setPanelMode,
      setView: vi.fn(),
      markIssueRead: vi.fn(async () => undefined),
      markSessionRead: vi.fn(async () => undefined),
      renameSession: vi.fn(async () => undefined),
    }),
  useReplicaIssues: () => harness.issues,
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
