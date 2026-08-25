// @vitest-environment happy-dom
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import type { SessionMeta, UnbrandIds } from '@podium/model'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { makeIssue } from '@/lib/test-issue'

/**
 * THIS SUITE EXISTS BECAUSE OF THE SETTINGS TDZ (see SettingsView.tsx's own
 * note): a module-scope initialisation order bug there took the WHOLE shell
 * down, typechecked clean, and was invisible to every unit test because none of
 * them imported the module. POD-745 gave the palette three new module-level
 * dependencies — SettingsView's tab list, RepoScanFlow, and RightDock's panel
 * list — so something has to actually MOUNT it.
 *
 * It also pins the grouping the redesign is for: the resting palette must not
 * be a list of agents, and per-kind groups must not share one cap.
 */

const fixture = vi.hoisted(() => ({
  sessions: [] as SessionMeta[],
  issues: [] as ReturnType<typeof makeIssue>[],
  paneA: null as string | null,
  store: {
    trpc: {
      settings: { get: { query: vi.fn(async () => ({})) } },
      issues: { search: { query: vi.fn(async () => []) } },
      sessions: { handoff: { mutate: vi.fn() } },
    },
    repos: [],
    machines: [],
    pins: { issues: [], repos: [], sessions: [] },
    markIssueRead: vi.fn(),
    markIssueUnread: vi.fn(),
    markSessionRead: vi.fn(),
    markSessionUnread: vi.fn(),
    openIssueId: null as string | null,
    setPane: vi.fn(),
    setView: vi.fn(),
    setSettingsTab: vi.fn(),
    setSelectedWorktree: vi.fn(),
    setSelectedIssueId: vi.fn(),
    setOpenIssueId: vi.fn(),
    selectedIssueId: null,
    setSnooze: vi.fn(),
    clearSnooze: vi.fn(),
    hibernateSession: vi.fn(),
    resurrectSession: vi.fn(),
    startBtw: vi.fn(),
    selectedWorktree: null,
    spawnDraftAgent: vi.fn(),
    paletteOpen: true,
    setPaletteOpen: vi.fn(),
    closeIssue: vi.fn(async () => {}),
    deferIssue: vi.fn(async () => {}),
    undeferIssue: vi.fn(async () => {}),
    updateIssue: vi.fn(async () => {}),
    deleteIssue: vi.fn(async () => {}),
    restoreIssue: vi.fn(async () => {}),
    setIssueLabels: vi.fn(async () => {}),
  },
}))

vi.mock('./store', async () => {
  const actual = await vi.importActual<typeof import('./store')>('./store')
  return {
    ...actual,
    useReplicaIssues: () => fixture.issues,
    useSlice: () => ({ sections: { pinnedWorktrees: [], pinnedRepos: [], repos: [] } }),
    useStoreSelector: (selector: (store: unknown) => unknown) =>
      selector({ ...fixture.store, sessions: fixture.sessions, paneA: fixture.paneA }),
  }
})
vi.mock('@/lib/use-feature', () => ({ useFeature: () => false }))
vi.mock('@/lib/hooks/use-session-guard', () => ({
  useSessionGuard: () => ({ guardedDelete: vi.fn(), guardedEnd: vi.fn(), guardedArchive: vi.fn() }),
}))

import { CommandPalette } from './CommandPalette'

const styles = readFileSync(resolve(import.meta.dirname, '../styles.css'), 'utf8')

function makeSession(over: Partial<UnbrandIds<SessionMeta>> & { sessionId: string }): SessionMeta {
  return {
    agentKind: 'claude-code',
    title: 'agent',
    cwd: '/repo/wt',
    status: 'live',
    controllerId: null,
    geometry: { cols: 80, rows: 24 },
    epoch: 1,
    clientCount: 0,
    createdAt: '2026-08-01T00:00:00.000Z',
    lastActiveAt: '2026-08-01T00:00:00.000Z',
    origin: 'user',
    archived: false,
    readAt: null,
    unread: false,
    ...over,
  } as unknown as SessionMeta
}

