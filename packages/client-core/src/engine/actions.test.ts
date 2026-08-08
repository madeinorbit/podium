import { asIssueId, asSessionId } from '@podium/model'
import { describe, expect, it, vi } from 'vitest'
import type { PodiumClientApi } from '../api'
import type { OutboxEntry } from '../outbox'
import type { SocketHub } from '../socket-transport'
import type { Router } from '../ui-state'
import {
  COMMAND_ACTIONS,
  createEngineActions,
  type EngineActionRuntime,
  UI_LOCAL_ACTIONS,
} from './actions'
import type { StoreNotices } from './types'
import type { EngineOutbox, OutboxKinds } from './wiring'

const sessionId = asSessionId('session-1')

/** Attribution is transport-derived; payload identity is inert (ADR 3 D7,
 *  multi-user-readiness 3.1.3 A3). Each name is refused INDIVIDUALLY. */
const ATTRIBUTION_FIELDS = ['actor', 'owner', 'ownerId', 'origin'] as const

function nestedKeys(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(nestedKeys)
  if (value === null || typeof value !== 'object') return []
  return Object.entries(value).flatMap(([key, nested]) => [key, ...nestedKeys(nested)])
}

function harness() {
  const queued: { kind: keyof OutboxKinds; input: unknown }[] = []
  const pending: OutboxEntry[] = []
  const awaiting: OutboxEntry[] = []
  const errors: string[] = []
  const navigated: unknown[] = []
  let state = {
    pins: { panels: [], worktrees: [], repos: [] },
    tabOrders: {},
    sessions: [],
    issues: [],
    repos: [],
    peekIssueId: null,
    superThreadId: 'global',
    superOpen: false,
    dockTab: 'chat' as const,
    superThreads: [],
    paletteOpen: false,
    selectedWorktree: null,
    selectedIssueId: null,
    paneA: null,
    paneB: null,
    split: false,
    focusedPane: 'A' as const,
    panelMode: {},
    dockShells: {},
    dockVisibleSession: null,
    autoContinuePromptSessionId: null,
    sidebarSettings: { repoSort: 'lastUsed' as const, repoOrder: [], groupByRepo: false },
    fileTabs: [],
    recentFiles: [],
  }
  const enqueue = vi.fn(async (kind: keyof OutboxKinds, input: unknown) => {
    queued.push({ kind, input })
    const entry = {
      mutationId: `m-${queued.length}`,
      kind,
      input,
      queuedAt: queued.length,
    }
    pending.push(entry)
    return entry
  })
  const refreshSuperThreads = vi.fn(async () => {})
  const router = {
    current: () => ({
      view: 'tasks',
      settingsTab: null,
      issueId: null,
      worktree: null,
      pane: null,
    }),
    navigate: (route: unknown) => navigated.push(route),
  } as unknown as Router
  const runtime = {
    api: {
      layout: { get: { query: async () => ({}) } },
      superagent: { startBtw: { mutate: vi.fn(async () => ({})) } },
    } as unknown as PodiumClientApi,
    hub: {} as SocketHub,
    outbox: {
      enqueue,
      pending: () => pending,
      awaiting: () => awaiting,
      retireAwaiting: vi.fn(),
    } as unknown as EngineOutbox,
    router,
    notices: { error: (message: string) => errors.push(message), info: vi.fn() } as StoreNotices,
    state: () => state,
    apply: (patch: Partial<typeof state>) => {
      state = { ...state, ...patch }
    },
    enqueueOverlayed: (kind: keyof OutboxKinds, input: unknown) => queued.push({ kind, input }),
    revealFileTab: vi.fn(),
    recordRecentFile: vi.fn(),
    spawnDraftAgent: vi.fn(() => ({ sessionId, issueId: asIssueId('issue-1') })),
    waitForSpawnConfirmed: vi.fn(async () => {}),
    setSessionDraft: vi.fn(),
    refreshSuperThreads,
  } as unknown as EngineActionRuntime<PodiumClientApi>
  return {
    actions: createEngineActions(runtime),
    refreshSuperThreads,
    enqueue,
    pending,
    awaiting,
    retireAwaiting: runtime.outbox.retireAwaiting as ReturnType<typeof vi.fn>,
    errors,
    queued,
    navigated,
    state: () => state,
  }
}

