import { observable, observe, reaction, runInAction } from 'mobx'
import { fixtureNavigation } from '../../test-support/navigation'
import type { SessionView } from '../session-values'

// @vitest-environment happy-dom
// (terminal-client's index pulls xterm addons that need a browser-ish global
// at import time; the engine itself is DOM-optional.)
/**
 * Engine unit tests (#262 [spec:SP-3fe2]): lifecycle idempotence, the
 * single-URL-writer invariant (the React-#185 ping-pong scenario, simulated),
 * snapshot identity stability (useSyncExternalStore requirement), and
 * outbox drain on hub reconnect. Everything runs against fakes — no React,
 * no DOM, no network.
 */

import { repositoryCheckouts } from '@podium/client-core/test-support/machine-records'
import { createReplicaFixture } from '@podium/client-core/test-support/replica'
import type { GitRepositoryWire } from '@podium/model'
import { asArtifactId, asIssueId, asMachineId, asSessionId, asUserId } from '@podium/model'
import { render } from '@testing-library/react'
import { createElement } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { installMobxWarnTrap } from '../../../../tests/worklist/harness/src/mobx-trap'
import { createRuntimeWorklistPool } from '../../../client-graph/src/runtime-pool'
import type { PodiumClientApi } from '../api'
import { asClientPrincipal } from '../principal'
import { memoryStorage, type Replica, type StorageApi } from '../replica/contract'
import type { SocketHub } from '../socket-transport'
import * as notificationAudio from '../sound/cuelume'
import type { NotificationSession, SessionPhaseChange } from '../sound/notification-sounds'
import type { RouterWindow } from '../ui-state'
import { allTabIds, emptyWorkspace, openTab, splitPane } from '../values'
import {
  NAVIGATION_LOADING,
  type NavigationProvider,
  type NavigationTopologyDelta,
} from './navigation-provider'
import { createClientRuntime } from './runtime'

const settle = (ms = 25): Promise<void> => new Promise((r) => setTimeout(r, ms))

// ---------------------------------------------------------------- fakes

class FakeHub {
  onCalls: string[] = []
  viewStates: Array<{ visible: string[]; focused: string | null }> = []
  disposedCount = 0
  connectCount = 0
  connectNowCount = 0
  visibles: boolean[] = []
  health: { status: 'ok' | 'degraded' | 'down'; rttMs: number | null; since: number } = {
    status: 'down',
    rttMs: null,
    since: 0,
  }
  private handlers = new Map<string, Set<(...a: unknown[]) => void>>()
  on(kind: string, cb: (...a: unknown[]) => void): () => void {
    this.onCalls.push(kind)
    let set = this.handlers.get(kind)
    if (!set) {
      set = new Set()
      this.handlers.set(kind, set)
    }
    set.add(cb)
    return () => set.delete(cb)
  }
  emit(kind: string, ...a: unknown[]): void {
    for (const cb of [...(this.handlers.get(kind) ?? [])]) cb(...a)
  }
  subscribed(kind: string): number {
    return this.handlers.get(kind)?.size ?? 0
  }
  connectionHealth(): { status: 'ok' | 'degraded' | 'down'; rttMs: number | null; since: number } {
    return this.health
  }
  /** The live feed's slice (POD-5798): topics stay pending, no server identity yet. */
  topicHolds = new Map<string, number>()
  subscribeTopic(
    kind: string,
    id: string,
    listener: { onState?: (state: { status: 'pending' }) => void },
  ): () => void {
    const key = `${kind}:${id}`
    this.topicHolds.set(key, (this.topicHolds.get(key) ?? 0) + 1)
    listener.onState?.({ status: 'pending' })
    let released = false
    return () => {
      if (released) return
      released = true
      const left = (this.topicHolds.get(key) ?? 1) - 1
      if (left === 0) this.topicHolds.delete(key)
      else this.topicHolds.set(key, left)
    }
  }
  machines(): never[] {
    return []
  }
  serverIdentity(): null {
    return null
  }
  clockSkewMs(): null {
    return null
  }
  seedMetadata(): void {}
  connect(): void {
    this.connectCount++
  }
  connectNow(): void {
    this.connectNowCount++
  }
  dispose(): void {
    this.disposedCount++
  }
  setViewState(visible: string[], focused: string | null): void {
    this.viewStates.push({ visible, focused })
  }
  setVisible(v: boolean): void {
    this.visibles.push(v)
  }
  sendSessionDraft(): void {}
  /** Versioned draft frames the runtime pushed, and whether the socket took
   *  them. `connected` mirrors the real hub's send guard. */
  draftEdits: Array<{ sessionId: string; baseRev: number; text: string }> = []
  connected = true
  sendDraftEdit(sessionId: string, baseRev: number, text: string): boolean {
    if (!this.connected) return false
    this.draftEdits.push({ sessionId, baseRev, text })
    return true
  }
}

const KNOWN_REPO = {
  path: '/tmp/known-repo',
  kind: 'repository',
  branch: 'main',
  worktrees: [{ path: '/tmp/known-repo/.worktrees/wt1', branch: 'wt1' }],
} as unknown as GitRepositoryWire

/** The default replica: KNOWN_REPO's checkout records on one machine (POD-6644). */
function knownRepoReplica(storage: StorageApi) {
  const replica = createReplicaFixture({ storage })
  replica.applySnapshot(
    'checkouts',
    repositoryCheckouts(KNOWN_REPO, 'm-known').map((record) => record.value) as never,
  )
  return replica
}

function session(id: string, cwd: string): SessionView {
  return {
    sessionId: id,
    agentKind: 'claude-code',
    title: id,
    cwd,
    status: 'live',
    controllerId: 'c0',
    geometry: { cols: 80, rows: 24 },
    epoch: 0,
    clientCount: 1,
    createdAt: '2026-07-01T00:00:00.000Z',
    lastActiveAt: '2026-07-01T00:00:00.000Z',
    origin: { kind: 'spawn' },
    archived: false,
    readAt: null,
    unread: false,
  } as unknown as SessionView
}

// biome-ignore lint/suspicious/noExplicitAny: test fixture — shaped per-test, cast once at the boundary
function makeApi(): any {
  return {
    sync: {
      changesSince: {
        query: async () => ({
          kind: 'snapshot',
          sessions: [],
          issues: [],
          conversations: [],
          diagnostics: [],
          cursor: 0,
        }),
      },
    },
    discovery: {
      refreshRepos: {
        mutate: vi.fn(async () => ({ repositories: [KNOWN_REPO], diagnostics: [], machines: [] })),
      },
    },
    quota: { summary: { query: vi.fn(async () => []) } },
    pins: {
      list: { query: async () => ({ panels: [], worktrees: [], repos: [] }) },
      set: { mutate: async () => ({ panels: [], worktrees: [], repos: [] }) },
    },
    tabs: {
      listOrders: { query: async () => ({}) },
      setOrder: { mutate: async () => ({}) },
    },
    settings: {
      get: {
        query: async () => ({
          sidebar: { repoSort: 'lastUsed', repoOrder: [], groupByRepo: false },
        }),
      },
      set: { mutate: async (s: unknown) => s },
    },
    sessions: {
      rename: { mutate: vi.fn(async () => ({})) },
      setArchived: { mutate: vi.fn(async () => ({})) },
      setWorkState: { mutate: vi.fn(async () => ({})) },
      markRead: { mutate: vi.fn(async () => ({})) },
      markUnread: { mutate: async () => ({}) },
      dismissOffer: { mutate: vi.fn(async () => ({})) },
    },
    issues: {
      markRead: { mutate: vi.fn(async () => ({})) },
      markUnread: { mutate: async () => ({}) },
    },
  }
}