const groups = (): string[] =>
  screen.getAllByRole('group').map((g) => g.getAttribute('aria-label') ?? '')

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
  fixture.sessions = []
  fixture.issues = []
  fixture.paneA = null
  fixture.store.openIssueId = null
  delete (globalThis as { __PODIUM_DESKTOP__?: unknown }).__PODIUM_DESKTOP__
  delete (globalThis as { __PODIUM_TOGGLE_FLIGHT_DECK__?: unknown }).__PODIUM_TOGGLE_FLIGHT_DECK__
})

describe('CommandPalette', () => {
  it('uses an untransformed viewport stage to center the card', () => {
    render(<CommandPalette />)
    const stage = screen.getByLabelText('Command palette')
    const stageRule = styles.match(/\.cmdk-panel\s*\{(?<body>[^}]*)\}/)?.groups?.body
    const drop = styles.match(/@keyframes cmdk-drop\s*\{(?<body>[\s\S]*?)\n\}/)?.groups?.body

    expect(stage.classList).toContain('inset-0')
    expect(stage.classList).not.toContain('left-1/2')
    expect(stage.classList).not.toContain('-translate-x-1/2')
    expect(stage.classList).not.toContain('data-open:animate-in')
    expect(stageRule).toContain('align-items: center;')
    expect(styles).toContain('.cmdk-surface')
    // The drop may translate the card, never the stage that places it.
    expect(drop).toContain('translateY(-9px)')
    expect(drop).not.toContain('translateX(-50%)')
  })

  it('mounts — every module it pulls in initialises', () => {
    render(<CommandPalette />)
    expect(screen.getByLabelText('Command palette')).toBeTruthy()
    expect(screen.getByRole('combobox')).toBeTruthy()
  })

  it('rests on Recent and Actions, not on a list of agents', () => {
    fixture.sessions = [
      makeSession({ sessionId: 's1', name: 'older agent', lastActiveAt: '2026-08-01T00:00:00Z' }),
      makeSession({ sessionId: 's2', name: 'newer agent', lastActiveAt: '2026-08-09T00:00:00Z' }),
    ]
    fixture.issues = [makeIssue({ id: 'i1', title: 'Merge lock lease expiry' })]
    render(<CommandPalette />)

    expect(groups()).toEqual(['Recent', 'Actions'])
    // The raw indexes are answers to a query and are not offered before one.
    expect(groups()).not.toContain('Agents')
    expect(groups()).not.toContain('Tasks')

    const recent = screen.getByRole('group', { name: 'Recent' })
    const rows = within(recent).getAllByRole('option')
    // Most recently active first, and tasks share the group with agents.
    expect(rows[0]?.textContent).toContain('newer agent')
    expect(rows.some((r) => r.textContent?.includes('Merge lock lease expiry'))).toBe(true)
  })

  it('splits a query across per-kind groups so one kind cannot take the list', () => {
    fixture.sessions = [makeSession({ sessionId: 's1', name: 'login agent' })]
    fixture.issues = [
      makeIssue({ id: 'i1', title: 'login page polish' }),
      makeIssue({ id: 'i2', title: 'fix login bug' }),
    ]
    render(<CommandPalette />)
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'login' } })

    const labels = groups()
    expect(labels).toContain('Tasks')
    expect(labels).toContain('Agents')
    expect(labels).not.toContain('Recent')
  })

  it('marks exactly one row as the thing Enter will run', () => {
    fixture.issues = [makeIssue({ id: 'i1', title: 'Merge lock lease expiry' })]
    render(<CommandPalette />)
    const selected = screen
      .getAllByRole('option')
      .filter((o) => o.getAttribute('aria-selected') === 'true')
    expect(selected).toHaveLength(1)
    expect(selected[0]?.dataset.active).toBe('true')
  })

  it('teaches its own keys in the footer, and what Escape does right now', () => {
    render(<CommandPalette />)
    expect(screen.getByText('close')).toBeTruthy()
    expect(screen.getByText('run')).toBeTruthy()
  })

  /**
   * POD-1114. Closing from the palette used to be the ONE route that skipped
   * the guard: the same pick from the right-click menu or the issue page showed
   * what was still unresolved first. The dialog has to survive the palette
   * closing on execute, which is why it is a sibling of it and not inside it.
   */
  it('raises the close guard instead of closing the task outright', () => {
    fixture.issues = [
      makeIssue({ id: 'i1', title: 'Merge lock lease expiry', childCount: 3, childDoneCount: 1 }),
    ]
    fixture.store.openIssueId = 'i1'
    render(<CommandPalette />)
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'set status done' } })

    const row = screen
      .getAllByRole('option')
      .find((option) => option.textContent?.includes('Set status · Done'))
    if (!row) throw new Error('expected a status close row on the task')
    fireEvent.click(row)

    // Nothing has closed yet — the dialog is standing where the close was.
    expect(fixture.store.closeIssue).not.toHaveBeenCalled()
    expect(screen.getByText('This issue still needs attention')).toBeTruthy()
    expect(within(screen.getByTestId('issue-close-concerns')).getByText('2 open sub-tasks'))

    fireEvent.click(screen.getByRole('button', { name: 'Close anyway' }))
    expect(fixture.store.closeIssue).toHaveBeenCalledWith('i1', 'done')
  })

  // POD-1278: the guard is raised only when it has something to list. On a tidy
  // task the row behaves like every other palette command — it runs.
  it('closes a tidy task on the row press, with no guard in between', () => {
    fixture.issues = [makeIssue({ id: 'i1', title: 'Merge lock lease expiry' })]
    fixture.store.openIssueId = 'i1'
    render(<CommandPalette />)
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'set status done' } })

    const row = screen
      .getAllByRole('option')
      .find((option) => option.textContent?.includes('Set status · Done'))
    if (!row) throw new Error('expected a status close row on the task')
    fireEvent.click(row)

    expect(fixture.store.closeIssue).toHaveBeenCalledWith('i1', 'done')
    expect(screen.queryByTestId('issue-close-concerns')).toBeNull()
    expect(screen.queryByText('Close this issue?')).toBeNull()
  })
})

