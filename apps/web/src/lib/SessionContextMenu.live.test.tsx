import type { SessionMeta } from '@podium/protocol'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SessionContextMenu } from './SessionContextMenu'

const featureEnabled = vi.hoisted(() => ({ value: true }))
vi.mock('@/lib/use-feature', () => ({
  useFeature: () => featureEnabled.value,
}))

// The store slices the menu reads. Mutated per test before render — the mock
// closes over `state`, so each test sets the world it wants.
const state: {
  repos: unknown[]
  machines: unknown[]
  issues: unknown[]
} = { repos: [], machines: [], issues: [] }

const handoffMutate = vi.fn(async () => ({ ok: true }))

vi.mock('@/app/store', () => {
  const useStore = () => ({
    setPinned: vi.fn(),
    setSnooze: vi.fn(),
    clearSnooze: vi.fn(),
    hibernateSession: vi.fn(),
    resurrectSession: vi.fn(),
    startBtw: vi.fn(),
    markSessionRead: vi.fn(),
    markSessionUnread: vi.fn(),
    trpc: { sessions: { handoff: { mutate: handoffMutate } } },
    repos: state.repos,
    machines: state.machines,
    issues: state.issues,
  })
  return {
    useStore,
    useStoreSelector: (sel: (s: unknown) => unknown) => sel(useStore() as never),
  }
})
vi.mock('@/lib/hooks/use-session-guard', () => ({
  useSessionGuard: () => ({ guardedKill: vi.fn(), guardedArchive: vi.fn() }),
}))

const LUD = 'ludovico'
const MAC = 'mac'
// `reposToViews` derives the worktree list from the wire shape, so the test feeds
// the wire shape the client actually receives rather than a hand-built RepoView.
const repoWire = (machineId: string, path: string, worktrees: string[]) => ({
  path,
  kind: 'repository' as const,
  originUrl: 'git@github.com:madeinorbit/podium.git',
  repoId: 'repo_36de69e6',
  machineId,
  worktrees: worktrees.map((w) => ({ path: w, branch: 'issue/779' })),
})
const machine = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  name: id,
  hostname: id,
  online: true,
  inventory: { agents: [{ kind: 'claude-code', installed: true, login: { state: 'in' } }] },
  ...over,
})

function meta(over: Partial<SessionMeta> = {}): SessionMeta {
  return {
    sessionId: 's',
    agentKind: 'claude-code',
    title: 't',
    cwd: '/Users/mw/Source/other/podium/.worktrees/issue-779',
    machineId: MAC,
    status: 'live',
    controllerId: null,
    geometry: { cols: 80, rows: 24 },
    epoch: 0,
    clientCount: 0,
    createdAt: '2026-07-01T00:00:00.000Z',
    lastActiveAt: '2026-07-17T00:00:00.000Z',
    origin: { kind: 'spawn' },
    archived: false,
    readAt: null,
    unread: false,
    ...over,
  } as SessionMeta
}

function open(session: SessionMeta = meta()): void {
  render(
    <SessionContextMenu
      session={session}
      pinned={false}
      anchor={{ x: 10, y: 10 }}
      onClose={vi.fn()}
      onRename={vi.fn()}
    />,
  )
}

/** The Handoff row, whatever its state, when the feature is enabled (POD-821). */
const handoffItem = (): HTMLElement =>
  screen.getByRole('menuitem', { name: /Handoff/ }) as HTMLElement

afterEach(() => {
  cleanup()
  handoffMutate.mockClear()
  featureEnabled.value = true
  state.repos = []
  state.machines = []
  state.issues = []
})

describe('SessionContextMenu handoff (POD-821)', () => {
  it('hides handoff while the feature is disabled', () => {
    featureEnabled.value = false
    open()
    expect(screen.queryByRole('menuitem', { name: /Handoff/ })).toBeNull()
  })

  it('offers the machine that can take the session, and hands off on click', () => {
    state.repos = [
      repoWire(MAC, '/Users/mw/Source/other/podium', [
        '/Users/mw/Source/other/podium/.worktrees/issue-779',
      ]),
      repoWire(LUD, '/home/mgw/src/other/podium', []),
    ]
    state.machines = [machine(MAC), machine(LUD)]
    open()
    fireEvent.click(handoffItem())
    fireEvent.click(screen.getByRole('menuitem', { name: LUD }))
    expect(handoffMutate).toHaveBeenCalledWith({ sessionId: 's', machineId: LUD })
  })

  it('still shows Handoff — with the reason — when the session cannot move at all', () => {
    // A shell session: no repos needed, the harness alone blocks it.
    open(meta({ agentKind: 'shell' }))
    const item = handoffItem()
    expect(item).toBeTruthy()
    expect((item as HTMLButtonElement).disabled).toBe(true)
    expect(item.textContent).toContain("Shell sessions can't be handed off")
  })

  it("names the reason when the session's cwd is not in a worktree", () => {
    state.repos = [repoWire(MAC, '/Users/mw/Source/other/podium', [])]
    state.machines = [machine(MAC), machine(LUD)]
    open(meta({ cwd: '/Users/mw/Source/other/podium' }))
    expect(handoffItem().textContent).toContain('Only sessions in a worktree can be handed off')
  })

  it('lists an ineligible machine with why it cannot take the session, not as a target', () => {
    state.repos = [
      repoWire(MAC, '/Users/mw/Source/other/podium', [
        '/Users/mw/Source/other/podium/.worktrees/issue-779',
      ]),
      repoWire(LUD, '/home/mgw/src/other/podium', []),
    ]
    state.machines = [machine(MAC), machine(LUD, { online: false })]
    open()
    fireEvent.click(handoffItem())
    const row = screen.getByRole('menuitem', { name: /ludovico/ })
    expect(row.textContent).toContain('offline')
    expect((row as HTMLButtonElement).disabled).toBe(true)
    fireEvent.click(row)
    expect(handoffMutate).not.toHaveBeenCalled()
  })

  it('says so when no other machine has the repo', () => {
    state.repos = [
      repoWire(MAC, '/Users/mw/Source/other/podium', [
        '/Users/mw/Source/other/podium/.worktrees/issue-779',
      ]),
    ]
    state.machines = [machine(MAC)]
    open()
    fireEvent.click(handoffItem())
    expect(screen.getByText('No other machine has this repo')).toBeTruthy()
  })
})
