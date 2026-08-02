import { asIssueId, asSessionId } from '@podium/model'
import { describe, expect, it, vi } from 'vitest'
import type { PodiumClientApi } from '../api'
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
    return { mutationId: `m-${queued.length}`, kind, input, queuedAt: 1 }
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
    api: {} as PodiumClientApi,
    hub: {} as SocketHub,
    outbox: { enqueue } as unknown as EngineOutbox,
    router,
    notices: {} as StoreNotices,
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
    h.actions.setDockTab('files')
    h.actions.setPanelMode(sessionId, 'native')
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

  it('never accepts client attribution fields in assembled command payloads', async () => {
    const h = harness()
    await h.actions.setPinned('panel', sessionId, true)
    await h.actions.setTabOrder('/worktree', [sessionId])
    await h.actions.renameSession(sessionId, 'new name')

    for (const { input } of h.queued) {
      expect(Object.keys(input as object)).not.toEqual(
        expect.arrayContaining(['actor', 'owner', 'ownerId', 'origin']),
      )
    }
  })
})
