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
    openIssueId: null,
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
  useSessionGuard: () => ({ guardedKill: vi.fn(), guardedArchive: vi.fn() }),
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
  fixture.sessions = []
  fixture.issues = []
  fixture.paneA = null
})

describe('CommandPalette', () => {
  it('keeps its resting translation neutral after the drop animation', () => {
    const panelRule = styles.match(/\.cmdk-panel\s*\{(?<body>[^}]*)\}/)?.groups?.body

    expect(panelRule).toContain('translate: 0;')
    expect(panelRule).toContain('transform: translateX(-50%);')
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
})