/** RouterWindow over an in-memory URL, with working popstate + a write log. */
function makeRouterWindow(initialUrl: string): {
  win: RouterWindow
  writes: string[]
  url(): string
  popTo(url: string): void
} {
  const split = (url: string): { pathname: string; search: string } => {
    const q = url.indexOf('?')
    return q === -1
      ? { pathname: url, search: '' }
      : { pathname: url.slice(0, q), search: url.slice(q) }
  }
  let cur = split(initialUrl)
  const listeners = new Set<() => void>()
  const writes: string[] = []
  const win: RouterWindow = {
    location: {
      get pathname() {
        return cur.pathname
      },
      get search() {
        return cur.search
      },
    },
    history: {
      pushState: (_d, _u, url) => {
        if (typeof url === 'string') {
          cur = split(url)
          writes.push(`push:${url}`)
        }
      },
      replaceState: (_d, _u, url) => {
        if (typeof url === 'string') {
          cur = split(url)
          writes.push(`replace:${url}`)
        }
      },
    },
    addEventListener: (_t, cb) => listeners.add(cb),
    removeEventListener: (_t, cb) => listeners.delete(cb),
  }
  return {
    win,
    writes,
    url: () => `${cur.pathname}${cur.search}`,
    popTo: (url: string) => {
      cur = split(url)
      for (const cb of [...listeners]) cb()
    },
  }
}

const noticeReleases = new Set<() => void>()
afterEach(() => {
  for (const release of noticeReleases) release()
  noticeReleases.clear()
})

function makeEngine(
  opts: {
    url?: string
    api?: unknown
    hub?: FakeHub
    storage?: StorageApi
    replica?: Replica
    workspacePruneGraceMs?: number
    draftSendDebounceMs?: number
    draftPersistDebounceMs?: number
    principal?: string
    networkEnabled?: boolean
    info?: (title: string, destination?: string) => void
  } = {},
) {
  const hub = opts.hub ?? new FakeHub()
  const rw = makeRouterWindow(opts.url ?? '/')
  const fatals: string[] = []
  const errors: string[] = []
  const engine = createClientRuntime({
    principal: asClientPrincipal(asUserId(opts.principal ?? 'operator')),
    config: { httpOrigin: 'http://x', wsClientUrl: 'ws://x' },
    api: (opts.api ?? makeApi()) as PodiumClientApi,
    onFatalError: (m) => fatals.push(m),
    ...(opts.networkEnabled !== undefined ? { networkEnabled: opts.networkEnabled } : {}),
    notices: { error: (m) => errors.push(m), info: opts.info ?? (() => {}) },
    createReplicaFn: () => opts.replica ?? knownRepoReplica(opts.storage ?? memoryStorage()),
    routerWindow: rw.win,
    createHub: () => hub as unknown as SocketHub,
    ...(opts.workspacePruneGraceMs !== undefined
      ? { workspacePruneGraceMs: opts.workspacePruneGraceMs }
      : {}),
    ...(opts.draftSendDebounceMs !== undefined
      ? { draftSendDebounceMs: opts.draftSendDebounceMs }
      : {}),
    ...(opts.draftPersistDebounceMs !== undefined
      ? { draftPersistDebounceMs: opts.draftPersistDebounceMs }
      : {}),
  })
  // Stand in for the provider's platform toast consumer without changing the
  // notice assertions: the runtime now writes the UiStore's unsaved queue.
  noticeReleases.add(
    reaction(
      () => engine.ui.notices.slice(),
      (pending) => {
        for (const notice of pending) {
          if (notice.kind === 'error') errors.push(notice.message)
          else opts.info?.(notice.message, notice.description)
          engine.ui.dismissNotice(notice.id)
        }
      },
      { fireImmediately: true },
    ),
  )
  engine.setNavigationProvider(
    fixtureNavigation({
      issues: () => engine.root.replica.rows('issueProjections'),
      sessions: () => engine.root.replica.rows('sessions') as unknown as SessionView[],
      markers: () => engine.root.replica.rows('issueUserStates'),
      follow: (changed) => engine.root.replica.subscribeRows('sessions', changed),
    }),
  )
  return { engine, hub, rw, fatals, errors }
}

// ---------------------------------------------------------------- tests

describe('addressed topology navigation', () => {
  function addressed(engine: ReturnType<typeof makeEngine>['engine']) {
    const rows = new Map<string, SessionView>()
    let changed: ((delta?: NavigationTopologyDelta) => void) | undefined
    let watched: (() => void) | undefined
    let labelLoading = false
    const summaries = vi.fn((id: string) => (labelLoading ? NAVIGATION_LOADING : rows.get(id)))
    const provider: NavigationProvider = {
      issue: () => undefined,
      missionRoot: () => undefined,
      missionMembers: () => new Set(),
      issueReadAt: () => undefined,
      activityAt: () => undefined,
      session: (id) => rows.get(id),
      sessionMembership: (id) => rows.get(id),
      registeredWorktree: (path) => path === '/old' || path === '/dest',
      firstWorktree: () => '/old',
      hasWorktreeSession: () => false,
      worktreeForCwd: (cwd) => (cwd === '/old' || cwd === '/dest' ? cwd : null),
      worktreeSession: summaries,
      topologySession: (id) => {
        const row = rows.get(id)
        return row ? { cwd: row.cwd, order: id } : undefined
      },
      onTopology: (fn) => {
        changed = fn
        return () => {
          changed = undefined
        }
      },
      watch: (read, wake) => {
        read()
        watched = wake
        return () => {
          if (watched === wake) watched = undefined
        }
      },
    }
    engine.setNavigationProvider(provider)
    return {
      rows,
      summaries,
      publish: (delta: NavigationTopologyDelta) => changed?.(delta),
      loading: (value: boolean) => {
        labelLoading = value
      },
      wake: () => watched?.(),
    }
  }

  it('retains a visible move through a reset before the queued wake', async () => {
    const info = vi.fn(),
      { engine } = makeEngine({ info })
    const f = addressed(engine)
    try {
      f.rows.set('pane', session('pane', '/old'))
      engine.access.navigateWorkspace({
        selectedWorktree: '/old',
        tabId: asSessionId('pane'),
        firstPane: true,
      })
      await settle()
      f.rows.set('pane', session('pane', '/dest'))
      f.publish({
        reset: false,
        sessions: [
          {
            id: 'pane',
            before: { cwd: '/old', order: 'pane' },
            after: { cwd: '/dest', order: 'pane' },
          },
        ],
      })
      f.publish({ reset: true, sessions: [] })
      await settle()
      expect(engine.access.selectedWorktree).toBe('/dest')
      expect(info).not.toHaveBeenCalled()
    } finally {
      engine.destroy()
    }
  })

  it('retries one background label without demanding first-sight or evicted summaries', async () => {
    const info = vi.fn(),
      { engine } = makeEngine({ info })
    const f = addressed(engine)
    try {
      await settle()
      f.rows.set('background', session('background', '/dest'))
      f.loading(true)
      f.publish({
        reset: false,
        sessions: [
          {
            id: 'background',
            before: { cwd: '/old', order: 'background' },
            after: { cwd: '/dest', order: 'background' },
          },
          ...Array.from({ length: 512 }, (_, i) => ({
            id: `new-${i}`,
            after: { cwd: '/dest', order: `new-${i}` },
          })),
          { id: 'evicted', before: { cwd: '/old', order: 'evicted' } },
        ],
      })
      await settle()
      expect(info).not.toHaveBeenCalled()
      expect(f.summaries.mock.calls.length).toBeGreaterThan(0)
      expect(f.summaries.mock.calls.every(([id]) => id === 'background')).toBe(true)
      f.loading(false)
      f.wake()
      await settle()
      expect(info).toHaveBeenCalledExactlyOnceWith('background moved worktree', '/dest')
      f.wake()
      await settle()
      expect(info).toHaveBeenCalledTimes(1)
    } finally {
      engine.destroy()
    }
  })
})

