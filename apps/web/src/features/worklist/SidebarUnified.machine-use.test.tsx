// @vitest-environment happy-dom
/**
 * MACHINE `use` IN THE SPAWN SURFACE (POD-407, readiness §3.1.4 M5).
 *
 * The sister file `SidebarUnified.machine-start.test.tsx` is the PARITY half: its
 * machines carry no `use` field at all, so the list reads as unscoped and every
 * machine stays offerable — that is the single-user regression guard, and it must
 * keep passing unchanged.
 *
 * This file is the SCOPED half. The moment any machine in the list carries a `use`
 * decision the server is answering the question, and the sidebar must:
 *   1. never resolve a default spawn onto a machine the principal cannot use —
 *      not even when it is the most-recently-used one, which is exactly the
 *      "silently retargeted" case M5 forbids;
 *   2. render UNAUTHORIZED and UNREACHABLE as visibly different things, because
 *      they need opposite responses (ask the owner vs wake the host);
 *   3. refuse a click on either.
 *
 * The MRU session below sits on the DENIED machine on purpose. Under the old
 * `resolveTargetMachine` (online-only) that machine wins the default pick, so
 * assertion 1 fails loudly if the gate is ever removed — the test can distinguish
 * the fix from its absence rather than merely passing.
 */
import { asSessionId } from '@podium/model'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SidebarUnified } from './SidebarUnified'

/** Typed on its ARGUMENT so the assertions below can read the spawn target back
 *  off `mock.calls` — an untyped `vi.fn()` infers an empty call tuple. */
const spawnDraftAgent = vi.fn((_input: { agentKind: string; target: { machineId?: string } }) => ({
  sessionId: asSessionId('new-session'),
  issueId: 'draft-issue',
}))
const settingsGet = vi.fn(async () => ({ sessionDefaults: { agent: 'claude-code' } }))
const settingsSet = vi.fn(async (settings: unknown) => settings)

vi.mock('@/app/store', () => {
  const useStore = () => ({
    uiState: { get: () => null, set: vi.fn(), subscribe: () => () => {} },
    repos: [
      {
        path: '/home/mine/podium',
        kind: 'repository',
        branch: 'main',
        repoId: 'repo_podium',
        machineId: 'mine',
        worktrees: [],
      },
      {
        path: '/home/theirs/podium',
        kind: 'repository',
        branch: 'main',
        repoId: 'repo_podium',
        machineId: 'theirs',
        worktrees: [],
      },
      {
        path: '/home/asleep/podium',
        kind: 'repository',
        branch: 'main',
        repoId: 'repo_podium',
        machineId: 'asleep',
        worktrees: [],
      },
    ],
    sessions: [
      {
        // MOST RECENT, and on the machine we may NOT use. The gate has to beat
        // recency, or the default spawn lands on someone else's hardware.
        sessionId: asSessionId('recent-on-theirs'),
        agentKind: 'claude-code',
        cwd: '/home/theirs/podium',
        title: 'recent',
        status: 'live',
        controllerId: null,
        geometry: { cols: 80, rows: 24 },
        epoch: 0,
        clientCount: 0,
        createdAt: '2026-08-01T12:00:00.000Z',
        lastActiveAt: '2026-08-01T12:00:00.000Z',
        origin: { kind: 'spawn' },
        archived: false,
        machineId: 'theirs',
      },
    ],
    machines: [
      {
        id: 'mine',
        name: 'mine',
        hostname: 'mine',
        online: true,
        lastSeenAt: '2026-08-01T12:00:00.000Z',
        use: 'granted',
      },
      {
        id: 'theirs',
        name: 'theirs',
        hostname: 'theirs',
        online: true,
        lastSeenAt: '2026-08-01T12:00:00.000Z',
        use: 'denied',
      },
      {
        id: 'asleep',
        name: 'asleep',
        hostname: 'asleep',
        online: false,
        lastSeenAt: '2026-08-01T12:00:00.000Z',
        use: 'granted',
      },
    ],
    pins: { panels: [], worktrees: [], repos: [] },
    setPinned: vi.fn(),
    issues: [],
    trpc: { settings: { get: { query: settingsGet }, set: { mutate: settingsSet } } },
    spawnDraftAgent,
    selectedWorktree: null,
    setSelectedWorktree: vi.fn(),
    selectedIssueId: null,
    setSelectedIssueId: vi.fn(),
    paneA: null,
    setPane: vi.fn(),
    fileTabs: [],
    view: 'workspace',
    setView: vi.fn(),
    sidebarSettings: { groupByRepo: false },
    setSidebarSettings: vi.fn(),
  })
  return {
    useStore,
    useReplicaIssues: () => (useStore() as unknown as { issues?: unknown[] }).issues ?? [],
    useStoreSelector: (sel: (s: unknown) => unknown) => sel(useStore() as never),
    useSlice: (def: { derive: (s: unknown) => unknown }) =>
      def.derive({ ...(useStore() as object), coarseNow: Date.now() } as never),
  }
})