describe('engine action ownership boundary', () => {
  it('keeps command and device-local classifications disjoint', () => {
    expect(new Set([...COMMAND_ACTIONS, ...UI_LOCAL_ACTIONS]).size).toBe(
      COMMAND_ACTIONS.length + UI_LOCAL_ACTIONS.length,
    )
  })

  it('navigation, pane, selection, focus, and transient view changes never touch the Outbox', () => {
    const h = harness()
    h.actions.setView('workspace')
    h.actions.setPeekIssueId(asIssueId('issue-1'))
    h.actions.setSelectedWorktree('/worktree')
    h.actions.setSelectedIssueId(asIssueId('issue-1'))
    h.actions.setPane('A', sessionId)
    h.actions.setFocusedPane('B')
    h.actions.setDockShell('/worktree', sessionId)
    h.actions.toggleSplit()
    h.actions.setPaletteOpen(true)

    expect(h.queued).toEqual([])
    expect(h.navigated).toHaveLength(1)
  })

  it('optimistically applies a representative replicated write while airplane-mode queues it', async () => {
    const h = harness()

    await h.actions.setPinned('panel', sessionId, true)

    expect(h.state().pins.panels).toEqual([sessionId])
    expect(h.queued).toEqual([
      { kind: 'pinSet', input: { kind: 'panel', id: sessionId, pinned: true } },
    ])
  })

  it('queues personal layout writes optimistically through the Actions-owned port', () => {
    const h = harness()

    h.actions.replicatedLayout.set('podium.superOpen.v2', '1')
    h.actions.replicatedLayout.set('dockTab', 'files')
    h.actions.replicatedLayout.set('panelMode', JSON.stringify({ [sessionId]: 'native' }))

    expect(h.actions.replicatedLayout.get('superOpen')).toBe('1')
    expect(h.actions.replicatedLayout.get('dockTab')).toBe('files')
    expect(h.queued).toEqual([
      { kind: 'layoutSet', input: { values: { superOpen: '1' } } },
      { kind: 'layoutSet', input: { values: { dockTab: 'files' } } },
      {
        kind: 'layoutSet',
        input: { values: { panelMode: JSON.stringify({ [sessionId]: 'native' }) } },
      },
    ])
  })

  it('rolls layout reducer optimism back when durable enqueue fails', async () => {
    const h = harness()
    h.enqueue.mockRejectedValueOnce(new Error('storage unavailable'))

    h.actions.replicatedLayout.set('superOpen', '1')
    expect(h.actions.replicatedLayout.get('superOpen')).toBe('1')

    await vi.waitFor(() => expect(h.actions.replicatedLayout.get('superOpen')).toBeUndefined())
    expect(h.errors).toEqual([expect.stringContaining('storage unavailable')])
  })

  it('rolls a denied layout command back instead of leaving or retrying its overlay', async () => {
    const h = harness()
    h.actions.replicatedLayout.set('superOpen', '1')
    await Promise.resolve()
    await Promise.resolve()
    const denied = h.pending.shift()
    expect(denied).toBeDefined()

    h.actions.replicatedLayout.commandDropped(denied!)

    expect(h.actions.replicatedLayout.get('superOpen')).toBeUndefined()
  })

  it('retires an accepted command whose row is absent instead of painting a phantom', async () => {
    const h = harness()
    h.actions.replicatedLayout.set('superOpen', '1')
    await Promise.resolve()
    await Promise.resolve()
    const accepted = h.pending.shift()
    expect(accepted).toBeDefined()
    h.awaiting.push(accepted!)

    expect(h.actions.replicatedLayout.commandApplied(accepted!)).toBe(true)
    h.actions.replicatedLayout.reconcile({}, [accepted!.mutationId])

    expect(h.actions.replicatedLayout.get('superOpen')).toBeUndefined()
    expect(h.retireAwaiting).toHaveBeenCalledWith(accepted!.mutationId)
  })

  it('holds an accepted layout value across a stale feed snapshot', async () => {
    const h = harness()
    h.actions.replicatedLayout.set('superOpen', '1')
    await Promise.resolve()
    await Promise.resolve()
    const accepted = h.pending.shift()
    expect(accepted).toBeDefined()
    h.awaiting.push(accepted!)

    expect(h.actions.replicatedLayout.commandApplied(accepted!)).toBe(true)
    h.actions.replicatedLayout.reconcile({ superOpen: '1' }, [accepted!.mutationId])

    h.actions.replicatedLayout.replace({ superOpen: '0' })
    expect(h.actions.replicatedLayout.get('superOpen')).toBe('1')

    // The next matching feed snapshot releases the guard; later snapshots are
    // then allowed to represent a real newer-device change.
    h.actions.replicatedLayout.replace({ superOpen: '1' })
    h.actions.replicatedLayout.replace({ superOpen: '0' })
    expect(h.actions.replicatedLayout.get('superOpen')).toBe('0')
  })

  it('suppresses old-scope layout overlays on rescope while keeping the command recoverable', async () => {
    const h = harness()
    h.actions.replicatedLayout.set('superOpen', '1')
    await Promise.resolve()
    await Promise.resolve()

    h.actions.replicatedLayout.rescope({ dockTab: 'git' })

    expect(h.actions.replicatedLayout.get('superOpen')).toBeUndefined()
    expect(h.actions.replicatedLayout.get('dockTab')).toBe('git')
    expect(h.pending).toHaveLength(1)
  })

  it('fails closed for a device-local key without touching the Outbox', () => {
    const h = harness()
    expect(() => h.actions.replicatedLayout.set('podium.split', '1')).toThrow(
      /not a replicated layout key/,
    )
    expect(h.queued).toEqual([])
  })

  it('rolls reducer optimism back when durable enqueue itself fails', async () => {
    const h = harness()
    h.enqueue.mockRejectedValueOnce(new Error('storage unavailable'))

    await expect(h.actions.setPinned('panel', sessionId, true)).rejects.toThrow(
      'storage unavailable',
    )
    expect(h.state().pins.panels).toEqual([])
  })

  it('never accepts client attribution fields in assembled command payloads', async () => {
    const h = harness()
    await h.actions.setPinned('panel', sessionId, true)
    await h.actions.setTabOrder('/worktree', [sessionId])
    await h.actions.renameSession(sessionId, 'new name')
    h.actions.replicatedLayout.set('superOpen', '1')
    h.actions.replicatedLayout.clear('superOpen')

    // Per-field, deliberately: `not.toEqual(expect.arrayContaining([...]))`
    // only fails when EVERY listed field is present at once, so the realistic
    // drift — one field leaking into one payload — passes silently (POD-1533).
    for (const { kind, input } of h.queued) {
      const keys = nestedKeys(input)
      for (const field of ATTRIBUTION_FIELDS) {
        expect(keys, `${kind} payload asserts attribution field '${field}'`).not.toContain(field)
      }
    }
  })
})

describe('superagent thread refresh (POD-330, audit item zero)', () => {
  it('re-reads the thread list after seeding a btw thread, instead of bumping a key', async () => {
    // The seeding mutation MINTS a thread. Before POD-330 the action bumped a
    // `superRefreshKey` counter and the view watched it; now the action names
    // what it wants. A missing refresh here is a view that shows a thread list
    // without the thread the user just created — silent, and only visible on
    // the next unrelated refresh.
    const { actions, refreshSuperThreads } = harness()
    await actions.startBtw(asSessionId('sess-btw'))
    expect(refreshSuperThreads).toHaveBeenCalledTimes(1)
  })
})
