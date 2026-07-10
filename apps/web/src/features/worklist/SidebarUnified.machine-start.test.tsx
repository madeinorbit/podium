// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SidebarUnified } from './SidebarUnified'

// Optimistic spawn (#119): the sidebar goes through store.spawnDraftAgent, which
// mints client-side ids and paints the row before any server round-trip — the
// component never calls trpc.sessions.create directly anymore.
const spawnDraftAgent = vi.fn(() => ({ sessionId: 'new-session', issueId: 'draft-issue' }))
const settingsGet = vi.fn(async () => ({ sessionDefaults: { agent: 'claude-code' } }))
const settingsSet = vi.fn(async (settings) => settings)
const setSelectedWorktree = vi.fn()
const setSelectedIssueId = vi.fn()
const setPane = vi.fn()
const setView = vi.fn()

vi.mock('@/app/store', () => {
  const useStore = () => ({
    setSearchOpen: vi.fn(),
    // ui-state collection (persisted section collapse etc.) — absent key = default.
    uiState: { get: () => null, set: vi.fn() },
    repos: [
      {
        path: '/home/podium-host/podium',
        kind: 'repository',
        branch: 'main',
        repoId: 'repo_podium',
        machineId: 'podium-host',
        worktrees: [],
      },
      {
        path: '/home/vmi34/podium',
        kind: 'repository',
        branch: 'main',
        repoId: 'repo_podium',
        machineId: 'vmi34',
        worktrees: [],
      },
    ],
    sessions: [
      {
        sessionId: 'recent-vmi',
        agentKind: 'claude-code',
        cwd: '/home/vmi34/podium',
        title: 'recent',
        status: 'live',
        controllerId: null,
        geometry: { cols: 80, rows: 24 },
        epoch: 0,
        clientCount: 0,
        createdAt: '2026-07-06T12:00:00.000Z',
        lastActiveAt: '2026-07-06T12:00:00.000Z',
        origin: { kind: 'spawn' },
        archived: false,
        machineId: 'vmi34',
      },
    ],
    machines: [
      {
        id: 'podium-host',
        name: 'podium-host',
        hostname: 'podium-host',
        online: true,
        lastSeenAt: '2026-07-06T12:00:00.000Z',
      },
      {
        id: 'vmi34',
        name: 'vmi34',
        hostname: 'vmi34',
        online: true,
        lastSeenAt: '2026-07-06T12:00:00.000Z',
      },
    ],
    pins: { panels: [], worktrees: [], repos: [] },
    setPinned: vi.fn(),
    issues: [],
    trpc: {
      settings: { get: { query: settingsGet }, set: { mutate: settingsSet } },
    },
    spawnDraftAgent,
    selectedWorktree: null,
    setSelectedWorktree,
    selectedIssueId: null,
    setSelectedIssueId,
    paneA: null,
    setPane,
    fileTabs: [],
    view: 'workspace',
    setView,
    sidebarSettings: { groupByRepo: false },
    setSidebarSettings: vi.fn(),
  })
  // The selector-store hook (refactor) reads slices off the same store shape.
  return {
    useStore,
    useStoreSelector: (sel: (s: unknown) => unknown) => sel(useStore() as never),
  }
})

vi.mock('@/features/machines/HostIndicators', () => ({ HostIndicators: () => null }))

afterEach(() => {
  cleanup()
  spawnDraftAgent.mockClear()
  settingsGet.mockClear()
  settingsSet.mockClear()
  setSelectedWorktree.mockClear()
  setSelectedIssueId.mockClear()
  setPane.mockClear()
  setView.mockClear()
})

describe('SidebarUnified machine-aware agent start', () => {
  it('starts from the closed New button on the last-used machine that has the repo', async () => {
    render(<SidebarUnified />)

    fireEvent.click(await screen.findByRole('button', { name: /^New Claude in podium$/ }))

    // MRU machine for the repo is vmi34 (the only recent session), so the spawn
    // targets that machine's primary checkout.
    await waitFor(() =>
      expect(spawnDraftAgent).toHaveBeenCalledWith({
        agentKind: 'claude-code',
        target: expect.objectContaining({ path: '/home/vmi34/podium', machineId: 'vmi34' }),
      }),
    )
    expect(setSelectedWorktree).toHaveBeenCalledWith('/home/vmi34/podium')
    expect(setPane).toHaveBeenCalledWith('A', 'new-session')
  })

  it('starts from an agent menu click with the same default repo and machine', async () => {
    render(<SidebarUnified />)

    fireEvent.click(screen.getByRole('button', { name: 'Choose agent and repo' }))
    fireEvent.click(await screen.findByRole('menuitem', { name: 'New Codex' }))

    await waitFor(() =>
      expect(spawnDraftAgent).toHaveBeenCalledWith({
        agentKind: 'codex',
        target: expect.objectContaining({ path: '/home/vmi34/podium', machineId: 'vmi34' }),
      }),
    )
  })
})
