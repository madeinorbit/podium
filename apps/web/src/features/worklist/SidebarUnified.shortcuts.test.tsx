// @vitest-environment happy-dom
import { cleanup, fireEvent, render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SidebarUnified } from './SidebarUnified'

// ⌘-hold row shortcuts (POD-790): hold Command and every task in the column
// wears the digit that jumps to it. macOS SHELL only — in a browser tab ⌘1…⌘9
// belong to the browser's tab strip and never reach the page.

const ui = vi.hoisted(() => {
  const rows = new Map<string, string>()
  const listeners = new Set<() => void>()
  return {
    get: (key: string): string | null => rows.get(key) ?? null,
    set: (key: string, value: string | null): void => {
      if (value === null) rows.delete(key)
      else rows.set(key, value)
      for (const listener of listeners) listener()
    },
    subscribe: (callback: () => void): (() => void) => {
      listeners.add(callback)
      return () => {
        listeners.delete(callback)
      }
    },
    reset: (): void => rows.clear(),
  }
})

const setSelectedIssueId = vi.hoisted(() => vi.fn())
const spawnDraftAgent = vi.hoisted(() => vi.fn(() => ({ sessionId: 's-new', issueId: 'i-new' })))

function idleSess(id: string, issueId: string) {
  return {
    sessionId: id,
    agentKind: 'claude-code',
    cwd: '/repo',
    title: id,
    status: 'live',
    controllerId: null,
    geometry: { cols: 80, rows: 24 },
    epoch: 0,
    clientCount: 0,
    createdAt: '2026-07-06T12:00:00.000Z',
    lastActiveAt: '2026-07-06T12:00:00.000Z',
    origin: { kind: 'spawn' },
    archived: false,
    issueId,
    busy: false,
    readAt: '2026-07-06T12:00:00.000Z',
    unread: false,
    agentState: { phase: 'idle', idle: { kind: 'done' } },
  }
}

function issue(id: string, title: string, over: Record<string, unknown> = {}) {
  return {
    id,
    repoPath: '/repo',
    seq: 1,
    title,
    description: '',
    stage: 'in_progress',
    worktreePath: null,
    branch: null,
    parentBranch: 'main',
    defaultAgent: 'claude-code',
    blockedByNotes: [],
    createdAt: '2026-06-01T00:00:00.000Z',
    updatedAt: '2026-06-20T00:00:00.000Z',
    archived: false,
    needsHuman: false,
    sessions: [],
    sessionSummary: { total: 0, byPhase: {} },
    origin: 'human',
    audience: 'human',
    draft: false,
    childCount: 0,
    childDoneCount: 0,
    priority: 2,
    type: 'task',
    pinned: false,
    labels: [],
    deps: [],
    dependents: [],
    comments: [],
    ready: true,
    blocked: false,
    deferred: false,
    readAt: '2026-06-20T00:00:00.000Z',
    unread: false,
    ...over,
  }
}

vi.mock('@/app/store', () => {
  const useStore = () => ({
    repos: [{ path: '/repo', kind: 'repository', branch: 'main', worktrees: [] }],
    sessions: [idleSess('s-a', 'a'), idleSess('s-b', 'b'), idleSess('s-c', 'c')],
    machines: [],
    pins: { panels: [], worktrees: [], repos: [] },
    setPinned: vi.fn(),
    issues: [issue('a', 'Alpha'), issue('b', 'Beta'), issue('c', 'Gamma')],
    trpc: {
      settings: {
        get: { query: vi.fn(async () => ({ sessionDefaults: { agent: 'claude-code' } })) },
      },
      issues: { defer: { mutate: vi.fn(async () => ({})) } },
    },
    selectedWorktree: null,
    setSelectedWorktree: vi.fn(),
    selectedIssueId: null,
    setSelectedIssueId,
    setOpenIssueId: vi.fn(),
    paneA: null,
    setPane: vi.fn(),
    fileTabs: [],
    view: 'workspace',
    setView: vi.fn(),
    sidebarSettings: { groupByRepo: false },
    setSidebarSettings: vi.fn(),
    uiState: ui,
    spawnDraftAgent,
    markIssueRead: vi.fn(),
    markSessionRead: vi.fn(),
  })
  return {
    useStore,
    useReplicaIssues: () => useStore().issues,
    useStoreSelector: (sel: (s: unknown) => unknown) => sel(useStore() as never),
    useSlice: (def: { derive: (s: unknown) => unknown }) =>
      def.derive({ ...(useStore() as object), coarseNow: Date.now() } as never),
  }
})

vi.mock('@/features/machines/HostIndicators', () => ({ HostIndicators: () => null }))
vi.mock('@/lib/hooks/use-session-guard', () => ({
  useSessionGuard: () => ({ guardedDelete: vi.fn(), guardedEnd: vi.fn(), guardedArchive: vi.fn() }),
}))