describe('engine replica construction (POD-1239)', () => {
  it('refuses to construct without a replica factory instead of adopting ambient storage', () => {
    // The engine used to fall back to `createReplicaFixture()` with no argument, which
    // resolved window.localStorage itself — so the flag-off browser adopted the
    // previous user's rows through a construction site that belonged to no
    // composition root and therefore appeared in no audit population.
    //
    // The type now forbids omitting the factory, but a type is only half a guard:
    // it is erased, and the untyped caller is exactly the one that would reach
    // ambient storage silently. This drives the RUNTIME arm — without it, the
    // check is a declaration whose refusing branch nothing has ever produced.
    const init = {
      principal: asClientPrincipal(asUserId('operator')),
      config: { httpOrigin: 'http://x', wsClientUrl: 'ws://x' },
      api: makeApi() as PodiumClientApi,
      onFatalError: () => {},
      createHub: () => new FakeHub() as unknown as SocketHub,
    }
    expect(() =>
      createClientRuntime(init as unknown as Parameters<typeof createClientRuntime>[0]),
    ).toThrow(/requires createReplicaFn/)
  })

  it('uses the factory it is given (the arm that must say yes)', () => {
    // The counterfactual for the refusal above: a factory IS honoured, so the
    // throw is about the missing factory and not about this init shape being
    // unconstructable for some unrelated reason.
    const replica = createReplicaFixture({ storage: memoryStorage() })
    const { engine } = makeEngine()
    expect(engine).toBeDefined()
    expect(() =>
      createClientRuntime({
        principal: asClientPrincipal(asUserId('operator')),
        config: { httpOrigin: 'http://x', wsClientUrl: 'ws://x' },
        api: makeApi() as PodiumClientApi,
        onFatalError: () => {},
        createReplicaFn: () => replica,
        createHub: () => new FakeHub() as unknown as SocketHub,
      }),
    ).not.toThrow()
  })
})

describe('saved device screen and cold links', () => {
  it('paints restored selection, workspaces, files and dock in its first React frame', () => {
    const storage = memoryStorage()
    let ws = openTab(emptyWorkspace('wt:/repo'), 'session-1', { permanent: true })
    ws = splitPane(ws, ws.focusedPaneId, 'row', { tabId: 'session-2' })
    storage.setItem(
      'podium.kernel-replica.ui.v1',
      JSON.stringify({
        version: 1,
        view: 'settings',
        settingsTab: 'appearance',
        selectedWorktree: '/repo',
        selectedIssueId: null,
        openIssueId: null,
        focusedPane: ws.focusedPaneId,
        workspaces: { 'wt:/repo': ws },
        superThreadId: 'thread-2',
        attachedSessionId: 'session-1',
        dockVisibleSession: 'session-2',
        dockShells: { '/repo': 'session-2' },
        fileTabs: [
          {
            id: 'file-1',
            scope: { kind: 'worktree', root: '/repo' },
            path: 'readme.md',
            worktreePath: '/repo',
          },
        ],
      }),
    )
    const { engine } = makeEngine({ storage, networkEnabled: false })
    const frames: unknown[] = []
    const expected = {
      view: 'settings',
      settings: 'appearance',
      worktree: '/repo',
      issue: null,
      paneA: 'session-1',
      paneB: 'session-2',
      focus: ws.focusedPaneId,
      split: true,
      files: ['file-1'],
      dockShells: { '/repo': 'session-2' },
      attached: 'session-1',
      dock: 'session-2',
      thread: 'thread-2',
    }
    function FirstPaint() {
      const ui = engine.ui
      const screen = {
        view: ui.view,
        settings: ui.settingsTab,
        worktree: ui.selectedWorktree,
        issue: ui.selectedIssueId,
        paneA: ui.paneA,
        paneB: ui.paneB,
        focus: ui.focusedPane,
        split: ui.split,
        files: [...ui.fileTabs.keys()],
        dockShells: ui.dockShells,
        attached: ui.attachedSessionId,
        dock: ui.dockVisibleSession,
        thread: ui.superThreadId,
      }
      frames.push(screen)
      return createElement('output', null, JSON.stringify(screen))
    }
    const rendered = render(createElement(FirstPaint))
    expect(frames).toEqual([expected])
    expect(rendered.container.textContent).toBe(JSON.stringify(expected))
    rendered.unmount()
    engine.destroy()
  })
  it('keeps a cold pane link while the saved issue workspace waits for navigation', async () => {
    const storage = memoryStorage(),
      pane = '00000000-0000-4000-8000-000000000001'
    storage.setItem(
      'podium.kernel-replica.ui.v1',
      JSON.stringify({
        version: 1,
        selectedIssueId: 'not-loaded',
        workspaces: {
          'issue:not-loaded': openTab(emptyWorkspace('issue:not-loaded'), 'old', {
            permanent: true,
          }),
        },
      }),
    )
    const { engine, rw } = makeEngine({
      storage,
      url: `/workspace?pane=${pane}`,
      networkEnabled: false,
    })
    engine.start()
    expect(rw.url()).toContain(`pane=${pane}`)
    engine.dispose()
    engine.start()
    await settle()
    expect(engine.ui.paneA).toBe(pane)
    expect(rw.url()).toContain(`pane=${pane}`)
    engine.destroy()
  })
  it.each([
    '/workspace',
    '/',
  ])('opens a cold %s pane link before mirroring the saved layout', (location) => {
    const pane = '00000000-0000-4000-8000-000000000001'
    const { engine, rw } = makeEngine({ url: `${location}?pane=${pane}`, networkEnabled: false })
    expect(engine.ui.paneA).toBe(pane)
    expect(rw.url()).toContain(`pane=${pane}`)
    engine.start()
    expect(engine.ui.paneA).toBe(pane)
    expect(rw.url()).toContain(`pane=${pane}`)
    engine.destroy()
  })
})

describe('replicated layout routing', () => {
  it('each real legacy setter enqueues exactly one canonical layout command', async () => {
    const withWriter = () => {
      const fixture = makeEngine()
      fixture.engine.attachPoolWriter({
        write: async (kind, input) => {
          await fixture.engine.root.services.outbox.queue.enqueue(kind, input)
        },
      })
      return fixture
    }
    const dock = withWriter()
    dock.engine.access.setDockTab('git')
    await settle()
    // One key: a record edit of my layout row (POD-6404).
    const layout = (key: string, value: unknown) => ({
      kind: 'recordEdit',
      input: { kind: 'userLayout', id: expect.stringContaining(key), patch: { value } },
    })
    expect(dock.engine.root.services.outbox.queue.pending()).toMatchObject([
      layout('dockTab', 'git'),
    ])
    dock.engine.dispose()

    const superPanel = withWriter()
    superPanel.engine.access.setSuperOpen(false)
    await settle()
    expect(superPanel.engine.root.services.outbox.queue.pending()).toMatchObject([
      layout('superOpen', '0'),
    ])
    superPanel.engine.dispose()

    const panelMode = withWriter()
    panelMode.engine.access.setPanelMode(asSessionId('session-1'), 'native')
    await settle()
    expect(panelMode.engine.root.services.outbox.queue.pending()).toMatchObject([
      layout('panelMode', JSON.stringify({ 'session-1': 'native' })),
    ])
    panelMode.engine.dispose()
  })
})