// THE SHELL'S OWN COMMANDS (POD-1532). Off macOS there is no menu bar, so
// search is the ONLY place `Toggle Flight Deck` and its siblings are
// discoverable — and the chord it names has to be the one that machine answers.
describe('the shell commands', () => {
  const g = globalThis as {
    __PODIUM_DESKTOP__?: { platform: string }
    __PODIUM_TOGGLE_FLIGHT_DECK__?: () => void
  }

  function findFlightDeck(): HTMLElement | undefined {
    return screen
      .queryAllByRole('option')
      .find((row) => row.textContent?.includes('Toggle Flight Deck'))
  }

  it("offers a bound command, wearing this platform's spelling of its chord", () => {
    g.__PODIUM_DESKTOP__ = { platform: 'linux' }
    const toggle = vi.fn()
    g.__PODIUM_TOGGLE_FLIGHT_DECK__ = toggle
    render(<CommandPalette />)
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'flight deck' } })

    const row = findFlightDeck()
    expect(row?.textContent).toContain('Ctrl+Alt+F')
    fireEvent.click(row as HTMLElement)
    expect(toggle).toHaveBeenCalledOnce()
  })

  it('names the macOS chord on the macOS shell', () => {
    g.__PODIUM_DESKTOP__ = { platform: 'macos' }
    g.__PODIUM_TOGGLE_FLIGHT_DECK__ = vi.fn()
    render(<CommandPalette />)
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'flight deck' } })
    expect(findFlightDeck()?.textContent).toContain('⌥⌘F')
  })

  // A row that does nothing when you pick it is worse than no row.
  it('leaves out a command nothing is answering', () => {
    g.__PODIUM_DESKTOP__ = { platform: 'linux' }
    render(<CommandPalette />)
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'flight deck' } })
    expect(findFlightDeck()).toBeUndefined()
  })
})