/** Issue ids in the order the column draws them (`data-issue-row` on each row). */
function renderedIssueIds(): string[] {
  return [...document.querySelectorAll('[data-issue-row]')].map(
    (el) => el.getAttribute('data-issue-row') ?? '',
  )
}

/** The digit each drawn row is wearing, in the same order. */
function renderedDigits(): (string | null)[] {
  return [...document.querySelectorAll('[data-issue-row]')].map(
    (row) =>
      row.querySelector('[data-shortcut-digit]')?.getAttribute('data-shortcut-digit') ?? null,
  )
}

function holdCommand(): void {
  fireEvent.keyDown(window, { key: 'Meta', code: 'MetaLeft', metaKey: true })
}

function pressCommandDigit(digit: number): void {
  fireEvent.keyDown(window, {
    key: String(digit),
    code: `Digit${digit}`,
    metaKey: true,
  })
}

function macShell(): void {
  ;(globalThis as { __PODIUM_DESKTOP__?: unknown }).__PODIUM_DESKTOP__ = { platform: 'macos' }
}

beforeEach(() => {
  delete (globalThis as { __PODIUM_DESKTOP__?: unknown }).__PODIUM_DESKTOP__
})

afterEach(() => {
  cleanup()
  ui.reset()
  setSelectedIssueId.mockClear()
  spawnDraftAgent.mockClear()
  delete (globalThis as { __PODIUM_DESKTOP__?: unknown }).__PODIUM_DESKTOP__
})

function newAgentCommand(): (() => void) | undefined {
  return (globalThis as { __PODIUM_NEW_AGENT__?: () => void }).__PODIUM_NEW_AGENT__
}

// POD-1469: the chord still arrives the same two ways, and it no longer spawns.
// A new task is a BLANK mission — the selection is cleared and the composer asks
// for the work before any harness exists — so what this asserts is the clear,
// and that nothing is spawned behind the operator's back.
describe('⌘N — the shell menu’s New Task (POD-790, POD-1469)', () => {
  it('hands the desktop shell a command that opens a new task', () => {
    macShell()
    render(<SidebarUnified />)
    // The shell evaluates exactly this global on File > New Agent
    // (apps/desktop/src-tauri/src/main.rs).
    expect(typeof newAgentCommand()).toBe('function')
    newAgentCommand()?.()
    expect(setSelectedIssueId).toHaveBeenCalledWith(null)
    expect(spawnDraftAgent).not.toHaveBeenCalled()
  })

  it('opens a new task from a ⌘N that actually reaches the page', () => {
    macShell()
    render(<SidebarUnified />)
    fireEvent.keyDown(window, { key: 'n', code: 'KeyN', metaKey: true })
    expect(setSelectedIssueId).toHaveBeenCalledWith(null)
    expect(spawnDraftAgent).not.toHaveBeenCalled()
  })

  it('registers nothing in a browser tab, which never surrenders ⌘N', () => {
    render(<SidebarUnified />)
    expect(newAgentCommand()).toBeUndefined()
    fireEvent.keyDown(window, { key: 'n', code: 'KeyN', metaKey: true })
    expect(setSelectedIssueId).not.toHaveBeenCalled()
  })

  it('takes the command back down with the sidebar', () => {
    macShell()
    render(<SidebarUnified />)
    cleanup()
    expect(newAgentCommand()).toBeUndefined()
  })
})

describe('⌘-hold row shortcuts (POD-790)', () => {
  it('numbers the column from 1, in drawn order, only while Command is down', () => {
    macShell()
    render(<SidebarUnified />)
    expect(renderedDigits().every((digit) => digit === null)).toBe(true)

    holdCommand()
    expect(renderedDigits()).toEqual(['1', '2', '3'])

    fireEvent.keyUp(window, { key: 'Meta', code: 'MetaLeft', metaKey: false })
    expect(renderedDigits().every((digit) => digit === null)).toBe(true)
  })

  it('⌘n selects the nth drawn row', () => {
    macShell()
    render(<SidebarUnified />)
    const second = renderedIssueIds()[1]
    pressCommandDigit(2)
    expect(setSelectedIssueId).toHaveBeenCalledWith(second)
  })

  it('leaves ⌘n alone past the end of the column', () => {
    macShell()
    render(<SidebarUnified />)
    pressCommandDigit(7) // three rows
    expect(setSelectedIssueId).not.toHaveBeenCalled()
  })

  it('does not claim the chord in a browser tab, where ⌘n switches tabs', () => {
    render(<SidebarUnified />) // no __PODIUM_DESKTOP__
    holdCommand()
    expect(renderedDigits().every((digit) => digit === null)).toBe(true)
    pressCommandDigit(1)
    expect(setSelectedIssueId).not.toHaveBeenCalled()
  })

  it('drops the hold when the window loses focus, so ⌘Tab does not leave digits up', () => {
    macShell()
    render(<SidebarUnified />)
    holdCommand()
    expect(renderedDigits()).toEqual(['1', '2', '3'])
    fireEvent.blur(window)
    expect(renderedDigits().every((digit) => digit === null)).toBe(true)
  })
})