vi.mock('@/features/machines/HostIndicators', () => ({ HostIndicators: () => null }))
vi.mock('@/lib/hooks/use-session-guard', () => ({
  useSessionGuard: () => ({ guardedKill: vi.fn(), guardedArchive: vi.fn() }),
}))

afterEach(() => {
  cleanup()
  spawnDraftAgent.mockClear()
})

/**
 * Open agent menu → the repo submenu, and hand back the machine rows.
 *
 * Both sub-TRIGGERS (the agent kind, then the repo) spawn on click as well as
 * opening their submenu — that is the row's long-standing "click the label to
 * take the default" behaviour, not something this port introduced. Navigating to
 * the machine list therefore fires real spawns, so the counter is reset before
 * the caller asserts on it; otherwise every assertion here would be measuring the
 * navigation rather than the click under test.
 */
async function openMachineRows(): Promise<HTMLElement[]> {
  fireEvent.click(screen.getByRole('button', { name: 'Choose agent and repo' }))
  fireEvent.click(await screen.findByRole('menuitem', { name: 'New Claude' }))
  fireEvent.click(await screen.findByRole('menuitem', { name: 'podium' }))
  const rows = await screen.findAllByTestId('new-agent-machine')
  spawnDraftAgent.mockClear()
  return rows
}

describe('new-agent submenu — use is a code-execution boundary', () => {
  it('never defaults the spawn onto a machine the principal cannot use, even when it is the MRU one', async () => {
    render(<SidebarUnified />)

    fireEvent.click(await screen.findByRole('button', { name: /^New Claude in podium$/ }))

    await waitFor(() => expect(spawnDraftAgent).toHaveBeenCalled())
    const machineId = spawnDraftAgent.mock.calls[0]?.[0].target.machineId
    expect(machineId).not.toBe('theirs')
    expect(machineId).toBe('mine')
  })

  it('distinguishes unauthorized from unreachable rather than collapsing both to "unavailable"', async () => {
    render(<SidebarUnified />)
    const rows = await openMachineRows()

    const byName = new Map(
      rows.map((row) => [row.textContent?.replace(/no access|offline/, '').trim(), row]),
    )
    expect(byName.get('theirs')?.getAttribute('data-availability')).toBe('unauthorized')
    expect(byName.get('asleep')?.getAttribute('data-availability')).toBe('unreachable')
    expect(byName.get('mine')?.getAttribute('data-availability')).toBe('available')

    // The distinction has to be READABLE, not merely present in a data attribute.
    expect(byName.get('theirs')?.textContent).toContain('no access')
    expect(byName.get('asleep')?.textContent).toContain('offline')
  })

  it('refuses a click on an unauthorized machine', async () => {
    render(<SidebarUnified />)
    const rows = await openMachineRows()
    const denied = rows.find((row) => row.textContent?.includes('no access'))
    expect(denied).toBeDefined()

    fireEvent.click(denied as HTMLElement)

    expect(spawnDraftAgent).not.toHaveBeenCalled()
  })
})