describe('the LiveStore lifetime (POD-5798)', () => {
  it('holds account.quota while started, and sign-out disposes the store and every subscription', async () => {
    const { engine, hub } = makeEngine()
    engine.start()
    await settle()
    expect([...hub.topicHolds.keys()]).toEqual(['account.quota:operator'])
    // The live feed follows the machine records (POD-6644).
    engine.replica.applySnapshot('machines', [
      { id: 'm1', name: 'm1', loggedOutHarnesses: [] },
      { id: 'm2', name: 'm2', loggedOutHarnesses: [] },
    ] as never)
    expect([...hub.topicHolds.keys()].sort()).toEqual([
      'account.quota:operator',
      'machine.condition:m1',
      'machine.condition:m2',
    ])
    engine.destroy()
    expect(hub.topicHolds.size).toBe(0)
    expect(engine.root.live.isDisposed).toBe(true)
    expect(engine.root.live.quota.known).toBe(false)
    expect(engine.root.live.machineConditions.size).toBe(0)
  })

  it('a new runtime starts with every reading unknown: nothing from a previous run survives', async () => {
    const storage = memoryStorage()
    const first = makeEngine({ storage, networkEnabled: false })
    first.engine.start()
    await settle()
    first.engine.destroy()
    // Offline from the start: no socket, no topic, no reading.
    const second = makeEngine({ storage, networkEnabled: false })
    second.engine.start()
    await settle()
    const live = second.engine.root.live
    expect(live.connection.state).toBe('connecting')
    expect(live.connection.serverBuild).toBeUndefined()
    expect(live.quota.known).toBe(false)
    expect(live.machineConditions.size).toBe(0)
    expect(live.machineMetrics.size).toBe(0)
    second.engine.destroy()
  })
})

describe('engine lifecycle', () => {
  it.each([
    'before',
    'after',
  ] as const)('plays a newly synced completion with the pool attached %s runtime start', async (attachment) => {
    const replica = createReplicaFixture()
    const working = {
      ...session('sound-session', '/tmp/known-repo/.worktrees/wt1'),
      agentState: {
        phase: 'working' as const,
        since: '2026-07-01T00:00:00.000Z',
        nativeSubagentCount: 0,
      },
    }
    replica.applySnapshot('sessions', [working])
    const { engine, hub } = makeEngine({ replica, networkEnabled: false })
    const play = vi.spyOn(notificationAudio, 'play').mockImplementation(() => {})
    const focus = vi.spyOn(document, 'hasFocus').mockReturnValue(false)
    let handle: ReturnType<typeof createRuntimeWorklistPool> | undefined
    try {
      if (attachment === 'after') engine.start()
      handle = createRuntimeWorklistPool(engine)
      if (attachment === 'before') engine.start()
      await settle()
      expect(play).not.toHaveBeenCalled()
      expect(hub.onCalls).not.toContain('sessions')

      // Exercise the real replica address channel, pool attachment and
      // runtime-owned reaction. Only the final audio output is stubbed.
      replica.applyChanges(
        'sessions',
        [
          {
            ...working,
            agentState: {
              phase: 'idle',
              since: '2026-07-01T00:01:00.000Z',
              nativeSubagentCount: 0,
              idle: { kind: 'done' },
            },
          },
        ],
        [],
      )
      await settle()
      expect(play).toHaveBeenCalledExactlyOnceWith('success')

      engine.dispose()
      replica.applyChanges(
        'sessions',
        [
          {
            ...working,
            agentState: {
              phase: 'needs_user',
              since: '2026-07-01T00:02:00.000Z',
              nativeSubagentCount: 0,
              need: { kind: 'question', summary: 'One more question' },
            },
          },
        ],
        [],
      )
      await settle()
      expect(play).toHaveBeenCalledTimes(1)
    } finally {
      handle?.dispose()
      engine.dispose()
      play.mockRestore()
      focus.mockRestore()
    }
  })

  it('reads no repositories at boot: machines and checkouts are records (POD-6644)', async () => {
    const api = makeApi()
    const { engine } = makeEngine({ api })
    engine.start()
    await settle()
    expect(api.discovery.refreshRepos.mutate).not.toHaveBeenCalled()
    engine.dispose()
  })

  it('asks nothing for superagent threads at boot: they are synced records (POD-6675)', async () => {
    const api = makeApi()
    const { engine, fatals } = makeEngine({ api })
    engine.start()
    await settle()
    expect(fatals).toEqual([])
    expect((api as { superagent?: unknown }).superagent).toBeUndefined()
    expect('superThreads' in engine.access).toBe(false)
    engine.dispose()
  })

  it('start is idempotent; dispose→start re-arms subscriptions (StrictMode)', async () => {
    const { engine, hub, fatals } = makeEngine()
    engine.start()
    engine.start() // double-start must not double-subscribe
    expect(hub.onCalls.filter((k) => k === 'attention')).toHaveLength(1)
    await settle()
    engine.dispose()
    engine.dispose() // double-dispose must not throw
    expect(hub.subscribed('attention')).toBe(0)
    engine.start() // re-start after dispose re-arms everything
    await settle()
    expect(hub.subscribed('attention')).toBe(1)
    engine.dispose()
    expect(fatals).toEqual([])
  })
})

