import { asIssueId, asSessionId } from '@podium/model'
import { describe, expect, it, vi } from 'vitest'
import type { PodiumClientApi } from '../api'
import type { OutboxEntry } from '../outbox'
import type { Router } from '../router'
import type { SocketHub } from '../socket-transport'
import {
  COMMAND_ACTIONS,
  createEngineActions,
  type EngineActionRuntime,
  UI_LOCAL_ACTIONS,
} from './actions'
import type { StoreNotices } from './types'
import type { EngineOutbox, OutboxKinds } from './wiring'

const sessionId = asSessionId('session-1')

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
    superRefreshKey: 0,
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
    api: { layout: { get: { query: async () => ({}) } } } as unknown as PodiumClientApi,
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
    setPanelRenderMode: vi.fn(),
    spawnDraftAgent: vi.fn(() => ({ sessionId, issueId: asIssueId('issue-1') })),
    setSessionDraft: vi.fn(),
  } as unknown as EngineActionRuntime<PodiumClientApi>
  return {
    actions: createEngineActions(runtime),
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

  it('routes personal layout actions through reducer optimism and the airplane-mode queue', () => {
    const h = harness()

    h.actions.setSuperOpen(true)
    h.actions.setDockTab('files')
    h.actions.setPanelMode(sessionId, 'native')

    expect(h.state().superOpen).toBe(true)
    expect(h.state().dockTab).toBe('files')
    expect(h.state().panelMode).toEqual({ [sessionId]: 'native' })
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

    for (const { input } of h.queued) {
      expect(Object.keys(input as object)).not.toEqual(
        expect.arrayContaining(['actor', 'owner', 'ownerId', 'origin']),
      )
    }
  })
})