describe('session resurrection (POD-6399)', () => {
  // Resume is an edit of the session record now; how it went shows on the
  // session (`sessionTransition`), so the old call's refusal toasts are gone.
  it('is an edit of the session record, never the old resurrect call', async () => {
    const api = makeApi()
    const resurrect = vi.fn(async () => ({ ok: true }))
    api.sessions.resurrect = { mutate: resurrect }
    const { engine, errors } = makeEngine({ api })

    const result = await engine.root.commands.sessions.resume(asSessionId('sleeping'))

    expect(resurrect).not.toHaveBeenCalled()
    // This fixture attaches no pool writer: the edit is refused, and says so.
    expect(result.ok).toBe(false)
    expect(errors).toHaveLength(1)
    expect(errors[0]).toMatch(/^Couldn't change the session — /)
  })
})

describe('artifact file tabs ([spec:SP-0fc9] #441)', () => {
  it('openArtifact creates an artifact-scoped tab carrying the issue, and focuses it', () => {
    const { engine } = makeEngine()
    engine.start()
    engine.access.openArtifact({
      issueId: asIssueId('iss_1'),
      artifactId: asArtifactId('abc123'),
      path: 'index.html',
      worktreePath: '/wt',
    })
    const st = engine.access
    expect(st.fileTabs).toEqual([
      {
        id: 'file:a:iss_1:abc123:index.html',
        scope: {
          kind: 'artifact',
          issueId: asIssueId('iss_1'),
          artifactId: asArtifactId('abc123'),
        },
        path: 'index.html',
        worktreePath: '/wt',
        issueId: asIssueId('iss_1'),
      },
    ])
    expect(st.paneA).toBe('file:a:iss_1:abc123:index.html')
    // Re-opening the same artifact reuses the tab.
    engine.access.openArtifact({
      issueId: asIssueId('iss_1'),
      artifactId: asArtifactId('abc123'),
      path: 'index.html',
    })
    expect(engine.access.fileTabs).toHaveLength(1)
    engine.dispose()
  })

  it('openArtifact from the issues view lands on the workspace with the issue selected (#101)', async () => {
    const { engine, rw } = makeEngine({ url: '/issues/iss_1' })
    engine.start()
    await settle()
    engine.access.openArtifact({
      issueId: asIssueId('iss_1'),
      artifactId: asArtifactId('abc123'),
      path: 'index.html',
      worktreePath: '/tmp/known-repo/.worktrees/wt1',
    })
    await settle()
    const st = engine.access
    expect(st.view).toBe('workspace')
    expect(st.selectedIssueId).toBe('iss_1')
    expect(st.selectedWorktree).toBe('/tmp/known-repo/.worktrees/wt1')
    expect(st.paneA).toBe('file:a:iss_1:abc123:index.html')
    // the URL landed on the workspace with the tab as the pane and STAYED there
    expect(rw.url()).toContain('/workspace')
    expect(decodeURIComponent(rw.url())).toContain('pane=file:a:iss_1:abc123:index.html')
    engine.dispose()
  })

  it('openArtifact without a worktree still lands (issue-owned tab, no worktree bounce)', async () => {
    const { engine, rw } = makeEngine({ url: '/issues/iss_1' })
    engine.start()
    await settle()
    engine.access.openArtifact({
      issueId: asIssueId('iss_1'),
      artifactId: asArtifactId('abc123'),
      path: 'doc.md',
    })
    await settle()
    const st = engine.access
    expect(st.view).toBe('workspace')
    expect(st.selectedIssueId).toBe('iss_1')
    expect(st.paneA).toBe('file:a:iss_1:abc123:doc.md')
    expect(rw.url()).toContain('/workspace')
    engine.dispose()
  })

  it('openFileInWorktree from a non-workspace view navigates to the workspace (#101)', async () => {
    const { engine, rw } = makeEngine({ url: '/issues' })
    engine.start()
    await settle()
    engine.access.openFileInWorktree({
      root: '/tmp/known-repo/.worktrees/wt1',
      path: 'notes.md',
    })
    await settle()
    const st = engine.access
    expect(st.view).toBe('workspace')
    expect(st.selectedWorktree).toBe('/tmp/known-repo/.worktrees/wt1')
    expect(st.paneA).toBe('file:w:/tmp/known-repo/.worktrees/wt1:notes.md')
    expect(rw.url()).toContain('/workspace')
    engine.dispose()
  })

  it("openFile from the issues view lands on the workspace, resolving the session's worktree", async () => {
    const { engine, rw } = makeEngine({ url: '/issues' })
    engine.start()
    await settle()
    engine.root.replica.applySnapshot('sessions', [
      session('s1', '/tmp/known-repo/.worktrees/wt1/sub'),
    ])
    await settle()
    engine.access.openFile(asSessionId('s1'), 'notes.md')
    await settle()
    const st = engine.access
    expect(st.view).toBe('workspace')
    // the containing worktree, not the session's deeper cwd
    expect(st.selectedWorktree).toBe('/tmp/known-repo/.worktrees/wt1')
    expect(st.fileTabs[0]?.worktreePath).toBe('/tmp/known-repo/.worktrees/wt1')
    expect(st.paneA).toBe('file:s:s1:notes.md')
    expect(rw.url()).toContain('/workspace')
    engine.dispose()
  })

  it('readFileScoped routes artifact scope to the artifact input; writes are rejected', async () => {
    const api = makeApi()
    const reads: unknown[] = []
    api.files = {
      read: {
        query: vi.fn(async (input: unknown) => {
          reads.push(input)
          return { ok: true, path: 'index.html', content: '<h1>hi</h1>' }
        }),
      },
      write: { mutate: vi.fn(async () => ({ ok: true })) },
      list: { query: vi.fn(async () => ({})) },
    }
    const { engine } = makeEngine({ api })
    engine.start()
    const scope = {
      kind: 'artifact',
      issueId: asIssueId('iss_1'),
      artifactId: asArtifactId('abc123'),
    } as const
    await engine.root.commands.files.read(scope, 'index.html')
    expect(reads).toEqual([
      { issueId: asIssueId('iss_1'), artifactId: asArtifactId('abc123'), path: 'index.html' },
    ])
    // Immutable snapshot: the write API is never called.
    await expect(
      engine.root.commands.files.write({ scope, path: 'index.html', content: 'x' }),
    ).rejects.toThrow('artifact snapshots are read-only')
    expect(api.files.write.mutate).not.toHaveBeenCalled()
    engine.dispose()
  })
})

describe('file-tab issue ownership + recent files (POD-149)', () => {
  it('openFile stamps the tab with the selected issue and records a recent file', async () => {
    const { engine } = makeEngine({ url: '/issues' })
    engine.start()
    await settle()
    engine.root.replica.applySnapshot('sessions', [session('s1', '/tmp/known-repo/.worktrees/wt1')])
    await settle()
    engine.access.setSelectedIssueId(asIssueId('iss_9'))
    engine.access.openFile(asSessionId('s1'), 'notes.md')
    await settle()
    const st = engine.access
    expect(st.fileTabs[0]?.issueId).toBe('iss_9')
    // reveal keeps the owning issue selected so the strip lists the tab
    expect(st.selectedIssueId).toBe('iss_9')
    expect(st.recentFiles[0]).toMatchObject({
      path: 'notes.md',
      worktreePath: '/tmp/known-repo/.worktrees/wt1',
    })
    engine.dispose()
  })

  it("openFile prefers the session's explicit issue over the selection", async () => {
    const { engine } = makeEngine({ url: '/issues' })
    engine.start()
    await settle()
    engine.root.replica.applySnapshot('sessions', [
      {
        ...session('s1', '/tmp/known-repo/.worktrees/wt1'),
        issueId: asIssueId('iss_own'),
      } as SessionView,
    ])
    await settle()
    engine.access.setSelectedIssueId(asIssueId('iss_other'))
    engine.access.openFile(asSessionId('s1'), 'notes.md')
    await settle()
    const st = engine.access
    expect(st.fileTabs[0]?.issueId).toBe('iss_own')
    // navigated to the OWNING issue's workspace, not the stale selection
    expect(st.selectedIssueId).toBe('iss_own')
    engine.dispose()
  })

  it('openFileInWorktree stamps an explicit caller issue, else the selection, else nothing', async () => {
    const { engine } = makeEngine({ url: '/issues' })
    engine.start()
    await settle()
    const snap = engine.access
    snap.openFileInWorktree({ root: '/tmp/known-repo', path: 'a.md', issueId: asIssueId('iss_1') })
    engine.access.setSelectedIssueId(asIssueId('iss_2'))
    engine.access.openFileInWorktree({ root: '/tmp/known-repo', path: 'b.md' })
    engine.access.setSelectedIssueId(null)
    engine.access.openFileInWorktree({ root: '/tmp/known-repo', path: 'c.md' })
    const tabs = engine.access.fileTabs
    expect(tabs.map((t) => t.issueId)).toEqual(['iss_1', 'iss_2', undefined])
    engine.dispose()
  })

  it('re-opening an existing tab keeps its original owner and reveals THAT issue', async () => {
    const { engine } = makeEngine({ url: '/issues' })
    engine.start()
    await settle()
    engine.access.setSelectedIssueId(asIssueId('iss_1'))
    engine.access.openFileInWorktree({ root: '/tmp/known-repo', path: 'a.md' })
    engine.access.setSelectedIssueId(asIssueId('iss_2'))
    engine.access.openFileInWorktree({ root: '/tmp/known-repo', path: 'a.md' })
    const st = engine.access
    expect(st.fileTabs).toHaveLength(1)
    expect(st.fileTabs[0]?.issueId).toBe('iss_1')
    expect(st.selectedIssueId).toBe('iss_1')
    engine.dispose()
  })

  it('opens a file as the workspace preview, and the next preview replaces it (POD-788)', async () => {
    const { engine } = makeEngine({ url: '/issues' })
    engine.start()
    await settle()
    const preview = (path: string): void =>
      engine.access.openFileInWorktree({ root: '/tmp/known-repo', path, permanent: false })

    preview('a.md')
    let st = engine.access
    let ws = st.workspaces[st.workspaceKey()]
    expect(ws?.previewTabId).toBe('file:w:/tmp/known-repo:a.md')

    // The glance moves on: one temporary tab, in the same strip slot, and the
    // record of the file nothing is rendering any more goes with it.
    preview('b.md')
    st = engine.access
    ws = st.workspaces[st.workspaceKey()]
    expect(ws?.previewTabId).toBe('file:w:/tmp/known-repo:b.md')
    expect(ws ? allTabIds(ws) : []).toEqual(['file:w:/tmp/known-repo:b.md'])
    expect(st.fileTabs.map((t) => t.path)).toEqual(['b.md'])
    // Still reachable from the "+" menu — a glance is not a close.
    expect(st.recentFiles.map((r) => r.path)).toEqual(['b.md', 'a.md'])

    // A double click (and every caller that has not thought about it) keeps it.
    engine.access.openFileInWorktree({ root: '/tmp/known-repo', path: 'c.md' })
    st = engine.access
    ws = st.workspaces[st.workspaceKey()]
    expect(ws?.previewTabId).toBe(null)
    expect(st.fileTabs.map((t) => t.path)).toEqual(['c.md'])
    engine.dispose()
  })

  it('promotes the previewed file in place, so the next glance leaves it alone', async () => {
    const { engine } = makeEngine({ url: '/issues' })
    engine.start()
    await settle()
    engine.access.openFileInWorktree({ root: '/tmp/known-repo', path: 'a.md', permanent: false })
    // What `usePreviewPromotion` fires when the operator types into the panel.
    engine.access.promoteWorkspaceTab('file:w:/tmp/known-repo:a.md')
    engine.access.openFileInWorktree({ root: '/tmp/known-repo', path: 'b.md', permanent: false })
    const st = engine.access
    const ws = st.workspaces[st.workspaceKey()]
    expect(ws ? allTabIds(ws) : []).toEqual([
      'file:w:/tmp/known-repo:a.md',
      'file:w:/tmp/known-repo:b.md',
    ])
    expect(st.fileTabs.map((t) => t.path)).toEqual(['a.md', 'b.md'])
    engine.dispose()
  })

  it('recent files dedupe by path, cap at 30, persist, and openArtifact keeps its ids', async () => {
    const storage = memoryStorage()
    const first = makeEngine({ storage })
    first.engine.start()
    await settle()
    for (let i = 0; i < 32; i++) {
      first.engine.access.openFileInWorktree({ root: '/tmp/known-repo', path: `f${i}.md` })
    }
    // duplicate open moves to front instead of adding
    first.engine.access.openFileInWorktree({ root: '/tmp/known-repo', path: 'f31.md' })
    first.engine.access.openArtifact({
      issueId: asIssueId('iss_1'),
      artifactId: asArtifactId('abc'),
      path: 'index.html',
      worktreePath: '/tmp/known-repo',
    })
    const recents = first.engine.access.recentFiles
    expect(recents).toHaveLength(30)
    expect(recents[0]).toMatchObject({
      path: 'index.html',
      artifact: { issueId: asIssueId('iss_1'), artifactId: asArtifactId('abc') },
    })
    expect(recents[1]?.path).toBe('f31.md')
    first.engine.dispose()
    // a fresh engine over the same storage rehydrates the list
    const second = makeEngine({ storage })
    second.engine.start()
    await settle()
    expect(second.engine.access.recentFiles).toHaveLength(30)
    expect(second.engine.access.recentFiles[0]?.path).toBe('index.html')
    second.engine.dispose()
  })
})

// ---------------------------------------------------------------------------
// POD-272: mark-read-on-view is EAGER for the surface in the foreground. The
// old trailing debounce left a "new message" chip on the row of the very
// session/issue whose message was already on screen.
// ---------------------------------------------------------------------------
describe('offline-first composer drafts (POD-2045)', () => {
  const SID = asSessionId('s-draft')
  const draftOf = (e: ReturnType<typeof makeEngine>['engine']): string | undefined =>
    e.drafts.get(SID)

  it('paints a keystroke locally before anything reaches the server', async () => {
    const { engine, hub } = makeEngine({ draftSendDebounceMs: 5 })
    engine.start()
    await settle()
    hub.connected = false

    engine.root.commands.sessions.setSessionDraft(SID, 'typed with the socket down')

    expect(draftOf(engine)).toBe('typed with the socket down')
    engine.dispose()
    await settle()
  })

  // THE BUG. A slow server drops the frames carrying the newest text, then
  // reconnects and replays a draft older than what is on screen.
  it('never lets a stale replay overwrite newer local text', async () => {
    const { engine, hub } = makeEngine({ draftSendDebounceMs: 5 })
    engine.start()
    await settle()

    engine.root.commands.sessions.setSessionDraft(SID, 'hello world')
    hub.emit('sessionDraft', SID, 'hello', { rev: 3 })

    expect(draftOf(engine)).toBe('hello world')
    engine.dispose()
    await settle()
  })

  it('re-offers the local text against the rev the server actually holds', async () => {
    const { engine, hub } = makeEngine({ draftSendDebounceMs: 5 })
    engine.start()
    await settle()

    engine.root.commands.sessions.setSessionDraft(SID, 'hello world')
    hub.emit('sessionDraft', SID, 'hello', { rev: 3 })
    await settle()

    // Based on rev 3, not on the rev we knew before the replay: an edit whose
    // base is stale is REJECTED by the server's arbitration, so refusing the
    // rev would leave the client shouting a losing sentence forever.
    expect(hub.draftEdits.at(-1)).toEqual({
      sessionId: SID,
      baseRev: 3,
      text: 'hello world',
    })
    engine.dispose()
    await settle()
  })

  it('holds the line against an older server that stamps no rev at all', async () => {
    const { engine, hub } = makeEngine({ draftSendDebounceMs: 5 })
    engine.start()
    await settle()

    engine.root.commands.sessions.setSessionDraft(SID, 'hello world')
    hub.emit('sessionDraft', SID, 'hello')

    expect(draftOf(engine)).toBe('hello world')
    engine.dispose()
    await settle()
  })

  it('takes a draft from another device when nothing local is unsent', async () => {
    const { engine, hub } = makeEngine({ draftSendDebounceMs: 5 })
    engine.start()
    await settle()

    hub.emit('sessionDraft', SID, 'typed on the phone', { rev: 1 })

    expect(draftOf(engine)).toBe('typed on the phone')
    engine.dispose()
    await settle()
  })

  it('coalesces a burst of keystrokes into one frame', async () => {
    const { engine, hub } = makeEngine({ draftSendDebounceMs: 20 })
    engine.start()
    await settle()
    const before = hub.draftEdits.length

    const actions = engine.root.commands.sessions
    actions.setSessionDraft(SID, 'h')
    actions.setSessionDraft(SID, 'he')
    actions.setSessionDraft(SID, 'hel')
    actions.setSessionDraft(SID, 'hell')
    actions.setSessionDraft(SID, 'hello')
    await settle(60)

    expect(hub.draftEdits.slice(before)).toEqual([{ sessionId: SID, baseRev: 0, text: 'hello' }])
    engine.dispose()
    await settle()
  })

  // Clearing is what a SEND does, and a send that leaves the draft standing on
  // another device for a quarter of a second reads as the message duplicating.
  it('sends a clear immediately rather than waiting out the debounce', async () => {
    const { engine, hub } = makeEngine({ draftSendDebounceMs: 10_000 })
    engine.start()
    await settle()

    const actions = engine.root.commands.sessions
    actions.setSessionDraft(SID, 'about to send')
    actions.setSessionDraft(SID, '')

    expect(hub.draftEdits.at(-1)).toEqual({ sessionId: SID, baseRev: 0, text: '' })
    engine.dispose()
    await settle()
  })

  it('settles once its own edit echoes back, and stops re-sending', async () => {
    const { engine, hub } = makeEngine({ draftSendDebounceMs: 5 })
    engine.start()
    await settle()

    engine.root.commands.sessions.setSessionDraft(SID, 'hello world')
    await settle()
    const sentBeforeEcho = hub.draftEdits.length

    hub.emit('sessionDraft', SID, 'hello world', { rev: 4 })
    hub.health = { status: 'ok', rttMs: 1, since: 0 }
    hub.emit('connectionHealth', hub.health)
    await settle()

    expect(draftOf(engine)).toBe('hello world')
    expect(hub.draftEdits.length).toBe(sentBeforeEcho)
    engine.dispose()
    await settle()
  })

  it('re-offers text typed while disconnected as soon as the socket returns', async () => {
    const { engine, hub } = makeEngine({ draftSendDebounceMs: 5 })
    engine.start()
    await settle()
    hub.connected = false

    engine.root.commands.sessions.setSessionDraft(SID, 'typed during the outage')
    await settle()
    expect(hub.draftEdits).toEqual([])

    hub.connected = true
    hub.health = { status: 'ok', rttMs: 1, since: 0 }
    hub.emit('connectionHealth', hub.health)
    await settle()

    expect(hub.draftEdits.at(-1)).toEqual({
      sessionId: SID,
      baseRev: 0,
      text: 'typed during the outage',
    })
    engine.dispose()
    await settle()
  })

  it('prepares the last draft keystroke for reload before its debounce, without teardown', async () => {
    const storage = memoryStorage()
    const first = makeEngine({ storage, draftPersistDebounceMs: 60_000 })
    first.hub.connected = false
    first.engine.root.commands.sessions.setSessionDraft(SID, 'the last unsent keystroke')
    await first.engine.prepareReload()
    const restored = makeEngine({ storage })
    expect(restored.engine.drafts.get(SID)).toBe('the last unsent keystroke')
    expect(first.engine.drafts.get(SID)).toBe('the last unsent keystroke')
    expect(first.hub.draftEdits).toEqual([])
    first.engine.dispose()
    restored.engine.dispose()
  })

  it('reload preparation preserves a keystroke typed during local queue commit', async () => {
    const storage = memoryStorage()
    const first = makeEngine({ storage, draftPersistDebounceMs: 60_000 })
    let release!: () => void
    const commit = new Promise<void>((resolve) => {
      release = resolve
    })
    first.engine.root.services.outbox.queue.flushLocalWrites = () => commit
    first.engine.root.commands.sessions.setSessionDraft(SID, 'before commit')
    const prepared = first.engine.prepareReload()
    first.engine.root.commands.sessions.setSessionDraft(SID, 'typed during commit')
    release()
    await prepared
    const restored = makeEngine({ storage })
    expect(restored.engine.drafts.get(SID)).toBe('typed during commit')
    first.engine.dispose()
    restored.engine.dispose()
  })

  it('keeps a draft across a reload with no server in reach', async () => {
    const storage = memoryStorage()
    const first = makeEngine({ storage, draftSendDebounceMs: 5, draftPersistDebounceMs: 5 })
    first.engine.start()
    await settle()
    first.hub.connected = false
    first.engine.root.commands.sessions.setSessionDraft(SID, 'survives the reload')
    await settle(40)
    first.engine.dispose()
    await settle()

    // A NEW runtime over the same device storage — the reload. No hub traffic
    // and no start() before the read: the draft is on screen from frame one.
    const second = makeEngine({ storage })
    expect(second.engine.drafts.get(SID)).toBe('survives the reload')
    second.engine.dispose()
    await settle()
  })

  it('re-offers a restored draft on the next connect', async () => {
    const storage = memoryStorage()
    const first = makeEngine({ storage, draftSendDebounceMs: 5, draftPersistDebounceMs: 5 })
    first.engine.start()
    await settle()
    first.hub.connected = false
    first.engine.root.commands.sessions.setSessionDraft(SID, 'never reached the server')
    await settle(40)
    first.engine.dispose()
    await settle()

    const second = makeEngine({ storage, draftSendDebounceMs: 5 })
    second.engine.start()
    await settle()
    second.hub.health = { status: 'ok', rttMs: 1, since: 0 }
    second.hub.emit('connectionHealth', second.hub.health)
    await settle()

    expect(second.hub.draftEdits.at(-1)).toEqual({
      sessionId: SID,
      baseRev: 0,
      text: 'never reached the server',
    })
    second.engine.dispose()
    await settle()
  })

  it('keeps an offline deletion through reload, stale sync and acknowledgement', async () => {
    const storage = memoryStorage()
    const first = makeEngine({ storage, draftSendDebounceMs: 5, draftPersistDebounceMs: 5 })
    first.engine.start()
    await settle()
    first.hub.emit('sessionDraft', SID, 'temporary', { rev: 7 })
    first.hub.connected = false
    const actions = first.engine.root.commands.sessions
    actions.setSessionDraft(SID, 'temporary')
    await settle(40)
    actions.setSessionDraft(SID, '')
    await settle(40)
    first.engine.dispose()
    await settle()

    const second = makeEngine({ storage, draftSendDebounceMs: 5 })
    expect(second.engine.drafts.get(SID)).toBe('')
    second.engine.start()
    await settle()
    second.hub.emit('sessionDraft', SID, 'temporary', { rev: 7 })
    expect(second.engine.drafts.get(SID)).toBe('')
    await settle()
    expect(second.hub.draftEdits.at(-1)).toEqual({ sessionId: SID, baseRev: 7, text: '' })
    second.hub.emit('sessionDraft', SID, '', { rev: 8 })
    second.hub.emit('sessionDraft', SID, 'temporary', { rev: 7 })
    expect(second.engine.drafts.get(SID)).toBe('')
    second.engine.dispose()
    await settle()
  })

  it('persists the acknowledgement revision without a text repaint, including a clear', async () => {
    const storage = memoryStorage()
    const first = makeEngine({ storage, draftPersistDebounceMs: 5 })
    first.engine.start()
    await settle()
    first.engine.root.commands.sessions.setSessionDraft(SID, 'temporary')
    await settle(30)
    first.hub.emit('sessionDraft', SID, 'temporary', { rev: 7 })
    await settle(30)
    first.engine.root.commands.sessions.setSessionDraft(SID, '')
    await settle(30)
    first.hub.emit('sessionDraft', SID, '', { rev: 8 })
    await settle(30)
    first.engine.dispose()

    const second = makeEngine({ storage, draftSendDebounceMs: 5 })
    expect(second.engine.drafts.get(SID)).toBe('')
    second.engine.start()
    await settle()
    second.hub.health = { status: 'ok', rttMs: 1, since: 0 }
    second.hub.emit('connectionHealth', second.hub.health)
    await settle()
    expect(second.hub.draftEdits).toEqual([])
    second.engine.root.commands.sessions.setSessionDraft(SID, 'new draft')
    second.engine.root.commands.sessions.setSessionDraft(SID, '')
    expect(second.hub.draftEdits.at(-1)).toEqual({ sessionId: SID, baseRev: 8, text: '' })
    second.engine.dispose()
    await settle()
  })

  it('publishes a clear synchronously once, and older echoes cannot publish text again', async () => {
    const { engine, hub } = makeEngine()
    engine.start()
    await settle()
    hub.emit('sessionDraft', SID, 'old text', { rev: 5 })
    const published: string[] = []
    const off = observe(engine.drafts.values, (change) => {
      if (change.name === SID) published.push(engine.drafts.get(SID))
    })
    engine.root.commands.sessions.setSessionDraft(SID, '')
    expect(published).toEqual([''])
    expect(engine.drafts.get(SID)).toBe('')
    hub.emit('sessionDraft', SID, '', { rev: 6 })
    hub.emit('sessionDraft', SID, 'old text', { rev: 5 })
    hub.emit('sessionDraft', SID, 'other old text', { rev: 4 })
    expect(published).toEqual([''])
    off()
    engine.dispose()
    await settle()
  })

  it('does not resurrect a previously acknowledged draft when its device reloads', async () => {
    const storage = memoryStorage()
    const first = makeEngine({ storage, draftSendDebounceMs: 5, draftPersistDebounceMs: 5 })
    first.engine.start()
    await settle()
    first.engine.root.commands.sessions.setSessionDraft(SID, 'previous message')
    await settle(30)
    first.hub.emit('sessionDraft', SID, 'previous message', { rev: 7 })
    await settle(30)
    first.engine.dispose()

    const second = makeEngine({ storage, draftSendDebounceMs: 5 })
    expect(second.engine.drafts.get(SID)).toBe('previous message')
    second.engine.start()
    await settle()
    second.hub.emit('sessionDraft', SID, 'current draft', { rev: 9 })
    expect(second.engine.drafts.get(SID)).toBe('current draft')
    second.hub.health = { status: 'ok', rttMs: 1, since: 0 }
    second.hub.emit('connectionHealth', second.hub.health)
    await settle()
    expect(second.hub.draftEdits).toEqual([])
    second.hub.emit('sessionDraft', SID, '', { rev: 10 })
    expect(second.engine.drafts.get(SID)).toBe('')
    second.engine.dispose()
    await settle()
  })
})

describe('reconnect nudges from the platform (POD-2060)', () => {
  afterEach(() => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' })
  })

  it('reconnects immediately when the browser says the network is back', async () => {
    const { engine, hub } = makeEngine()
    engine.start()
    await settle()
    expect(hub.connectNowCount).toBe(0)

    window.dispatchEvent(new Event('online'))
    expect(hub.connectNowCount).toBe(1)

    // The listener is released with the rest of the runtime's subscriptions.
    engine.dispose()
    window.dispatchEvent(new Event('online'))
    expect(hub.connectNowCount).toBe(1)
  })

  it('reconnects when the tab is foregrounded, and only then', async () => {
    const { engine, hub } = makeEngine()
    engine.start()
    await settle()

    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' })
    document.dispatchEvent(new Event('visibilitychange'))
    // Hiding still reports visibility to the server; it must not dial out.
    expect(hub.visibles.at(-1)).toBe(false)
    expect(hub.connectNowCount).toBe(0)

    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' })
    document.dispatchEvent(new Event('visibilitychange'))
    expect(hub.visibles.at(-1)).toBe(true)
    // A tab that slept through its heartbeat deadline comes back on foreground
    // instead of waiting out the backoff.
    expect(hub.connectNowCount).toBe(1)

    engine.dispose()
    document.dispatchEvent(new Event('visibilitychange'))
    expect(hub.connectNowCount).toBe(1)
  })
})

describe('principal-owned conversations', () => {
  it('keeps the shared cache across restartable cleanup and destroys it on sign-out', () => {
    const { engine } = makeEngine()
    const start = vi.fn(async () => {}),
      dispose = vi.fn()
    const cache = engine.ownConversations({
      create: () => ({ start, dispose }) as unknown as import('../conversation/model').Conversation,
    })
    const panel = cache.acquire(asSessionId('cached'))
    engine.dispose()
    expect(dispose).not.toHaveBeenCalled()
    expect(
      engine.ownConversations({
        create: () => {
          throw new Error('second factory must not run')
        },
      }),
    ).toBe(cache)
    engine.destroy()
    expect(dispose).toHaveBeenCalledTimes(1)
    panel.release()
    expect(() => cache.acquire(asSessionId('cached'))).toThrow('disposed')
    expect(() =>
      engine.ownConversations({
        create: () => {
          throw new Error('late factory')
        },
      }),
    ).toThrow('owner has changed')
  })
})

// Keep the full strict trap scoped to these lifecycle tests; the older engine
// fixtures above also exercise legacy reads outside reactions.
describe('notification sound phase-source lifecycle', () => {
  installMobxWarnTrap({ errors: true })

  it.each([
    ['before', 'source first'],
    ['before', 'runtime first'],
    ['after', 'source first'],
    ['after', 'runtime first'],
  ] as const)('attaches %s start and detaches %s without an empty reaction or replay', async (attachment, cleanup) => {
    const { engine } = makeEngine({ networkEnabled: false })
    const play = vi.spyOn(notificationAudio, 'play').mockImplementation(() => {})
    vi.spyOn(document, 'hasFocus').mockReturnValue(false)
    const working: NotificationSession = {
      agentKind: 'claude-code',
      archived: false,
      agentState: {
        phase: 'working',
        since: '2026-07-01T00:00:00.000Z',
        nativeSubagentCount: 0,
      },
    }
    const done: NotificationSession = {
      ...working,
      agentState: {
        phase: 'idle',
        since: '2026-07-01T00:01:00.000Z',
        nativeSubagentCount: 0,
        idle: { kind: 'done' },
      },
    }
    const errored: NotificationSession = {
      ...working,
      agentState: {
        phase: 'errored',
        since: '2026-07-01T00:02:00.000Z',
        nativeSubagentCount: 0,
        error: { class: 'api', retryable: true },
      },
    }
    const edge = (current: NotificationSession): SessionPhaseChange[] => [
      {
        sessionId: asSessionId('sound-session'),
        previous: working,
        current,
      },
    ]
    const phases = observable({ changes: edge(done) }, {}, { deep: false })
    const read = vi.fn(() => phases.changes)
    let detach: (() => void) | undefined
    let detachReplacement: (() => void) | undefined
    try {
      if (attachment === 'after') engine.start()
      expect(read).not.toHaveBeenCalled()
      detach = engine.attachSessionPhases(read)
      if (attachment === 'before') expect(read).not.toHaveBeenCalled()
      engine.start()
      engine.start()
      expect(read).toHaveBeenCalledTimes(1)
      expect(play).not.toHaveBeenCalled()

      runInAction(() => {
        phases.changes = edge(done)
      })
      expect(play).toHaveBeenCalledExactlyOnceWith('success')
      expect(read).toHaveBeenCalledTimes(2)

      if (cleanup === 'source first') {
        detach()
      } else {
        engine.dispose()
      }
      runInAction(() => {
        phases.changes = edge(errored)
      })
      expect(read).toHaveBeenCalledTimes(2)
      expect(play).toHaveBeenCalledTimes(1)
      if (cleanup === 'source first') engine.dispose()
      else detach()
      detach()
      runInAction(() => {
        phases.changes = edge(errored)
      })
      expect(read).toHaveBeenCalledTimes(2)
      expect(play).toHaveBeenCalledTimes(1)

      // Restarting without a source must still wait; reattachment seeds the
      // current edge without replaying it, even after a stale detach callback.
      engine.start()
      const replacement = vi.fn(() => phases.changes)
      detachReplacement = engine.attachSessionPhases(replacement)
      expect(replacement).toHaveBeenCalledTimes(1)
      expect(play).toHaveBeenCalledTimes(1)
      detach()
      runInAction(() => {
        phases.changes = edge(errored)
      })
      expect(play).toHaveBeenNthCalledWith(2, 'error')

      // A source may outlive reversible runtime cleanup. It stays silent
      // while stopped and resumes only for new edges after the next start.
      engine.dispose()
      runInAction(() => {
        phases.changes = edge(done)
      })
      expect(replacement).toHaveBeenCalledTimes(2)
      engine.start()
      expect(replacement).toHaveBeenCalledTimes(3)
      expect(play).toHaveBeenCalledTimes(2)
      runInAction(() => {
        phases.changes = edge(done)
      })
      expect(play).toHaveBeenNthCalledWith(3, 'success')
      engine.destroy()
      engine.start()
      runInAction(() => {
        phases.changes = edge(errored)
      })
      expect(replacement).toHaveBeenCalledTimes(4)
      expect(play).toHaveBeenCalledTimes(3)
      await settle()
    } finally {
      detachReplacement?.()
      detach?.()
      engine.destroy()
    }
  })
})
