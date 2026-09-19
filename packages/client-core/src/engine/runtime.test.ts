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

import type {
  GitRepositoryWire,
  HostMetricsWire,
  IssueProjection,
  IssueWire,
  SessionId,
  SessionMeta,
  SessionMetaInput,
} from '@podium/model'
import {
  asArtifactId,
  asIssueId,
  asMachineId,
  asMutationId,
  asSessionId,
  asUserId,
} from '@podium/model'
import { createElement, Profiler, act, useSyncExternalStore } from 'react'
import { render } from '@testing-library/react'
import { createSlicePublisher } from '../viewmodels/slices/publish'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { PodiumClientApi } from '../api'
import { asClientPrincipal } from '../principal'
import { issueViewModelsFromReplica } from '../replica/issue-view-models'
import { createReplica, memoryStorage, type StorageApi } from '../replica/replica'
import type { SocketHub } from '../socket-transport'
import { type Router, routeDefaults, type RouterWindow, SIDEBAR_COLLAPSED_KEY, SUPERAGENT_MODE_KEY } from '../ui-state'
import { allTabIds } from '../viewmodels'
import { sessionById } from '../session-index'
import { readStoreStats, storeStats } from '../perf/store-stats'
import { Reactions } from './reactions'
import type { EngineState } from './state'
import { foldOverlays, insertOverlay, type OverlayEntity } from './overlay'
import type { OptimismLedger } from './optimism'
import { COARSE_CLOCK_MS, createClientRuntime } from './runtime'

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

function session(id: string, cwd: string): SessionMeta {
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
  } as unknown as SessionMeta
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
    pins: {
      list: { query: async () => ({ panels: [], worktrees: [], repos: [] }) },
      set: { mutate: async () => ({ panels: [], worktrees: [], repos: [] }) },
    },
    superagent: {
      listThreads: {
        query: vi.fn(async () => [{ id: 'global', kind: 'global' as const }]),
      },
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

function makeEngine(
  opts: {
    url?: string
    api?: unknown
    hub?: FakeHub
    storage?: StorageApi
    spawnConfirmGraceMs?: number
    workspacePruneGraceMs?: number
    draftSendDebounceMs?: number
    draftPersistDebounceMs?: number
    principal?: string
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
    notices: { error: (m) => errors.push(m), info: () => {} },
    createReplicaFn: () => createReplica({ storage: opts.storage ?? memoryStorage() }),
    routerWindow: rw.win,
    createHub: () => hub as unknown as SocketHub,
    ...(opts.spawnConfirmGraceMs !== undefined
      ? { spawnConfirmGraceMs: opts.spawnConfirmGraceMs }
      : {}),
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
  return { engine, hub, rw, fatals, errors }
}

// ---------------------------------------------------------------- tests

describe('engine replica construction (POD-1239)', () => {
  it('refuses to construct without a replica factory instead of adopting ambient storage', () => {
    // The engine used to fall back to `createReplica()` with no argument, which
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
    const replica = createReplica({ storage: memoryStorage() })
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

describe('replicated layout routing', () => {
  it('each real legacy setter enqueues exactly one canonical layout command', async () => {
    const dock = makeEngine()
    dock.engine.getSnapshot().setDockTab('git')
    await settle()
    expect(dock.engine.outbox.pending()).toMatchObject([
      { kind: 'layoutSet', input: { values: { dockTab: 'git' } } },
    ])
    dock.engine.dispose()

    const superPanel = makeEngine()
    superPanel.engine.getSnapshot().setSuperOpen(false)
    await settle()
    expect(superPanel.engine.outbox.pending()).toMatchObject([
      { kind: 'layoutSet', input: { values: { superOpen: '0' } } },
    ])
    superPanel.engine.dispose()

    const panelMode = makeEngine()
    panelMode.engine.getSnapshot().setPanelMode(asSessionId('session-1'), 'native')
    await settle()
    expect(panelMode.engine.outbox.pending()).toMatchObject([
      {
        kind: 'layoutSet',
        input: {
          values: { panelMode: JSON.stringify({ 'session-1': 'native' }) },
        },
      },
    ])
    panelMode.engine.dispose()
  })
})

describe('engine lifecycle', () => {
  it('keeps the persisted slice mounted when boot enrichments are offline', async () => {
    const api = makeApi()
    const offline = async (): Promise<never> => {
      throw new TypeError('Failed to fetch')
    }
    api.discovery.refreshRepos.mutate = offline
    api.pins.list.query = offline
    api.tabs.listOrders.query = offline
    api.settings.get.query = offline
    const { engine, fatals } = makeEngine({ api })

    engine.start()
    await settle()

    expect(fatals).toEqual([])
    expect(engine.getSnapshot().reposLoaded).toBe(true)
    engine.dispose()
  })

  it('publishes one machine snapshot for duplicate bursts and reporting clock changes', async () => {
    const { engine, hub } = makeEngine()
    engine.start()
    await settle()
    const publish = vi.fn()
    const machinePublish = vi.fn()
    let previousMachines = engine.getSnapshot().machines
    engine.subscribe(() => {
      publish()
      const machines = engine.getSnapshot().machines
      if (machines !== previousMachines) machinePublish()
      previousMachines = machines
    })
    const machine = {
      id: 'machine-a', online: true, lastSeenAt: 'before', buildReportedAt: 'before',
      services: { server: { state: 'available', observedAt: 'before' },
        agentExecution: { state: 'available', observedAt: 'before' } },
    }
    hub.emit('machines', [machine])
    const snapshot = engine.getSnapshot()
    // The scope change also publishes reposLoading; count machine publications
    // separately, then require duplicate/clock frames to publish nothing at all.
    expect(machinePublish).toHaveBeenCalledTimes(1)
    publish.mockClear()
    hub.emit('machines', [structuredClone(machine)])
    hub.emit('machines', [{ ...machine, lastSeenAt: 'after', buildReportedAt: 'after',
      services: { server: { observedAt: 'after', state: 'available' },
        agentExecution: { observedAt: 'after', state: 'available' } } }])
    expect(publish).not.toHaveBeenCalled()
    expect(engine.getSnapshot()).toBe(snapshot)
    engine.dispose()
    engine.start()
    publish.mockClear()
    hub.emit('machines', [structuredClone(machine)])
    expect(publish).toHaveBeenCalledTimes(1)
    engine.dispose()
  })

  it.each([
    ['online', { online: false }],
    ['inventory revision', { inventory: { rev: 2 } }],
    ['harness versions', { harnessVersions: [{ harness: 'codex', version: '2' }] }],
    ['use', { use: 'denied' }],
    ['caps', { deliveryCaps: ['new-cap'] }],
    ['crash ownership', { services: { crashOwner: 'supervisor' } }],
    ['unknown future field', { futureField: { value: 2 } }],
    ['unknown timestamp', { futureAt: 'later' }],
    ['revocation', { revokedAt: 'later' }],
  ])('publishes material machine changes: %s', async (_name, patch) => {
    const { engine, hub } = makeEngine()
    engine.start()
    await settle()
    const machine = { id: 'machine-a', online: true }
    hub.emit('machines', [machine])
    const publish = vi.fn()
    engine.subscribe(publish)
    hub.emit('machines', [{ ...machine, ...patch }])
    expect(publish).toHaveBeenCalledTimes(1)
    engine.dispose()
  })

  it('ignores membership order but publishes additions and removals', async () => {
    const { engine, hub } = makeEngine()
    engine.start()
    await settle()
    const a = { id: 'a', online: true }
    const b = { id: 'b', online: true }
    hub.emit('machines', [a, b])
    const publish = vi.fn()
    engine.subscribe(publish)
    hub.emit('machines', [b, a])
    expect(publish).not.toHaveBeenCalled()
    hub.emit('machines', [a])
    hub.emit('machines', [a, b])
    expect(publish).toHaveBeenCalledTimes(2)
    engine.dispose()
  })

  it('forgets the hub comparison when a repo refresh replaces machines', async () => {
    const { engine, hub } = makeEngine()
    engine.start()
    await settle()
    const machine = { id: 'a', online: true }
    hub.emit('machines', [machine])
    // The scope-triggered refresh returns an empty machine list.
    await settle()
    expect(engine.getSnapshot().machines).toEqual([])
    hub.emit('machines', [machine])
    expect(engine.getSnapshot().machines).toEqual([machine])
    engine.dispose()
  })

  it('refreshes an authorized repo snapshot when a machine event keeps the same online count', async () => {
    const api = makeApi()
    const { engine, hub } = makeEngine({ api })
    engine.start()
    await settle()
    api.discovery.refreshRepos.mutate.mockClear()

    hub.emit('machines', [
      { id: asMachineId('daemon-before-restart'), online: true, name: 'before' },
    ])
    await settle()
    api.discovery.refreshRepos.mutate.mockClear()

    // A rebound daemon replacing the prior visible machine leaves the online
    // count at one. The old count-rise heuristic skipped this invalidation and
    // could leave the worklist joined against the wrong machine snapshot.
    hub.emit('machines', [
      { id: asMachineId('daemon-after-restart'), online: true, name: 'after' },
    ])
    await settle()

    expect(api.discovery.refreshRepos.mutate).toHaveBeenCalledTimes(1)
    engine.dispose()
  })

  it('does not supersede repo refreshes for machine metadata-only broadcasts', async () => {
    const api = makeApi()
    const { engine, hub } = makeEngine({ api })
    engine.start()
    await settle()
    api.discovery.refreshRepos.mutate.mockClear()

    const machineId = asMachineId('rebound-daemon')
    hub.emit('machines', [{ id: machineId, online: true, name: 'before inventory' }])
    await settle()
    api.discovery.refreshRepos.mutate.mockClear()

    // Inventory/build reporting broadcasts the full machine projection after
    // reattach without changing which machine is visible or reachable. It must
    // update the machine paint without invalidating the authorized repo fetch.
    hub.emit('machines', [
      {
        id: machineId,
        online: true,
        name: 'after inventory',
        inventory: { agents: [] },
      },
    ])
    await settle()

    expect(api.discovery.refreshRepos.mutate).not.toHaveBeenCalled()
    expect(engine.getSnapshot().machines[0]?.name).toBe('after inventory')
    engine.dispose()
  })

  it('refreshes repos when use is revoked without changing machine identity or liveness', async () => {
    const api = makeApi()
    const { engine, hub } = makeEngine({ api })
    engine.start()
    await settle()
    api.discovery.refreshRepos.mutate.mockClear()

    const machineId = asMachineId('shared-daemon')
    hub.emit('machines', [
      { id: machineId, online: true, name: 'shared daemon', use: 'granted' },
    ])
    await settle()
    api.discovery.refreshRepos.mutate.mockClear()

    // The machine remains visible and online, but filesystem scan authority is
    // gone. The authorized repo snapshot must be recomputed under that denial.
    hub.emit('machines', [
      { id: machineId, online: true, name: 'shared daemon', use: 'denied' },
    ])
    await settle()

    expect(api.discovery.refreshRepos.mutate).toHaveBeenCalledTimes(1)
    engine.dispose()
  })

  it("publishes the signed-in user's superagent threads at boot (POD-330)", async () => {
    // The view used to fetch this list itself and hold it in useState. It is
    // store state now, so boot must actually load it — a store field nobody
    // fills is the same bug as the mirror, one layer down.
    const api = makeApi()
    const { engine } = makeEngine({ api })
    engine.start()
    await settle()
    expect(api.superagent.listThreads.query).toHaveBeenCalled()
    expect(engine.getSnapshot().superThreads).toEqual([{ id: 'global', kind: 'global' }])
    engine.dispose()
  })

  it('keeps serving the persisted world when the thread list is offline', async () => {
    const api = makeApi()
    api.superagent.listThreads.query = async (): Promise<never> => {
      throw new TypeError('Failed to fetch')
    }
    const { engine, fatals } = makeEngine({ api })
    engine.start()
    await settle()
    // An empty list, not a fatal and not a spinner: boot enrichments are not the
    // source of truth for the principal slice.
    expect(fatals).toEqual([])
    expect(engine.getSnapshot().superThreads).toEqual([])
    engine.dispose()
  })

  it('start is idempotent; dispose→start re-arms subscriptions (StrictMode)', async () => {
    const { engine, hub, fatals } = makeEngine()
    engine.start()
    engine.start() // double-start must not double-subscribe
    expect(hub.onCalls.filter((k) => k === 'hostMetrics')).toHaveLength(1)
    await settle()
    engine.dispose()
    engine.dispose() // double-dispose must not throw
    expect(hub.subscribed('hostMetrics')).toBe(0)
    engine.start() // re-start after dispose re-arms everything
    await settle()
    expect(hub.subscribed('hostMetrics')).toBe(1)
    const metrics = [{ hostId: 'h1' }] as unknown as HostMetricsWire[]
    hub.emit('hostMetrics', metrics)
    expect(engine.hostMetrics.getSnapshot()).toBe(metrics)
    engine.dispose()
    expect(fatals).toEqual([])
  })
})

describe('session resurrection', () => {
  it('reports a rejected resurrection instead of silently swallowing it', async () => {
    const api = makeApi()
    api.sessions.resurrect = {
      mutate: vi.fn(async () => ({ ok: false, reason: 'worktree unavailable' })),
    }
    const { engine, errors } = makeEngine({ api })

    await engine.getSnapshot().resurrectSession(asSessionId('sleeping'))

    expect(errors).toEqual(["Couldn't resume the session — worktree unavailable"])
  })

  it('reports a resurrection transport failure', async () => {
    const api = makeApi()
    api.sessions.resurrect = {
      mutate: vi.fn(async () => {
        throw new Error('server offline')
      }),
    }
    const { engine, errors } = makeEngine({ api })

    await engine.getSnapshot().resurrectSession(asSessionId('sleeping'))

    expect(errors).toEqual(["Couldn't resume the session — server offline"])
  })
})

describe('single URL writer (React #185 regression, engine-level)', () => {
  it('an unknown ?wt deep link settles on the known fallback without ping-pong', async () => {
    const { engine, rw, fatals } = makeEngine({
      url: '/workspace?wt=%2Fhome%2Fnobody%2Fgone&pane=00000000-0000-0000-0000-000000000000',
    })
    let notifications = 0
    engine.subscribe(() => {
      notifications++
      if (notifications > 200) throw new Error(`update loop: ${notifications} notifications`)
    })
    engine.start()
    await settle(40)
    const snap = engine.getSnapshot()
    expect(snap.view).toBe('workspace')
    // The unknown worktree cannot be shown; the selection settles on the one
    // known worktree (a deterministic fallback, not a loop) …
    expect(snap.selectedWorktree).toBe('/tmp/known-repo')
    // … and the settled state is mirrored back into the URL.
    expect(rw.url()).toContain('wt=%2Ftmp%2Fknown-repo')
    // Fully settled: no further URL writes after quiescence.
    const writesAfterSettle = rw.writes.length
    await settle(40)
    expect(rw.writes.length).toBe(writesAfterSettle)
    expect(fatals).toEqual([])
    engine.dispose()
  })

  it('back/forward (popstate) to an unknown wt converges with exactly one mirror write', async () => {
    const { engine, rw, fatals } = makeEngine({ url: '/workspace?wt=%2Ftmp%2Fknown-repo' })
    engine.start()
    await settle(40)
    expect(engine.getSnapshot().selectedWorktree).toBe('/tmp/known-repo')
    const before = rw.writes.length
    // Simulate back/forward to a workspace URL whose wt doesn't exist — the
    // scenario that ping-ponged the old two-effect design into React #185.
    rw.popTo('/workspace?wt=%2Ftmp%2Fother&pane=s1')
    await settle(40)
    const snap = engine.getSnapshot()
    // The pane is adopted (Workspace holds/clears unknown panes safely) …
    expect(snap.paneA).toBe('s1')
    // … while the unknown worktree settles on the known fallback, mirrored into
    // the URL exactly once.
    expect(snap.selectedWorktree).toBe('/tmp/known-repo')
    expect(rw.url()).toContain('wt=%2Ftmp%2Fknown-repo')
    expect(rw.writes.length - before).toBe(1)
    expect(fatals).toEqual([])
    engine.dispose()
  })

  it('settles when there are no known worktrees at all', async () => {
    const api = makeApi()
    api.discovery.refreshRepos.mutate = vi.fn(async () => ({ repositories: [], diagnostics: [], machines: [] }))
    const { engine, fatals } = makeEngine({ url: '/workspace?wt=%2Fgone&pane=dead', api })
    let notifications = 0
    engine.subscribe(() => {
      notifications++
      if (notifications > 200) throw new Error('update loop')
    })
    engine.start()
    await settle(40)
    expect(engine.getSnapshot().view).toBe('workspace')
    expect(fatals).toEqual([])
    engine.dispose()
  })
})

/**
 * The tab that names nothing (POD-710 review, item 1).
 *
 * `pruneWorkspace` shipped with no production caller, so a workspace could hold
 * an id no session or file answered to — a stale `?pane=` bookmark, a session
 * killed elsewhere — and nothing ever removed it: the strip filtered it out, the
 * pane rendered nothing, and it was persisted and restored on every reload with
 * no gesture that could clear it.
 */
describe('stale workspace tabs (POD-710)', () => {
  const openTabIds = (engine: ReturnType<typeof makeEngine>['engine']): string[] =>
    Object.values(engine.getSnapshot().workspaces).flatMap((ws) =>
      Object.values(ws.panes).flatMap((pane) => pane.tabs),
    )

  it('retires a tab that never resolves, once its grace period is up', async () => {
    const { engine, rw } = makeEngine({
      url: '/workspace?wt=%2Ftmp%2Fknown-repo',
      workspacePruneGraceMs: 150,
    })
    engine.start()
    await settle(40)

    rw.popTo('/workspace?wt=%2Ftmp%2Fknown-repo&pane=ghost')
    await settle(30)
    // ADOPTED FIRST. An id that has not arrived yet is early, not gone — an
    // eager prune here is what would break optimistic spawns and deep links.
    expect(openTabIds(engine)).toContain('ghost')
    expect(engine.getSnapshot().paneA).toBe('ghost')

    await settle(200)
    expect(openTabIds(engine)).not.toContain('ghost')
    expect(engine.getSnapshot().paneA).toBeNull()
    engine.dispose()
  })

  it('drops a rehomed session from the origin workspace immediately', async () => {
    const { engine } = makeEngine({ url: '/workspace', workspacePruneGraceMs: 5_000 })
    engine.start()
    await settle(40)
    const oldId = asIssueId('iss_old')
    const newId = asIssueId('iss_new')
    engine.replica.applySnapshot('sessions', [
      { ...session('s1', '/tmp/known-repo'), issueId: oldId },
    ])
    await settle(30)
    engine.getSnapshot().setSelectedIssueId(oldId)
    engine.getSnapshot().openSessionTab(asSessionId('s1'), { permanent: true })
    await settle(20)
    const oldKey = engine.getSnapshot().workspaceKey()
    expect(oldKey).toBe(`issue:${oldId}`)
    expect(openTabIds(engine)).toContain('s1')

    engine.replica.applyChanges(
      'sessions',
      [{ ...session('s1', '/tmp/known-repo'), issueId: newId }],
      [],
    )
    await settle(30)
    const st = engine.getSnapshot()
    expect(st.workspaces[oldKey] ? allTabIds(st.workspaces[oldKey]!) : []).not.toContain('s1')
    expect(st.selectedIssueId).toBe(newId)
    expect(openTabIds(engine)).toContain('s1')
    engine.dispose()
  })

  it('keeps a tab whose session arrives inside the grace window', async () => {
    const { engine, rw } = makeEngine({
      url: '/workspace?wt=%2Ftmp%2Fknown-repo',
      workspacePruneGraceMs: 150,
    })
    engine.start()
    await settle(40)

    rw.popTo('/workspace?wt=%2Ftmp%2Fknown-repo&pane=late')
    await settle(30)
    engine.replica.applyChanges('sessions', [session('late', '/tmp/known-repo')], [])

    await settle(200)
    expect(openTabIds(engine)).toContain('late')
    expect(engine.getSnapshot().paneA).toBe('late')
    engine.dispose()
  })
})

/**
 * FILE TABS SURVIVE THE VISIT (POD-1247).
 *
 * The layouts always persisted tab IDS; the file RECORDS they name did not, so
 * every file tab came back naming nothing and was swept as a ghost. Reopening a
 * file was the only way to get it back, and only if you remembered which.
 */
describe('file tabs across a reload (POD-1247)', () => {
  const layoutTabIds = (engine: ReturnType<typeof makeEngine>['engine']): string[] =>
    Object.values(engine.getSnapshot().workspaces).flatMap((ws) =>
      Object.values(ws.panes).flatMap((pane) => pane.tabs),
    )

  it('restores the open file and its tab from device storage', async () => {
    const storage = memoryStorage()
    const first = makeEngine({ url: '/workspace', storage })
    first.engine.start()
    await settle(40)
    first.engine.getSnapshot().openFileInWorktree({
      root: '/tmp/known-repo/.worktrees/wt1',
      path: 'notes.md',
    })
    await settle(30)
    const tabId = 'file:w:/tmp/known-repo/.worktrees/wt1:notes.md'
    expect(first.engine.getSnapshot().fileTabs.map((t) => t.id)).toEqual([tabId])
    first.engine.dispose()

    // The reload: a fresh engine over the same device storage.
    const second = makeEngine({ url: '/workspace', storage })
    second.engine.start()
    await settle(40)
    const st = second.engine.getSnapshot()
    expect(st.fileTabs.map((t) => t.id)).toEqual([tabId])
    expect(st.fileTabs[0]?.path).toBe('notes.md')
    expect(st.fileTabs[0]?.scope).toEqual({
      kind: 'worktree',
      root: '/tmp/known-repo/.worktrees/wt1',
    })
    expect(layoutTabIds(second.engine)).toContain(tabId)
    second.engine.dispose()
  })

  it('publishes deletion of a session restored before the row subscription', async () => {
    const storage = memoryStorage()
    const first = makeEngine({ storage })
    await first.engine.replica.hydrate()
    first.engine.replica.applySnapshot('sessions', [session('s1', '/tmp/known-repo')])
    await first.engine.replica.flush()
    first.engine.destroy()

    const second = makeEngine({ storage })
    try {
      expect(second.engine.getSnapshot().sessions.map((s) => s.sessionId)).toEqual(['s1'])
      second.engine.start()
      await second.engine.replica.hydrate()
      // No inserted row has passed through this engine's subscription. Removing
      // the cached row must still publish, or file retirement never sees absence.
      second.engine.replica.applySnapshot('sessions', [])
      expect(second.engine.replica.rows('sessions')).toEqual([])
      expect(second.engine.getSnapshot().sessions).toEqual([])
    } finally {
      second.engine.destroy()
    }
  })

  it('retires a restored file tab whose session never comes back', async () => {
    const storage = memoryStorage()
    const first = makeEngine({ url: '/workspace', storage, workspacePruneGraceMs: 150 })
    first.engine.start()
    await settle(40)
    first.engine.replica.applySnapshot('sessions', [session('s1', '/tmp/known-repo')])
    await settle(30)
    first.engine.getSnapshot().openFile(asSessionId('s1'), 'notes.md')
    await settle(30)
    const tabId = 'file:s:s1:notes.md'
    expect(first.engine.getSnapshot().fileTabs.map((t) => t.id)).toEqual([tabId])
    first.engine.dispose()

    // Reload, and the feed says the session is gone — killed from the CLI, or
    // from another device. The record alone must not keep the tab alive:
    // nothing can ever read the file through a session that no longer exists.
    const second = makeEngine({ url: '/workspace', storage, workspacePruneGraceMs: 150 })
    second.engine.start()
    await settle(40)
    expect(second.engine.getSnapshot().fileTabs.map((t) => t.id)).toEqual([tabId])
    second.engine.replica.applySnapshot('sessions', [])
    await settle(250)
    expect(second.engine.getSnapshot().fileTabs).toEqual([])
    expect(layoutTabIds(second.engine)).not.toContain(tabId)
    second.engine.dispose()
  })
})

describe('snapshot stability (useSyncExternalStore contract)', () => {
  it('getSnapshot keeps identity when nothing changed and across no-op writes', async () => {
    const { engine } = makeEngine()
    engine.start()
    await settle(40)
    const a = engine.getSnapshot()
    expect(engine.getSnapshot()).toBe(a)
    // A real change produces a new snapshot …
    a.setSessionDraft(asSessionId('s1'), 'x')
    const b = engine.getSnapshot()
    expect(b).not.toBe(a)
    expect(b.drafts).toEqual({ s1: 'x' })
    // … but re-writing the SAME value is a no-op that keeps identity.
    b.setSessionDraft(asSessionId('s1'), 'x')
    expect(engine.getSnapshot()).toBe(b)
    // Action identities are stable across snapshots.
    expect(b.setSessionDraft).toBe(a.setSessionDraft)
    expect(b.markSessionRead).toBe(a.markSessionRead)
    engine.dispose()
  })
})

describe('replica snapshot coalescing (#262 review)', () => {
  it('a snapshot replacing the sole session anchoring an unregistered worktree keeps the selection with zero URL writes', async () => {
    const { engine, rw, fatals } = makeEngine({ url: '/workspace' })
    engine.start()
    await settle(40) // repos loaded → fallback selected /tmp/known-repo
    // A session anchors an UNREGISTERED worktree; the user selects it.
    engine.replica.applyChanges('sessions', [session('s1', '/x/unregistered')], [])
    engine.getSnapshot().setSelectedWorktree('/x/unregistered')
    await settle()
    expect(engine.getSnapshot().selectedWorktree).toBe('/x/unregistered')
    expect(rw.url()).toContain('wt=%2Fx%2Funregistered')
    const writesBefore = rw.writes.length
    // ONE metadata snapshot replaces s1 with s2 in the same worktree. The
    // replica applies this as separate delete + upsert transactions; the
    // engine's reactions must only observe the FINAL state — the transient
    // empty list used to trip the worktree fallback (selection yanked to
    // /tmp/known-repo) plus a URL rewrite the upsert couldn't undo.
    engine.replica.applySnapshot('sessions', [session('s2', '/x/unregistered')])
    await settle()
    const snap = engine.getSnapshot()
    expect(snap.sessions.map((s) => s.sessionId)).toEqual(['s2'])
    expect(snap.selectedWorktree).toBe('/x/unregistered')
    expect(rw.writes.length).toBe(writesBefore) // zero URL writes
    expect(fatals).toEqual([])
    engine.dispose()
  })
})

describe('constructor snapshot seeding (#262 review)', () => {
  it('first getSnapshot() already carries the replica rows, before start()', async () => {
    // A previous app session persisted rows into (shared, memory-backed) storage.
    const storage = memoryStorage()
    const previous = createReplica({ storage })
    previous.applySnapshot('sessions', [session('s-seeded', '/w')])
    await settle()
    // Constructing the engine over a replica on that storage must expose the
    // rows in the VERY FIRST snapshot — no start(), no microtask (the old
    // useReplicaRows path had them at first render; mobile flashed "not found"
    // when they only arrived via start()).
    const { engine } = makeEngine({ storage })
    expect(engine.getSnapshot().sessions.map((s) => s.sessionId)).toEqual(['s-seeded'])
    engine.dispose()
  })

  it('first read of a replicated layout key already carries the stored value (POD-571)', async () => {
    // The same claim as above, for the slice that decides what the shell MOUNTS.
    // Layout was network-only: the controller started empty and filled from
    // `api.layout.get.query()`, so the shell painted its default branch — an
    // expanded sidebar, an open Flight Deck — until the server answered, and
    // kept painting it for the whole session when the fetch failed offline.
    //
    // This asserts the WIRING, not the controller: `makeEngine`'s api never
    // resolves a layout snapshot into this read, and there is no `await` and no
    // `start()` before the assertion. Deleting `layoutSeed` from `createActions`
    // fails here and nowhere else — the controller's own tests construct it with
    // a seed directly and stay green either way.
    const storage = memoryStorage()
    const previous = createReplica({ storage })
    previous.applySnapshot('userLayouts', [
      { userId: asUserId('operator'), key: 'sidebar.collapsed', value: 'true' },
      { userId: asUserId('operator'), key: 'superagent.mode', value: 'folded' },
    ])
    await settle()

    const { engine } = makeEngine({ storage })
    expect(engine.ui.get(SIDEBAR_COLLAPSED_KEY)).toBe('true')
    expect(engine.ui.get(SUPERAGENT_MODE_KEY)).toBe('folded')
    engine.dispose()
  })
})

// ---------------------------------------------------------------------------
// ONE optimistic mechanism (#263): the outbox IS the overlay. Retirement rule
// under test (engine/overlay.ts): an overlay retires exactly once, when its
// mutation resolved AND covering server truth landed in the replica — or drops
// immediately on definitive failure (+ notice).
// ---------------------------------------------------------------------------
describe('unified optimistic overlay (#263)', () => {
  const nameOf = (e: ReturnType<typeof makeEngine>['engine'], id: string): string | undefined =>
    e.getSnapshot().sessions.find((s) => s.sessionId === id)?.name

  it('a pending mutation survives replica snapshots lacking its effect, then retires exactly once when truth lands', async () => {
    const api = makeApi()
    let resolveRename: (() => void) | undefined
    api.sessions.rename.mutate = vi.fn(
      () =>
        new Promise<Record<string, never>>((r) => {
          resolveRename = () => r({})
        }),
    )
    const { engine } = makeEngine({ api })
    engine.start()
    await settle(40)
    engine.replica.applyChanges('sessions', [session('s1', '/w')], [])
    await settle()

    // Enqueue paints instantly — the queued entry is the overlay.
    void engine.getSnapshot().renameSession(asSessionId('s1'), 'renamed')
    expect(nameOf(engine, 's1')).toBe('renamed')

    // A heal snapshot WITHOUT the rename must not flash the stale value: the
    // replica stays server-truth (no name), the overlay keeps painting.
    engine.replica.applySnapshot('sessions', [session('s1', '/w')])
    await settle()
    expect(nameOf(engine, 's1')).toBe('renamed')
    expect(engine.replica.rows('sessions')[0]?.name).toBeUndefined()

    // The mutation resolves; the entry leaves the queue but truth hasn't
    // landed — the overlay moves to the awaiting-truth stage, still painting.
    resolveRename?.()
    await settle()
    expect(engine.getSnapshot().outboxSize).toBe(0)
    expect(nameOf(engine, 's1')).toBe('renamed')

    // Covering truth lands (the server echo) — retired, value unchanged.
    engine.replica.applySnapshot('sessions', [{ ...session('s1', '/w'), name: 'renamed' }])
    await settle()
    expect(nameOf(engine, 's1')).toBe('renamed')

    // Exactly once: a LATER server change shows through (no lingering mask).
    engine.replica.applySnapshot('sessions', [{ ...session('s1', '/w'), name: 'server-wins' }])
    await settle()
    expect(nameOf(engine, 's1')).toBe('server-wins')
    engine.dispose()
  })

  // POD-1110 — the behaviour this issue exists for, end to end on the engine:
  // dismissing an offer while the write cannot go out must leave the bar GONE.
  it('an offer dismissal that cannot be sent keeps the offer hidden, and stays queued', async () => {
    const offerOf = (e: ReturnType<typeof makeEngine>['engine'], id: string) =>
      e.getSnapshot().sessions.find((s) => s.sessionId === id)?.offer
    const offer = { message: 'Ready to merge', actions: [], createdAt: 'T1' }
    const api = makeApi()
    let attempts = 0
    api.sessions.dismissOffer.mutate = vi.fn(async () => {
      attempts++
      if (attempts === 1) throw new Error('network down') // non-poison → the entry waits
      return {}
    })
    const hub = new FakeHub() // health starts 'down'
    const { engine } = makeEngine({ api, hub })
    engine.start()
    await settle(40)
    engine.replica.applyChanges('sessions', [{ ...session('s1', '/w'), offer }], [])
    await settle()
    expect(offerOf(engine, 's1')).toEqual(offer)

    void engine.getSnapshot().dismissOffer(asSessionId('s1'), 'T1')
    await settle()

    // Gone on the click, and STILL gone after a heal snapshot that carries the
    // offer — server truth has not moved, so the queued entry keeps painting.
    // This is the whole bug: it used to un-hide and toast instead.
    expect(offerOf(engine, 's1')).toBeUndefined()
    engine.replica.applySnapshot('sessions', [{ ...session('s1', '/w'), offer }])
    await settle()
    expect(offerOf(engine, 's1')).toBeUndefined()
    expect(engine.getSnapshot().outboxSize).toBe(1)

    // The connection comes back: the queued dismissal drains, the server clears
    // the offer, and the overlay retires against that covering truth.
    hub.emit('connectionHealth', { status: 'ok', rttMs: 5, since: 1 })
    await settle()
    expect(attempts).toBe(2)
    engine.replica.applySnapshot('sessions', [session('s1', '/w')])
    await settle()
    expect(offerOf(engine, 's1')).toBeUndefined()
    expect(engine.getSnapshot().outboxSize).toBe(0)

    // Exactly once: a NEW offer the agent posts later shows through.
    const next = { message: 'Ready to land', actions: [], createdAt: 'T2' }
    engine.replica.applySnapshot('sessions', [{ ...session('s1', '/w'), offer: next }])
    await settle()
    expect(offerOf(engine, 's1')).toEqual(next)
    engine.dispose()
  })

  it('after resolution, truth that DIVERGES from the prediction retires the overlay (server wins)', async () => {
    const api = makeApi()
    const { engine } = makeEngine({ api })
    engine.start()
    await settle(40)
    engine.replica.applyChanges('sessions', [session('s1', '/w')], [])
    await settle()
    void engine.getSnapshot().renameSession(asSessionId('s1'), 'mine')
    await settle() // resolves (default executor) → awaiting truth
    expect(engine.getSnapshot().outboxSize).toBe(0)
    expect(nameOf(engine, 's1')).toBe('mine')
    // A competing client's rename won — the row moved past the resolution
    // fingerprint without covering our mutation. Server truth must win.
    engine.replica.applySnapshot('sessions', [{ ...session('s1', '/w'), name: 'theirs' }])
    await settle()
    expect(nameOf(engine, 's1')).toBe('theirs')
    engine.dispose()
  })

  it('two pending mutations on the same entity compose in queue order', async () => {
    const api = makeApi()
    api.sessions.rename.mutate = vi.fn(async () => {
      throw new Error('network down') // non-poison → both entries stay queued
    })
    api.sessions.markUnread.mutate = vi.fn(async () => {
      throw new Error('network down')
    })
    const { engine } = makeEngine({ api })
    engine.start()
    await settle(40)
    engine.replica.applyChanges('sessions', [session('s1', '/w')], [])
    await settle()
    void engine.getSnapshot().renameSession(asSessionId('s1'), 'first')
    void engine.getSnapshot().markSessionUnread(asSessionId('s1'))
    void engine.getSnapshot().renameSession(asSessionId('s1'), 'second')
    await settle()
    const row = engine.getSnapshot().sessions.find((s) => s.sessionId === 's1')
    // Later rename wins over the earlier one; the mark-unread composes with it.
    expect(row?.name).toBe('second')
    expect(row?.unread).toBe(true)
    expect(engine.getSnapshot().outboxSize).toBe(3)
    engine.dispose()
  })

  it('a definitively rejected mutation drops its overlay and surfaces a notice', async () => {
    const api = makeApi()
    api.sessions.rename.mutate = vi.fn(async () => {
      throw Object.assign(new Error('bad input'), {
        data: { code: 'BAD_REQUEST', httpStatus: 400 },
      })
    })
    const { engine, errors } = makeEngine({ api })
    engine.start()
    await settle(40)
    engine.replica.applyChanges('sessions', [session('s1', '/w')], [])
    await settle()
    void engine.getSnapshot().renameSession(asSessionId('s1'), 'doomed')
    expect(nameOf(engine, 's1')).toBe('doomed') // painted while queued
    await settle()
    expect(nameOf(engine, 's1')).toBeUndefined() // poison drop → overlay gone
    expect(engine.getSnapshot().outboxSize).toBe(0)
    expect(engine.getSnapshot().outboxDeadLetters).toMatchObject([
      { entry: { kind: 'rename', input: { name: 'doomed' } }, reason: { code: 'invalid' } },
    ])
    expect(errors.some((m) => m.includes('rename'))).toBe(true)
    engine.dispose()
  })

  it('treats a revision reject as rollback, then repaints after an explicit rebase', async () => {
    const api = makeApi()
    let attempts = 0
    api.sessions.rename.mutate = vi.fn(async () => {
      attempts += 1
      if (attempts === 1) {
        throw Object.assign(new Error('stale revision'), {
          data: { code: 'CONFLICT', httpStatus: 409 },
        })
      }
      throw new Error('network down after rebase')
    })
    const { engine } = makeEngine({ api })
    engine.start()
    await settle(40)
    engine.replica.applyChanges('sessions', [session('s1', '/w')], [])
    await settle()

    void engine.getSnapshot().renameSession(asSessionId('s1'), 'rebased')
    expect(nameOf(engine, 's1')).toBe('rebased')
    await settle()

    const [parked] = engine.getSnapshot().outboxDeadLetters
    expect(parked?.reason).toEqual({ code: 'conflict' })
    expect(nameOf(engine, 's1')).toBeUndefined()
    expect(engine.getSnapshot().outboxSize).toBe(0)

    engine.getSnapshot().recoverOutbox.retry(parked!.entry.mutationId, { expectedRevision: 2 })
    expect(engine.getSnapshot().outboxDeadLetters).toEqual([])
    expect(nameOf(engine, 's1')).toBe('rebased')
    await settle()
    expect(attempts).toBe(2)
    expect(nameOf(engine, 's1')).toBe('rebased')
    expect(engine.getSnapshot().outboxSize).toBe(1)
    engine.dispose()
  })

  it('a queued offline write keeps painting after a reload (fresh engine, same storage)', async () => {
    const storage = memoryStorage()
    const api = makeApi()
    api.sessions.rename.mutate = vi.fn(async () => {
      throw new Error('offline')
    })
    const first = makeEngine({ api, storage })
    first.engine.start()
    await settle(40)
    first.engine.replica.applyChanges('sessions', [session('s1', '/w')], [])
    await settle()
    void first.engine.getSnapshot().renameSession(asSessionId('s1'), 'renamed')
    await settle()
    expect(nameOf(first.engine, 's1')).toBe('renamed')
    first.engine.dispose()
    // "Reload": the durable queue IS the overlay — the very FIRST snapshot of a
    // fresh engine over the same storage paints it, before start().
    const second = makeEngine({ api, storage })
    expect(nameOf(second.engine, 's1')).toBe('renamed')
    // …and the replica itself stayed server truth only.
    expect(second.engine.replica.rows('sessions')[0]?.name).toBeUndefined()
    second.engine.dispose()
  })

  it('markIssueRead paints the issue-row cursor instantly and reconciles without flicker', async () => {
    const api = makeApi()
    const { engine } = makeEngine({ api })
    engine.start()
    await settle(40)
    const projection = {
      id: 'iss_1',
      seq: 1,
      title: 'Issue',
      description: { value: '' },
      stage: 'in_progress',
      updatedAt: '2026-07-01T00:00:00.000Z',
      createdAt: '2026-07-01T00:00:00.000Z',
      archived: false,
      priority: 2,
      type: 'task',
      intentOrigin: 'human',
      audience: 'human',
      isDraftVessel: false,
    } as unknown as IssueProjection
    const issue = {
      id: 'iss_1',
      readAt: null,
      updatedAt: projection.updatedAt,
    } as IssueWire
    const derivedUnread = (): boolean | undefined =>
      issueViewModelsFromReplica(
        engine.replica,
        engine.getSnapshot().issueProjections,
        engine.getSnapshot().issues,
      ).get('iss_1')?.unread
    engine.replica.applyChanges('issueProjections', [projection], [])
    engine.replica.applyChanges('issues', [issue], [])
    await settle()
    expect(engine.getSnapshot().issues[0]?.readAt).toBeNull()
    expect(derivedUnread()).toBe(true)
    void engine.getSnapshot().markIssueRead('iss_1')
    expect(engine.getSnapshot().issues[0]?.readAt).not.toBeNull() // instant
    expect(derivedUnread()).toBe(false) // the same overlaid row drives unread
    await settle() // mutation resolves → awaiting truth, still painted
    expect(engine.getSnapshot().issues[0]?.readAt).not.toBeNull()
    expect(derivedUnread()).toBe(false)
    // Echo: the server's own readAt clock differs from the client stamp; any
    // non-null readAt on the persisted issue row covers the optimistic overlay.
    engine.replica.applyChanges(
      'issues',
      [{ ...issue, readAt: '2026-07-09T00:00:00.000Z' } as typeof issue],
      [],
    )
    await settle()
    expect(engine.getSnapshot().issues[0]?.readAt).toBe('2026-07-09T00:00:00.000Z')
    expect(derivedUnread()).toBe(false) // persist echo covers without a bounce
    expect(engine.getSnapshot().issueProjections).toHaveLength(1)
    engine.dispose()
  })

  // POD-1053. The paint used to wait on an IndexedDB commit, and then the
  // durable entry re-projected its overlay from the KERNEL's clock — so the
  // press painted one `readAt` and the commit painted a slightly different one.
  // A moved cell is a new row identity and a new `store.issues` array, which
  // costs the whole worklist derivation over every issue and session. One
  // overlay, minted at the press, is what makes the second fold a no-op.
  it('paints on the press and keeps the SAME stamped value once the write is durable', async () => {
    const api = makeApi()
    const { engine } = makeEngine({ api })
    engine.start()
    await settle(40)
    const projection = {
      id: 'iss_1',
      seq: 1,
      title: 'Issue',
      description: { value: '' },
      stage: 'in_progress',
      updatedAt: '2026-07-01T00:00:00.000Z',
      createdAt: '2026-07-01T00:00:00.000Z',
      archived: false,
      priority: 2,
      type: 'task',
      intentOrigin: 'human',
      audience: 'human',
      isDraftVessel: false,
    } as unknown as IssueProjection
    const issue = { id: 'iss_1', readAt: null, updatedAt: projection.updatedAt } as IssueWire
    engine.replica.applyChanges('issueProjections', [projection], [])
    engine.replica.applyChanges('issues', [issue], [])
    await settle()

    const pending = engine.getSnapshot().markIssueRead('iss_1')
    // Synchronous with the call: nothing was awaited, so the durable enqueue
    // cannot be in front of the paint.
    const paintedAt = engine.getSnapshot().issues[0]?.readAt
    expect(paintedAt).toBeTruthy()

    await pending
    // The durable entry takes over the overlay unchanged. B11 also retains
    // the row/list identity, so no issue readers wake for the handoff.
    expect(engine.getSnapshot().issues[0]?.readAt).toBe(paintedAt)
    await settle()
    expect(engine.getSnapshot().issues[0]?.readAt).toBe(paintedAt)
    engine.dispose()
  })
})

// ---------------------------------------------------------------------------
// #263 Codex-review fixes: durable awaiting-truth (finding 1), enqueue-time
// baselines (finding 2), per-entry baselines + oldest-first escape (finding 3),
// and spawn transport-failure grace (finding 4).
// ---------------------------------------------------------------------------
describe('unified optimistic overlay (#263 review fixes)', () => {
  const nameOf = (e: ReturnType<typeof makeEngine>['engine'], id: string): string | undefined =>
    e.getSnapshot().sessions.find((s) => s.sessionId === id)?.name

  it('a resolved-but-uncovered overlay survives a reload (durable awaiting-truth), then retires when the echo lands', async () => {
    const storage = memoryStorage()
    const api = makeApi() // rename resolves immediately → awaiting truth
    const first = makeEngine({ api, storage })
    first.engine.start()
    await settle(40)
    first.engine.replica.applyChanges('sessions', [session('s1', '/w')], [])
    await settle()
    void first.engine.getSnapshot().renameSession(asSessionId('s1'), 'renamed')
    await settle()
    expect(first.engine.getSnapshot().outboxSize).toBe(0) // resolved
    expect(nameOf(first.engine, 's1')).toBe('renamed') // awaiting truth, painted
    first.engine.dispose()

    // "Reload" in the resolution→truth window: replica truth still lacks the
    // echo — the DURABLE awaiting entry must repaint from the very first
    // snapshot (memory-only staging showed stale truth here).
    const second = makeEngine({ api, storage })
    expect(nameOf(second.engine, 's1')).toBe('renamed')
    expect(second.engine.replica.rows('sessions')[0]?.name).toBeUndefined() // replica = server truth
    second.engine.start()
    await settle(40)
    expect(nameOf(second.engine, 's1')).toBe('renamed')
    // The echo lands → retired AND deleted from storage.
    second.engine.replica.applySnapshot('sessions', [{ ...session('s1', '/w'), name: 'renamed' }])
    await settle()
    expect(nameOf(second.engine, 's1')).toBe('renamed')
    expect(second.engine.outbox.awaiting()).toEqual([])
    second.engine.dispose()
    const third = makeEngine({ api, storage })
    expect(third.engine.outbox.awaiting()).toEqual([]) // durably gone
    third.engine.dispose()
  })

  it('truth landing BEFORE the mutation resolves retires the overlay at resolution — no wedge (finding 2)', async () => {
    const api = makeApi()
    let resolveRename: (() => void) | undefined
    api.sessions.rename.mutate = vi.fn(
      () =>
        new Promise<Record<string, never>>((r) => {
          resolveRename = () => r({})
        }),
    )
    const { engine } = makeEngine({ api })
    engine.start()
    await settle(40)
    engine.replica.applyChanges('sessions', [session('s1', '/w')], [])
    await settle()
    void engine.getSnapshot().renameSession(asSessionId('s1'), 'mine')
    expect(nameOf(engine, 's1')).toBe('mine')
    // A competing client's write lands while our mutation is still in flight —
    // the row is already "final" before our response arrives.
    engine.replica.applySnapshot('sessions', [{ ...session('s1', '/w'), name: 'theirs' }])
    await settle()
    expect(nameOf(engine, 's1')).toBe('mine') // still painted while queued
    resolveRename?.()
    await settle()
    // The row moved past the ENQUEUE baseline without covering the mutation:
    // competing truth won — retire at resolution instead of fingerprinting the
    // already-final row (which would never "move" again → painted forever).
    expect(nameOf(engine, 's1')).toBe('theirs')
    expect(engine.outbox.awaiting()).toEqual([])
    engine.dispose()
  })

  it('the echo for an EARLIER mutation does not retire a later one on the same field (finding 3)', async () => {
    const api = makeApi()
    const { engine } = makeEngine({ api })
    engine.start()
    await settle(40)
    engine.replica.applyChanges('sessions', [session('s1', '/w')], [])
    await settle()
    // Two rapid edits of the same field, both resolved before any echo.
    void engine.getSnapshot().renameSession(asSessionId('s1'), 'first')
    void engine.getSnapshot().renameSession(asSessionId('s1'), 'second')
    await settle()
    expect(engine.getSnapshot().outboxSize).toBe(0)
    expect(engine.outbox.awaiting()).toHaveLength(2)
    expect(nameOf(engine, 's1')).toBe('second')
    // Echo for the FIRST edit only: it moves the row past both (shared)
    // baselines, but only the first entry is covered — the second must keep
    // painting instead of flashing 'first'.
    engine.replica.applySnapshot('sessions', [{ ...session('s1', '/w'), name: 'first' }])
    await settle()
    expect(nameOf(engine, 's1')).toBe('second')
    expect(engine.outbox.awaiting()).toHaveLength(1)
    // The second echo retires the rest; later server changes show through.
    engine.replica.applySnapshot('sessions', [{ ...session('s1', '/w'), name: 'second' }])
    await settle()
    expect(nameOf(engine, 's1')).toBe('second')
    expect(engine.outbox.awaiting()).toEqual([])
    engine.replica.applySnapshot('sessions', [{ ...session('s1', '/w'), name: 'server-wins' }])
    await settle()
    expect(nameOf(engine, 's1')).toBe('server-wins')
    engine.dispose()
  })

  it("a predecessor's echo landing BEFORE a younger same-row mutation resolves does not drop the younger overlay (round 2)", async () => {
    const api = makeApi()
    const resolvers: Array<() => void> = []
    api.sessions.rename.mutate = vi.fn(
      () =>
        new Promise<Record<string, never>>((r) => {
          resolvers.push(() => r({}))
        }),
    )
    const { engine } = makeEngine({ api })
    engine.start()
    await settle(40)
    engine.replica.applyChanges('sessions', [session('s1', '/w')], [])
    await settle()
    void engine.getSnapshot().renameSession(asSessionId('s1'), 'first') // A
    void engine.getSnapshot().renameSession(asSessionId('s1'), 'second') // B (chained behind A)
    // Negative flicker check: from the moment B is pending, 'first' (or the
    // pre-rename undefined) must never paint again until B retires.
    const painted: Array<string | undefined> = []
    engine.subscribe(() => painted.push(nameOf(engine, 's1')))
    await settle()
    resolvers[0]?.() // A resolves → awaiting truth
    await settle()
    // A's echo lands BEFORE B resolves: A retires (covered) and the row moves
    // past B's shared enqueue baseline.
    engine.replica.applySnapshot('sessions', [{ ...session('s1', '/w'), name: 'first' }])
    await settle()
    expect(nameOf(engine, 's1')).toBe('second') // B still queued & painting
    // B resolves: the movement is the PREDECESSOR'S echo, not a competing
    // writer — B's overlay must survive until B's own echo.
    resolvers[1]?.()
    await settle()
    expect(nameOf(engine, 's1')).toBe('second')
    expect(engine.outbox.awaiting()).toHaveLength(1)
    // B's echo retires it; later server changes still show through (no mask).
    engine.replica.applySnapshot('sessions', [{ ...session('s1', '/w'), name: 'second' }])
    await settle()
    expect(engine.outbox.awaiting()).toEqual([])
    engine.replica.applySnapshot('sessions', [{ ...session('s1', '/w'), name: 'server-wins' }])
    await settle()
    expect(nameOf(engine, 's1')).toBe('server-wins')
    // 'first' NEVER painted while B was pending — that flash is the bug.
    expect(painted).not.toContain('first')
    engine.dispose()
  })

  it('a held chained overlay survives a reload without the moved-past escape retiring it (round 2)', async () => {
    const storage = memoryStorage()
    const api = makeApi()
    const resolvers: Array<() => void> = []
    api.sessions.rename.mutate = vi.fn(
      () =>
        new Promise<Record<string, never>>((r) => {
          resolvers.push(() => r({}))
        }),
    )
    const first = makeEngine({ api, storage })
    first.engine.start()
    await settle(40)
    first.engine.replica.applyChanges('sessions', [session('s1', '/w')], [])
    await settle()
    void first.engine.getSnapshot().renameSession(asSessionId('s1'), 'first')
    void first.engine.getSnapshot().renameSession(asSessionId('s1'), 'second')
    await settle()
    resolvers[0]?.()
    await settle()
    first.engine.replica.applySnapshot('sessions', [{ ...session('s1', '/w'), name: 'first' }])
    await settle()
    resolvers[1]?.() // B held (predecessor's echo), durably awaiting
    await settle()
    expect(first.engine.outbox.awaiting()).toHaveLength(1)
    first.engine.dispose()
    // Reload inside B's resolution→echo window: replica truth says 'first'
    // (≠ B's stale enqueue baseline). The restored entry must keep painting —
    // an escape-armed restore would retire it on the first prune.
    const second = makeEngine({ api, storage })
    expect(nameOf(second.engine, 's1')).toBe('second')
    second.engine.start()
    await settle(40)
    // An unrelated replica change triggers a prune pass — B must survive it.
    second.engine.replica.applyChanges('sessions', [session('s2', '/w')], [])
    await settle()
    expect(nameOf(second.engine, 's1')).toBe('second')
    // B's echo retires it.
    second.engine.replica.applySnapshot('sessions', [
      { ...session('s1', '/w'), name: 'second' },
      session('s2', '/w'),
    ])
    await settle()
    expect(second.engine.outbox.awaiting()).toEqual([])
    second.engine.dispose()
  })

  it("an old build's awaiting-marked row in the queued collection is adopted, not re-drained (round 2 migration)", async () => {
    const storage = memoryStorage()
    // Simulate the PREVIOUS build: it persisted the session row plus a
    // resolved rename in the queued outbox collection with
    // state:'awaiting-truth'.
    const oldReplica = createReplica({ storage })
    oldReplica.applyChanges('sessions', [session('s1', '/w')], [])
    oldReplica.outboxStorage().save([
      {
        mutationId: asMutationId('m-old'),
        kind: 'rename',
        input: { sessionId: 's1', name: 'held' },
        queuedAt: Date.now() - 2000,
        state: 'awaiting-truth',
        resolvedAt: Date.now() - 1000, // recent — inside the awaiting TTL
      },
    ])
    const api = makeApi()
    const { engine } = makeEngine({ api, storage })
    // Adopted into the awaiting stage: painted, present in awaiting(), and the
    // queued collection is empty — the rename executor must NEVER run again.
    expect(engine.outbox.awaiting().map((e) => e.mutationId)).toEqual(['m-old'])
    expect(engine.outbox.pending()).toEqual([])
    expect(nameOf(engine, 's1')).toBe('held') // painted from the very first snapshot
    engine.start()
    await settle(40)
    expect(nameOf(engine, 's1')).toBe('held')
    expect(api.sessions.rename.mutate).not.toHaveBeenCalled()
    // A fresh load (post-migration) reads the entry from the NEW home only.
    engine.dispose()
    const second = makeEngine({ api, storage })
    expect(second.engine.outbox.awaiting().map((e) => e.mutationId)).toEqual(['m-old'])
    expect(second.engine.outbox.pending()).toEqual([])
    second.engine.dispose()
  })

  it("archive's paired setArchived/setWorkState survive an echo covering only the first (finding 3)", async () => {
    const api = makeApi()
    const { engine } = makeEngine({ api })
    engine.start()
    await settle(40)
    engine.replica.applyChanges('sessions', [session('s1', '/w')], [])
    await settle()
    void engine.getSnapshot().archiveSession(asSessionId('s1'), true)
    await settle()
    const row = (): SessionMeta | undefined =>
      engine.getSnapshot().sessions.find((s) => s.sessionId === 's1')
    expect(engine.getSnapshot().outboxSize).toBe(0)
    expect(row()?.archived).toBe(true)
    expect(row()?.workState).toBe('done')
    // Echo for setArchived only — the workState write hasn't echoed yet. The
    // later mutation's overlay must keep painting 'done'.
    engine.replica.applySnapshot('sessions', [{ ...session('s1', '/w'), archived: true }])
    await settle()
    expect(row()?.archived).toBe(true)
    expect(row()?.workState).toBe('done')
    // The second echo retires everything.
    engine.replica.applySnapshot('sessions', [
      { ...session('s1', '/w'), archived: true, workState: 'done' } as unknown as SessionMeta,
    ])
    await settle()
    expect(row()?.workState).toBe('done')
    expect(engine.outbox.awaiting()).toEqual([])
    engine.dispose()
  })
})

describe('spawn transport failure (#263 review finding 4)', () => {
  const spawnApi = () => {
    const api = makeApi()
    api.sessions.resumeAndSend = { mutate: vi.fn(async () => ({})) }
    return api
  }

  it('reuses caller-reserved draft identities and mutation id', async () => {
    const api = spawnApi()
    let createInput: Record<string, unknown> | undefined
    api.sessions.create = {
      mutate: vi.fn(async (input: Record<string, unknown>) => {
        createInput = input
      }),
    }
    const { engine } = makeEngine({ api })
    engine.start()
    await settle(40)

    const made = engine.getSnapshot().spawnDraftAgent({
      issueId: asIssueId('reserved-issue'),
      sessionId: asSessionId('reserved-session'),
      mutationId: asMutationId('reserved-mutation'),
      draftArtifacts: [
        {
          id: 'att-1',
          filename: 'mock.png',
          mimeType: 'image/png',
          dataBase64: 'UE5H',
        },
      ],
      target: { path: '/w', repoPath: '/w' },
      agentKind: 'codex',
      firstPrompt: 'Name this work',
    })

    expect(made).toMatchObject({ issueId: 'reserved-issue', sessionId: 'reserved-session' })
    expect(createInput).toMatchObject({
      sessionId: 'reserved-session',
      mutationId: 'reserved-mutation',
      initialPrompt: 'Name this work',
      draftArtifacts: [expect.objectContaining({ filename: 'mock.png', dataBase64: 'UE5H' })],
      draftIssue: { repoPath: '/w', issueId: 'reserved-issue' },
    })
    engine.dispose()
  })

  it.each([
    'unauthorized',
    'unreachable',
  ] as const)('refuses %s placement before optimistic rows are painted', (placement) => {
    const { engine } = makeEngine({ api: spawnApi() })
    const before = engine.getSnapshot()

    expect(() =>
      engine.getSnapshot().spawnDraftAgent({
        target: {
          path: '/w',
          repoPath: '/w',
          machineId: asMachineId('machine-1'),
          placement,
        },
        agentKind: 'claude-code',
      }),
    ).toThrow(placement === 'unauthorized' ? /not authorized/ : /unreachable/)

    expect(engine.getSnapshot().sessions).toEqual(before.sessions)
    expect(engine.getSnapshot().issues).toEqual(before.issues)
    engine.dispose()
  })

  it('a failure AFTER the session row landed is success: no toast, no rollback', async () => {
    const api = spawnApi()
    const holder: { engine?: ReturnType<typeof makeEngine>['engine'] } = {}
    api.sessions.create = {
      mutate: vi.fn(async (input: { sessionId: SessionId }) => {
        // The broadcast minted the row server-side; only the response is lost.
        holder.engine?.replica.applyChanges('sessions', [session(input.sessionId, '/w')], [])
        throw new Error('transport lost')
      }),
    }
    const made = makeEngine({ api, spawnConfirmGraceMs: 30 })
    holder.engine = made.engine
    made.engine.start()
    await settle(40)
    const ids = made.engine
      .getSnapshot()
      .spawnDraftAgent({ target: { path: '/w', repoPath: '/w' }, agentKind: 'claude-code' })
    await settle(80) // past the grace too — the outcome must be stable
    expect(made.errors).toEqual([]) // no "Couldn't start" cry-wolf
    expect(made.engine.getSnapshot().sessions.some((s) => s.sessionId === ids.sessionId)).toBe(true)
    made.engine.dispose()
  })

  it('a create that never produced the row rolls back + toasts after the grace', async () => {
    const api = spawnApi()
    api.sessions.create = {
      mutate: vi.fn(async () => {
        throw new Error('daemon offline')
      }),
    }
    const { engine, errors } = makeEngine({ api, spawnConfirmGraceMs: 30 })
    engine.start()
    await settle(40)
    const ids = engine
      .getSnapshot()
      .spawnDraftAgent({ target: { path: '/w', repoPath: '/w' }, agentKind: 'claude-code' })
    expect(engine.getSnapshot().sessions.some((s) => s.sessionId === ids.sessionId)).toBe(true)
    await settle(80) // rejection + grace elapsed, still no row
    expect(engine.getSnapshot().sessions.some((s) => s.sessionId === ids.sessionId)).toBe(false)
    expect(engine.getSnapshot().issues.some((i) => i.id === ids.issueId)).toBe(false)
    expect(errors.some((m) => m.includes("Couldn't start"))).toBe(true)
    engine.dispose()
  })

  it('paints a named task, first session, and prompt before create resolves', async () => {
    const api = spawnApi()
    let releaseCreate!: () => void
    let createInput: Record<string, unknown> | undefined
    api.issues.create = {
      mutate: vi.fn(
        (input: Record<string, unknown>) =>
          new Promise((resolve) => {
            createInput = input
            releaseCreate = () => resolve({ id: input.id })
          }),
      ),
    }
    const { engine } = makeEngine({ api })
    engine.start()
    await settle(40)

    const made = engine.getSnapshot().spawnIssueAgent({
      target: { path: '/w', repoPath: '/w' },
      title: 'Smooth task launch',
      description: 'Show this prompt immediately',
      agentKind: 'codex',
    })

    expect(engine.getSnapshot().issues.find((row) => row.id === made.issueId)).toMatchObject({
      title: 'Smooth task launch',
      description: 'Show this prompt immediately',
      stage: 'in_progress',
      draft: false,
    })
    expect(
      engine.getSnapshot().sessions.find((row) => row.sessionId === made.sessionId),
    ).toMatchObject({ issueId: made.issueId, status: 'starting' })
    expect(engine.getSnapshot().pendingSpawnPrompts.get(made.sessionId)).toBe(
      'Show this prompt immediately',
    )
    expect(createInput).toMatchObject({
      id: made.issueId,
      startSessionId: made.sessionId,
      startNow: true,
      description: 'Show this prompt immediately',
    })

    const optimisticIssue = engine.getSnapshot().issues.find((row) => row.id === made.issueId)
    if (!optimisticIssue) throw new Error('missing optimistic issue')
    engine.replica.applyChanges(
      'issues',
      [{ ...optimisticIssue, seq: 1, worktreePath: '/w/.worktrees/smooth-task-launch' }],
      [],
    )
    engine.replica.applyChanges(
      'sessions',
      [session(made.sessionId, '/w/.worktrees/smooth-task-launch')],
      [],
    )
    releaseCreate()
    expect(await made.settled).toBe(true)
    await settle(40)
    expect(engine.getSnapshot().pendingSpawnPrompts.has(made.sessionId)).toBe(false)
    expect(engine.getSnapshot().sessions.some((row) => row.sessionId === made.sessionId)).toBe(true)
    engine.dispose()
  })

  it('rolls a rejected task launch back and reports the server error', async () => {
    const api = spawnApi()
    api.issues.create = {
      mutate: vi.fn(async () => {
        throw new Error('worktree add failed')
      }),
    }
    const { engine, errors } = makeEngine({ api, spawnConfirmGraceMs: 20 })
    engine.start()
    await settle(40)

    const made = engine.getSnapshot().spawnIssueAgent({
      target: { path: '/w', repoPath: '/w' },
      title: 'Broken launch',
      description: 'Keep my prompt',
      agentKind: 'codex',
    })
    expect(engine.getSnapshot().pendingSpawnPrompts.get(made.sessionId)).toBe('Keep my prompt')
    expect(await made.settled).toBe(false)
    expect(engine.getSnapshot().pendingSpawnPrompts.has(made.sessionId)).toBe(false)
    expect(engine.getSnapshot().sessions.some((row) => row.sessionId === made.sessionId)).toBe(
      false,
    )
    expect(errors).toContain("Couldn't start the task — worktree add failed")
    engine.dispose()
  })

  it('keeps an authoritative issue when create committed but its first session failed', async () => {
    const api = spawnApi()
    api.issues.create = {
      mutate: vi.fn(async () => {
        throw new Error('worktree add failed')
      }),
    }
    const { engine, errors } = makeEngine({ api, spawnConfirmGraceMs: 20 })
    engine.start()
    await settle(40)

    const made = engine.getSnapshot().spawnIssueAgent({
      target: { path: '/w', repoPath: '/w' },
      title: 'Partially started',
      description: 'Keep the saved task',
      agentKind: 'codex',
    })
    const optimisticIssue = engine.getSnapshot().issues.find((row) => row.id === made.issueId)
    if (!optimisticIssue) throw new Error('missing optimistic issue')
    engine.replica.applyChanges('issues', [{ ...optimisticIssue, seq: 1 }], [])

    expect(await made.outcome).toBe('issue-only')
    expect(engine.getSnapshot().issues.some((row) => row.id === made.issueId)).toBe(true)
    expect(engine.getSnapshot().sessions.some((row) => row.sessionId === made.sessionId)).toBe(
      false,
    )
    expect(errors).toContain(
      "The task was saved, but its agent couldn't start — worktree add failed",
    )
    engine.dispose()
  })

  it('reuses the reserved ids after late issue truth instead of painting a duplicate', async () => {
    const api = spawnApi()
    api.issues.create = {
      mutate: vi.fn(async () => {
        throw new Error('connection lost')
      }),
    }
    const { engine } = makeEngine({ api, spawnConfirmGraceMs: 20 })
    engine.start()
    await settle(40)

    const first = engine.getSnapshot().spawnIssueAgent({
      target: { path: '/w', repoPath: '/w' },
      title: 'Ambiguous launch',
      description: 'Create this once',
      agentKind: 'codex',
    })
    const lateIssue = engine.getSnapshot().issues.find((row) => row.id === first.issueId)
    if (!lateIssue) throw new Error('missing optimistic issue')
    expect(await first.outcome).toBe('failed')

    engine.replica.applyChanges('issues', [{ ...lateIssue, seq: 1 }], [])
    const retry = engine.getSnapshot().spawnIssueAgent({
      issueId: first.issueId,
      sessionId: first.sessionId,
      mutationId: first.mutationId,
      target: { path: '/w', repoPath: '/w' },
      title: 'Ambiguous launch',
      description: 'Create this once',
      agentKind: 'codex',
    })

    expect(await retry.outcome).toBe('issue-only')
    expect(engine.getSnapshot().issues.filter((row) => row.id === first.issueId)).toHaveLength(1)
    expect(api.issues.create.mutate).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        id: first.issueId,
        startSessionId: first.sessionId,
        mutationId: first.mutationId,
      }),
    )
    engine.dispose()
  })

  it('dispose() before the grace elapses clears the confirm timer: no rollback, no toast (round 2)', async () => {
    const api = spawnApi()
    api.sessions.create = {
      mutate: vi.fn(async () => {
        throw new Error('daemon offline')
      }),
    }
    const { engine, errors } = makeEngine({ api, spawnConfirmGraceMs: 30 })
    engine.start()
    await settle(40)
    const ids = engine
      .getSnapshot()
      .spawnDraftAgent({ target: { path: '/w', repoPath: '/w' }, agentKind: 'claude-code' })
    await settle(5) // the rejection landed and the grace timer is armed
    engine.dispose() // replaced (e.g. provider recreation) before the grace
    await settle(80) // well past the grace
    // A replaced engine must not fire against state its successor owns: the
    // overlay was NOT rolled back and no cry-wolf toast surfaced.
    expect(errors).toEqual([])
    expect(engine.getSnapshot().sessions.some((s) => s.sessionId === ids.sessionId)).toBe(true)
    expect(engine.getSnapshot().issues.some((i) => i.id === ids.issueId)).toBe(true)
  })
})

describe('resumeAndSend holds for optimistic spawn (POD-546)', () => {
  const spawnSendApi = () => {
    const api = makeApi()
    api.sessions.resumeAndSend = {
      mutate: vi.fn(async () => ({ ok: true, disposition: 'accepted' })),
    }
    return api
  }

  it('does not call resumeAndSend until the create id is on the server', async () => {
    const api = spawnSendApi()
    let releaseCreate!: () => void
    const createGate = new Promise<void>((resolve) => {
      releaseCreate = resolve
    })
    const resumeCalls: Array<{ sessionId: string; text: string }> = []
    api.sessions.create = {
      mutate: vi.fn(async (input: { sessionId: SessionId }) => {
        await createGate
        // Mirror the server broadcast that retires the spawn overlay.
        holder.engine?.replica.applyChanges('sessions', [session(input.sessionId, '/w')], [])
        return { sessionId: input.sessionId }
      }),
    }
    api.sessions.resumeAndSend = {
      mutate: vi.fn(async (input: { sessionId: string; text: string }) => {
        resumeCalls.push({ sessionId: input.sessionId, text: input.text })
        return { ok: true, disposition: 'accepted' }
      }),
    }
    const holder: { engine?: ReturnType<typeof makeEngine>['engine'] } = {}
    const { engine, hub } = makeEngine({ api })
    holder.engine = engine
    engine.start()
    hub.health = { status: 'ok', rttMs: 1, since: 0 }
    hub.emit('connectionHealth', hub.health)
    await settle(40)

    const { sessionId } = engine
      .getSnapshot()
      .spawnDraftAgent({ target: { path: '/w', repoPath: '/w' }, agentKind: 'grok' })
    expect(engine.getSnapshot().pendingSpawnIds.has(sessionId)).toBe(true)

    // Composer fires immediately — the classic mobile race.
    const sendPromise = engine.getSnapshot().resumeAndSend(sessionId, 'hello from mobile')
    await settle(40)
    expect(resumeCalls).toEqual([])

    releaseCreate()
    await sendPromise
    await settle(40)

    expect(resumeCalls).toEqual([{ sessionId, text: 'hello from mobile' }])
    expect(engine.getSnapshot().pendingSpawnIds.has(sessionId)).toBe(false)
    engine.dispose()
  })

  it('ok:false from resumeAndSend is not treated as applied', async () => {
    const api = spawnSendApi()
    api.sessions.resumeAndSend = {
      mutate: vi.fn(async () => ({
        ok: false,
        reason: 'dead-lettered: session no longer exists',
        disposition: 'dead_letter',
      })),
    }
    const { engine, hub } = makeEngine({ api })
    engine.start()
    hub.health = { status: 'ok', rttMs: 1, since: 0 }
    hub.emit('connectionHealth', hub.health)
    await settle(40)

    // Existing session id (no spawn hold) — authority refuses the send.
    engine.replica.applyChanges('sessions', [session('s-known', '/w')], [])
    await settle(10)
    await engine.getSnapshot().resumeAndSend(asSessionId('s-known'), 'lost if applied')
    await settle(40)

    expect(engine.getSnapshot().outboxSize).toBe(0)
    expect(engine.getSnapshot().outboxDeadLetters).toMatchObject([
      { entry: { kind: 'resumeAndSend' } },
    ])
    engine.dispose()
  })
})

describe('outbox drain on reconnect', () => {
  it('a queued write retries when hub connection health recovers', async () => {
    const api = makeApi()
    let renameCalls = 0
    api.sessions.rename.mutate = vi.fn(async () => {
      renameCalls++
      if (renameCalls === 1) throw new Error('network down') // non-poison → entry stays
      return {}
    })
    const hub = new FakeHub() // health starts 'down'
    const { engine } = makeEngine({ api, hub })
    engine.start()
    await settle(40)
    await engine.getSnapshot().renameSession(asSessionId('s1'), 'renamed')
    await settle()
    expect(renameCalls).toBe(1)
    expect(engine.getSnapshot().outboxSize).toBe(1)
    // The hub's heartbeat-derived health recovering must drain the outbox —
    // the browser 'online' event alone misses a server restart.
    hub.emit('connectionHealth', { status: 'ok', rttMs: 5, since: 1 })
    await settle()
    expect(renameCalls).toBe(2)
    expect(engine.getSnapshot().outboxSize).toBe(0)
    engine.dispose()
  })
})

// ------------------------------------------------------- navigate-to-session

/**
 * [spec:SP-a1c0] (#411) The central navigate-to-session action. Landing on a
 * session needs the whole context — view + worktree + pane (+ its issue) —
 * not just the pane: the workspace renders the SELECTED WORKTREE's sessions,
 * and mirrorUrl only writes the URL while the view is already 'workspace'. The
 * first cut set the pane alone, so the URL flipped and reverted and the view
 * never changed. These pin the full landing.
 */
describe('navigateToSession (#411)', () => {
  const withSession = async (url = '/issues') => {
    const h = makeEngine({ url })
    h.engine.start()
    await settle()
    h.engine.replica.applySnapshot('sessions', [
      { ...session('s1', '/tmp/known-repo/.worktrees/wt1/sub'), displayRef: 'POD-529-A' },
    ])
    await settle()
    return h
  }

  it("switches to the workspace, selects the session's worktree, and opens its pane", async () => {
    const { engine, rw } = await withSession()
    engine.getSnapshot().navigateToSession('s1')
    await settle()
    const st = engine.getSnapshot()
    expect(st.view).toBe('workspace')
    expect(st.selectedWorktree).toBe('/tmp/known-repo/.worktrees/wt1')
    expect(st.paneA).toBe('s1')
    expect(st.focusedPane).toBe('A')
    // the URL landed on the session and STAYED there (no flip-back)
    expect(rw.url()).toContain('/workspace')
    expect(rw.url()).toContain('pane=s1')
  })

  it('accepts a permanent session birth ref and navigates to its canonical pane id', async () => {
    const { engine, rw } = await withSession()
    engine.getSnapshot().navigateToSession('POD-529-A')
    await settle()
    expect(engine.getSnapshot().paneA).toBe('s1')
    expect(rw.url()).toContain('pane=s1')
  })

  it('is inert for an unknown session (no view change, no URL write)', async () => {
    const { engine, rw } = await withSession()
    const before = rw.writes.length
    engine.getSnapshot().navigateToSession('nope')
    await settle()
    expect(engine.getSnapshot().view).toBe('issues')
    expect(rw.writes.length).toBe(before)
  })
})

describe('artifact file tabs ([spec:SP-0fc9] #441)', () => {
  it('openArtifact creates an artifact-scoped tab carrying the issue, and focuses it', () => {
    const { engine } = makeEngine()
    engine.start()
    engine.getSnapshot().openArtifact({
      issueId: asIssueId('iss_1'),
      artifactId: asArtifactId('abc123'),
      path: 'index.html',
      worktreePath: '/wt',
    })
    const st = engine.getSnapshot()
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
    engine.getSnapshot().openArtifact({
      issueId: asIssueId('iss_1'),
      artifactId: asArtifactId('abc123'),
      path: 'index.html',
    })
    expect(engine.getSnapshot().fileTabs).toHaveLength(1)
    engine.dispose()
  })

  it('openArtifact from the issues view lands on the workspace with the issue selected (#101)', async () => {
    const { engine, rw } = makeEngine({ url: '/issues/iss_1' })
    engine.start()
    await settle()
    engine.getSnapshot().openArtifact({
      issueId: asIssueId('iss_1'),
      artifactId: asArtifactId('abc123'),
      path: 'index.html',
      worktreePath: '/tmp/known-repo/.worktrees/wt1',
    })
    await settle()
    const st = engine.getSnapshot()
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
    engine.getSnapshot().openArtifact({
      issueId: asIssueId('iss_1'),
      artifactId: asArtifactId('abc123'),
      path: 'doc.md',
    })
    await settle()
    const st = engine.getSnapshot()
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
    engine.getSnapshot().openFileInWorktree({
      root: '/tmp/known-repo/.worktrees/wt1',
      path: 'notes.md',
    })
    await settle()
    const st = engine.getSnapshot()
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
    engine.replica.applySnapshot('sessions', [session('s1', '/tmp/known-repo/.worktrees/wt1/sub')])
    await settle()
    engine.getSnapshot().openFile(asSessionId('s1'), 'notes.md')
    await settle()
    const st = engine.getSnapshot()
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
    await engine.getSnapshot().readFileScoped(scope, 'index.html')
    expect(reads).toEqual([
      { issueId: asIssueId('iss_1'), artifactId: asArtifactId('abc123'), path: 'index.html' },
    ])
    // Immutable snapshot: the write API is never called.
    await expect(
      engine.getSnapshot().writeFileScoped({ scope, path: 'index.html', content: 'x' }),
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
    engine.replica.applySnapshot('sessions', [session('s1', '/tmp/known-repo/.worktrees/wt1')])
    await settle()
    engine.getSnapshot().setSelectedIssueId(asIssueId('iss_9'))
    engine.getSnapshot().openFile(asSessionId('s1'), 'notes.md')
    await settle()
    const st = engine.getSnapshot()
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
    engine.replica.applySnapshot('sessions', [
      {
        ...session('s1', '/tmp/known-repo/.worktrees/wt1'),
        issueId: asIssueId('iss_own'),
      } as SessionMeta,
    ])
    await settle()
    engine.getSnapshot().setSelectedIssueId(asIssueId('iss_other'))
    engine.getSnapshot().openFile(asSessionId('s1'), 'notes.md')
    await settle()
    const st = engine.getSnapshot()
    expect(st.fileTabs[0]?.issueId).toBe('iss_own')
    // navigated to the OWNING issue's workspace, not the stale selection
    expect(st.selectedIssueId).toBe('iss_own')
    engine.dispose()
  })

  it('openFileInWorktree stamps an explicit caller issue, else the selection, else nothing', async () => {
    const { engine } = makeEngine({ url: '/issues' })
    engine.start()
    await settle()
    const snap = engine.getSnapshot()
    snap.openFileInWorktree({ root: '/tmp/known-repo', path: 'a.md', issueId: asIssueId('iss_1') })
    engine.getSnapshot().setSelectedIssueId(asIssueId('iss_2'))
    engine.getSnapshot().openFileInWorktree({ root: '/tmp/known-repo', path: 'b.md' })
    engine.getSnapshot().setSelectedIssueId(null)
    engine.getSnapshot().openFileInWorktree({ root: '/tmp/known-repo', path: 'c.md' })
    const tabs = engine.getSnapshot().fileTabs
    expect(tabs.map((t) => t.issueId)).toEqual(['iss_1', 'iss_2', undefined])
    engine.dispose()
  })

  it('re-opening an existing tab keeps its original owner and reveals THAT issue', async () => {
    const { engine } = makeEngine({ url: '/issues' })
    engine.start()
    await settle()
    engine.getSnapshot().setSelectedIssueId(asIssueId('iss_1'))
    engine.getSnapshot().openFileInWorktree({ root: '/tmp/known-repo', path: 'a.md' })
    engine.getSnapshot().setSelectedIssueId(asIssueId('iss_2'))
    engine.getSnapshot().openFileInWorktree({ root: '/tmp/known-repo', path: 'a.md' })
    const st = engine.getSnapshot()
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
      engine.getSnapshot().openFileInWorktree({ root: '/tmp/known-repo', path, permanent: false })

    preview('a.md')
    let st = engine.getSnapshot()
    let ws = st.workspaces[st.workspaceKey()]
    expect(ws?.previewTabId).toBe('file:w:/tmp/known-repo:a.md')

    // The glance moves on: one temporary tab, in the same strip slot, and the
    // record of the file nothing is rendering any more goes with it.
    preview('b.md')
    st = engine.getSnapshot()
    ws = st.workspaces[st.workspaceKey()]
    expect(ws?.previewTabId).toBe('file:w:/tmp/known-repo:b.md')
    expect(ws ? allTabIds(ws) : []).toEqual(['file:w:/tmp/known-repo:b.md'])
    expect(st.fileTabs.map((t) => t.path)).toEqual(['b.md'])
    // Still reachable from the "+" menu — a glance is not a close.
    expect(st.recentFiles.map((r) => r.path)).toEqual(['b.md', 'a.md'])

    // A double click (and every caller that has not thought about it) keeps it.
    engine.getSnapshot().openFileInWorktree({ root: '/tmp/known-repo', path: 'c.md' })
    st = engine.getSnapshot()
    ws = st.workspaces[st.workspaceKey()]
    expect(ws?.previewTabId).toBe(null)
    expect(st.fileTabs.map((t) => t.path)).toEqual(['c.md'])
    engine.dispose()
  })

  it('promotes the previewed file in place, so the next glance leaves it alone', async () => {
    const { engine } = makeEngine({ url: '/issues' })
    engine.start()
    await settle()
    engine
      .getSnapshot()
      .openFileInWorktree({ root: '/tmp/known-repo', path: 'a.md', permanent: false })
    // What `usePreviewPromotion` fires when the operator types into the panel.
    engine.getSnapshot().promoteWorkspaceTab('file:w:/tmp/known-repo:a.md')
    engine
      .getSnapshot()
      .openFileInWorktree({ root: '/tmp/known-repo', path: 'b.md', permanent: false })
    const st = engine.getSnapshot()
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
      first.engine.getSnapshot().openFileInWorktree({ root: '/tmp/known-repo', path: `f${i}.md` })
    }
    // duplicate open moves to front instead of adding
    first.engine.getSnapshot().openFileInWorktree({ root: '/tmp/known-repo', path: 'f31.md' })
    first.engine.getSnapshot().openArtifact({
      issueId: asIssueId('iss_1'),
      artifactId: asArtifactId('abc'),
      path: 'index.html',
      worktreePath: '/tmp/known-repo',
    })
    const recents = first.engine.getSnapshot().recentFiles
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
    expect(second.engine.getSnapshot().recentFiles).toHaveLength(30)
    expect(second.engine.getSnapshot().recentFiles[0]?.path).toBe('index.html')
    second.engine.dispose()
  })
})

// ---------------------------------------------------------------------------
// POD-272: mark-read-on-view is EAGER for the surface in the foreground. The
// old trailing debounce left a "new message" chip on the row of the very
// session/issue whose message was already on screen.
// ---------------------------------------------------------------------------
describe('eager mark-read-on-view (POD-272)', () => {
  const active = (id: string, over: Partial<SessionMetaInput> = {}): SessionMeta =>
    ({ ...session(id, '/tmp/known-repo/.worktrees/wt1'), ...over }) as SessionMeta

  it('marks the session in the OPEN PANE read the moment its activity lands', async () => {
    const api = makeApi()
    const { engine } = makeEngine({ api })
    engine.start()
    await settle(40)
    engine.replica.applyChanges('sessions', [active('s1')], [])
    await settle()
    engine.getSnapshot().setPane('A', asSessionId('s1'))
    await settle()
    // A message arrives while s1 IS the visible pane.
    engine.replica.applyChanges(
      'sessions',
      [active('s1', { lastActiveAt: '2026-07-01T00:01:00.000Z', unread: true })],
      [],
    )
    await settle() // ~25ms — an order of magnitude under MARK_READ_ON_VIEW_MS
    expect(api.sessions.markRead.mutate).toHaveBeenCalledTimes(1)
    expect(engine.getSnapshot().sessions[0]?.unread).toBe(false)
    engine.dispose()
  })

  it('does not undo a manual mark-unread of the open session (no fresh activity)', async () => {
    const api = makeApi()
    const { engine } = makeEngine({ api })
    engine.start()
    await settle(40)
    engine.replica.applyChanges(
      'sessions',
      [active('s1', { readAt: '2026-07-01T00:00:01.000Z' })],
      [],
    )
    await settle()
    engine.getSnapshot().setPane('A', asSessionId('s1'))
    await settle()
    // Marking THIS open session unread flips the flag without new activity —
    // the trigger is activity, so nothing re-reads it.
    engine.replica.applyChanges('sessions', [active('s1', { readAt: null, unread: true })], [])
    await settle(60)
    expect(api.sessions.markRead.mutate).not.toHaveBeenCalled()
    expect(engine.getSnapshot().sessions[0]?.unread).toBe(true)
    engine.dispose()
  })

  it('throttles a burst to one mutation per window, with a trailing pass for the tail', async () => {
    const api = makeApi()
    const { engine } = makeEngine({ api })
    engine.start()
    await settle(40)
    engine.replica.applyChanges('sessions', [active('s1')], [])
    await settle()
    engine.getSnapshot().setPane('A', asSessionId('s1'))
    await settle()
    engine.replica.applyChanges(
      'sessions',
      [active('s1', { lastActiveAt: '2026-07-01T00:01:00.000Z', unread: true })],
      [],
    )
    await settle()
    expect(api.sessions.markRead.mutate).toHaveBeenCalledTimes(1) // leading edge
    // THE SERVER'S ECHO, and the test is wrong without it. `sessions.markRead`
    // carries only the session id — the server stamps its own readAt when it
    // processes the mutation — so while that pass is in flight its optimistic
    // overlay holds the row at `unread: false`, and everything arriving behind
    // it is already covered by the stamp the server has yet to make. A second
    // mutation there would be redundant, which is why the reaction declines to
    // send one, and why the tail below is only meaningful once the read lands.
    engine.replica.applyChanges(
      'sessions',
      [
        active('s1', {
          lastActiveAt: '2026-07-01T00:01:00.000Z',
          readAt: '2026-07-01T00:01:30.000Z',
          unread: false,
        }),
      ],
      [],
    )
    await settle()
    expect(api.sessions.markRead.mutate).toHaveBeenCalledTimes(1)
    // Fresh activity AFTER that confirmed read, still inside the throttle window.
    engine.replica.applyChanges(
      'sessions',
      [
        active('s1', {
          lastActiveAt: '2026-07-01T00:02:00.000Z',
          readAt: '2026-07-01T00:01:30.000Z',
          unread: true,
        }),
      ],
      [],
    )
    await settle()
    expect(api.sessions.markRead.mutate).toHaveBeenCalledTimes(1) // still inside the window
    await settle(1400) // …and the tail lands once it closes
    expect(api.sessions.markRead.mutate).toHaveBeenCalledTimes(2)
    engine.dispose()
  })

  it('marks the FOREGROUND ISSUE read when activity lands on it', async () => {
    const api = makeApi()
    const { engine } = makeEngine({ api })
    engine.start()
    await settle(40)
    const issue = {
      id: 'iss_1',
      unread: false,
      readAt: '2026-07-01T00:00:00.000Z',
      updatedAt: '2026-07-01T00:00:00.000Z',
    } as unknown as IssueWire
    engine.replica.applyChanges('issues', [issue], [])
    await settle()
    engine.getSnapshot().setOpenIssueId(asIssueId('iss_1'))
    engine.getSnapshot().setView('issues')
    await settle()
    engine.replica.applyChanges(
      'issues',
      [{ ...issue, unread: true, updatedAt: '2026-07-01T00:05:00.000Z' } as typeof issue],
      [],
    )
    await settle()
    expect(api.issues.markRead.mutate).toHaveBeenCalledTimes(1)
    const readAt = engine.getSnapshot().issues[0]?.readAt
    expect(readAt).not.toBeNull()
    expect(Date.parse(readAt ?? '')).toBeGreaterThanOrEqual(Date.parse('2026-07-01T00:05:00.000Z'))
    engine.dispose()
  })

  it('leaves an issue nobody is looking at alone', async () => {
    const api = makeApi()
    const { engine } = makeEngine({ api })
    engine.start()
    await settle(40)
    const issue = {
      id: 'iss_1',
      unread: false,
      readAt: '2026-07-01T00:00:00.000Z',
      updatedAt: '2026-07-01T00:00:00.000Z',
    } as unknown as IssueWire
    engine.replica.applyChanges('issues', [issue], [])
    await settle()
    engine.replica.applyChanges(
      'issues',
      [{ ...issue, unread: true, updatedAt: '2026-07-01T00:05:00.000Z' } as typeof issue],
      [],
    )
    await settle(60)
    expect(api.issues.markRead.mutate).not.toHaveBeenCalled()
    expect((engine.getSnapshot().issues[0] as { unread?: boolean })?.unread).toBe(true)
    engine.dispose()
  })
})

// ---------------------------------------------------------------------------
// POD-331 — THE COARSE CLOCK.
//
// This test exists because its absence was MEASURED, not suspected. Deleting
// the clock interval from start() left all 760 client-core tests green, while a
// `throw` on the same line reddened 46 of them — so the line runs constantly
// and the silence was an ASSERTION GAP, not dead code.
//
// That is the shape POD-330 handed over as the single most important warning:
// replacing a fragile mechanism does not inherit its coverage. The mechanism
// replaced here is the per-component `useNow(60_000)` that the worklist
// surfaces each ran privately, and NOTHING tested that one either — so without
// this, "a snooze lapses on screen without a server round-trip" would have
// crossed the port carried by nobody.
// ---------------------------------------------------------------------------
describe('coarse clock (POD-331)', () => {
  it('republishes a fresh snapshot with an advanced clock on each tick', async () => {
    vi.useFakeTimers()
    try {
      const { engine } = makeEngine()
      engine.start()

      const before = engine.getSnapshot()
      expect(typeof before.coarseNow).toBe('number')

      // Nothing about the world changes here — no session moves, no row
      // arrives. ONLY time passes. This is precisely the case a snapshot-keyed
      // slice cache gets wrong when the clock is read out of band.
      await vi.advanceTimersByTimeAsync(COARSE_CLOCK_MS + 1)

      const after = engine.getSnapshot()
      expect(after).not.toBe(before)
      expect(after.coarseNow).toBeGreaterThan(before.coarseNow)
      engine.dispose()
    } finally {
      vi.useRealTimers()
    }
  })

  it('stops ticking once disposed, so a dead runtime cannot publish', async () => {
    vi.useFakeTimers()
    try {
      const { engine } = makeEngine()
      engine.start()
      await vi.advanceTimersByTimeAsync(COARSE_CLOCK_MS + 1)
      engine.dispose()

      // A runtime whose interval outlived it would keep republishing under a
      // principal that is gone — the leak the offs[] registration prevents.
      const afterDispose = engine.getSnapshot()
      await vi.advanceTimersByTimeAsync(COARSE_CLOCK_MS * 3)
      expect(engine.getSnapshot()).toBe(afterDispose)
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('one delta, one snapshot (POD-1645)', () => {
  /**
   * THE COUNT IS THE DEFECT; the duration only moves with load.
   *
   * A replica delta touching sessions, issues and issue projections used to run
   * `publishReplica` → three separate `apply` calls → three published
   * snapshots, and every snapshot-keyed published slice re-derived once per
   * snapshot. POD-1641 measured the worklist slice's ownership-index rebuild
   * at 93% of main-thread CPU across a multi-minute freeze, running three times
   * per delta frame. What this asserts is therefore the CONSERVED QUANTITY —
   * snapshots per delta — and not a millisecond figure.
   *
   * The counterfactual is on the record: with the `batch()` wrapper removed
   * from `publishReplica`, this test sees 3 and fails. It can say NO.
   */
  it('publishes ONE snapshot for a delta touching sessions, issues and projections', async () => {
    const storage = memoryStorage()
    const replica = createReplica({ storage })
    // Seed truth in all three collections BEFORE start, so the binding's first
    // flush is a delta that changes all three at once — the shape of a live
    // `changesSince` frame, and the one the profile caught.
    replica.applySnapshot('sessions', [
      { sessionId: 'a', name: 'a', cwd: '/tmp/known-repo' },
    ] as never)
    replica.applySnapshot('issues', [{ id: 'i1', title: 'i1', status: 'open' }] as never)
    replica.applySnapshot('issueProjections', [{ id: 'i1', title: 'i1' }] as never)

    const { engine } = makeEngine({ storage })
    // Construction already paints the seed. Change truth before the binding
    // starts so this exercises a material delta, not a redundant seed repaint.
    engine.replica.applySnapshot('sessions', [
      { sessionId: 'a', name: 'changed', cwd: '/tmp/known-repo' },
    ] as never)
    engine.replica.applySnapshot('issues', [{ id: 'i1', title: 'changed', status: 'open' }] as never)
    engine.replica.applySnapshot('issueProjections', [{ id: 'i1', title: 'changed' }] as never)
    // Count only the snapshots that move a REPLICA collection: start() also
    // publishes unrelated boot state (outbox dead letters, repo loading), and
    // counting those would make the number say something other than what this
    // test is about.
    const replicaKeys = ['sessions', 'issues', 'issueProjections'] as const
    let prev = engine.getSnapshot()
    let snapshots = 0
    const off = engine.subscribe(() => {
      const next = engine.getSnapshot()
      if (replicaKeys.some((k) => next[k] !== prev[k])) snapshots++
      prev = next
    })
    engine.start()
    off()

    expect(snapshots).toBe(1)
    // …and the one snapshot carries every collection, so coalescing did not
    // simply drop two thirds of the delta on the floor.
    const state = engine.getSnapshot()
    expect(state.sessions.map((s) => s.sessionId)).toEqual(['a'])
    expect(state.issues.map((i) => i.id)).toEqual(['i1'])
    expect(state.sessions[0]?.name).toBe('changed')
    expect(state.issues[0]?.title).toBe('changed')
    expect(state.issueProjections[0]?.title).toBe('changed')
    engine.dispose()
    await settle()
  })
})

// ---------------------------------------------------------------------------
// OFFLINE-FIRST DRAFTS (POD-2045).
//
// The composer is the one surface where the server is not allowed to be the
// authority. These tests state that as behaviour: what a person typed stays on
// screen no matter what arrives on the socket, unsent text survives a dead
// connection and a reload, and the two sides still converge once the server is
// back. Before this, every keystroke was a fire-and-forget frame that a
// disconnected socket dropped, and the reconnect replay that followed was
// adopted unconditionally — so a slow server DELETED text mid-sentence.
// ---------------------------------------------------------------------------
describe('offline-first composer drafts (POD-2045)', () => {
  const SID = asSessionId('s-draft')
  const draftOf = (e: ReturnType<typeof makeEngine>['engine']): string | undefined =>
    e.getSnapshot().drafts[SID]

  it('paints a keystroke locally before anything reaches the server', async () => {
    const { engine, hub } = makeEngine({ draftSendDebounceMs: 5 })
    engine.start()
    await settle()
    hub.connected = false

    engine.getSnapshot().setSessionDraft(SID, 'typed with the socket down')

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

    engine.getSnapshot().setSessionDraft(SID, 'hello world')
    hub.emit('sessionDraft', SID, 'hello', { rev: 3 })

    expect(draftOf(engine)).toBe('hello world')
    engine.dispose()
    await settle()
  })

  it('re-offers the local text against the rev the server actually holds', async () => {
    const { engine, hub } = makeEngine({ draftSendDebounceMs: 5 })
    engine.start()
    await settle()

    engine.getSnapshot().setSessionDraft(SID, 'hello world')
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

    engine.getSnapshot().setSessionDraft(SID, 'hello world')
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

    const actions = engine.getSnapshot()
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

    const actions = engine.getSnapshot()
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

    engine.getSnapshot().setSessionDraft(SID, 'hello world')
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

    engine.getSnapshot().setSessionDraft(SID, 'typed during the outage')
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

  it('keeps a draft across a reload with no server in reach', async () => {
    const storage = memoryStorage()
    const first = makeEngine({ storage, draftSendDebounceMs: 5, draftPersistDebounceMs: 5 })
    first.engine.start()
    await settle()
    first.hub.connected = false
    first.engine.getSnapshot().setSessionDraft(SID, 'survives the reload')
    await settle(40)
    first.engine.dispose()
    await settle()

    // A NEW runtime over the same device storage — the reload. No hub traffic
    // and no start() before the read: the draft is on screen from frame one.
    const second = makeEngine({ storage })
    expect(second.engine.getSnapshot().drafts[SID]).toBe('survives the reload')
    second.engine.dispose()
    await settle()
  })

  it('re-offers a restored draft on the next connect', async () => {
    const storage = memoryStorage()
    const first = makeEngine({ storage, draftSendDebounceMs: 5, draftPersistDebounceMs: 5 })
    first.engine.start()
    await settle()
    first.hub.connected = false
    first.engine.getSnapshot().setSessionDraft(SID, 'never reached the server')
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

  it('forgets a draft that was cleared', async () => {
    const storage = memoryStorage()
    const first = makeEngine({ storage, draftSendDebounceMs: 5, draftPersistDebounceMs: 5 })
    first.engine.start()
    await settle()
    const actions = first.engine.getSnapshot()
    actions.setSessionDraft(SID, 'temporary')
    await settle(40)
    actions.setSessionDraft(SID, '')
    await settle(40)
    first.engine.dispose()
    await settle()

    const second = makeEngine({ storage })
    expect(second.engine.getSnapshot().drafts[SID]).toBeUndefined()
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

describe('issue visit baseline', () => {
  afterEach(() => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' })
  })

  it('keeps the pre-read cursor for one visit and refreshes it across mission and visibility changes', async () => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' })
    const { engine } = makeEngine()
    engine.start()
    await settle(40)
    const first = {
      id: 'iss_1',
      seq: 1,
      title: 'First',
      stage: 'in_progress',
      readAt: '2026-07-01T00:00:00.000Z',
      updatedAt: '2026-07-02T00:00:00.000Z',
      createdAt: '2026-07-01T00:00:00.000Z',
      archived: false,
    } as unknown as IssueWire
    const second = {
      ...first,
      id: 'iss_2',
      seq: 2,
      title: 'Second',
      readAt: '2026-07-03T00:00:00.000Z',
      updatedAt: '2026-07-04T00:00:00.000Z',
    } as IssueWire
    engine.replica.applyChanges('issues', [first, second], [])
    await settle()

    engine.getSnapshot().setSelectedIssueId(asIssueId('iss_1'))
    engine.getSnapshot().setView('workspace')
    expect(engine.getSnapshot().issueVisitBaseline).toMatchObject({
      issueId: 'iss_1',
      readAt: first.readAt,
    })

    void engine.getSnapshot().markIssueRead(asIssueId('iss_1'))
    expect(engine.getSnapshot().issues.find((issue) => issue.id === 'iss_1')?.readAt).not.toBe(
      first.readAt,
    )
    expect(engine.getSnapshot().issueVisitBaseline?.readAt).toBe(first.readAt)

    engine.getSnapshot().setSelectedIssueId(asIssueId('iss_2'))
    expect(engine.getSnapshot().issueVisitBaseline).toMatchObject({
      issueId: 'iss_2',
      readAt: second.readAt,
    })

    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' })
    document.dispatchEvent(new Event('visibilitychange'))
    expect(engine.getSnapshot().issueVisitBaseline).toBeNull()
    const visibleReadAt = engine.getSnapshot().issues.find((issue) => issue.id === 'iss_2')?.readAt

    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' })
    document.dispatchEvent(new Event('visibilitychange'))
    expect(engine.getSnapshot().issueVisitBaseline).toMatchObject({
      issueId: 'iss_2',
      readAt: visibleReadAt,
    })
  })
})


describe('host metrics isolation', () => {
  it('measures snapshot publishes, slice derivations and React commits against the old frame path', async () => {
    ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
    const results = []
    for (const legacy of [true, false]) {
      const { engine, hub } = makeEngine()
      engine.start()
      await settle()
      // Counterfactual: reinstall the exact old frame handler alongside the new
      // telemetry path. Without isolation these same instruments MUST move.
      const undo = legacy ? hub.on('hostMetrics', (metrics) => {
        ;(engine as unknown as { apply(patch: object): void }).apply({ hostMetrics: metrics })
      }) : () => {}
      const publisher = createSlicePublisher(engine.getSnapshot)
      const slice = { name: 'snapshotProbe', derive: (s: ReturnType<typeof engine.getSnapshot>) => ({ sessions: s.sessions }) }
      publisher.read(slice)
      let publishes = 0
      const off = engine.subscribe(() => { publishes++; publisher.read(slice) })
      const commits = { snapshot: 0, metrics: 0 }
      function SnapshotReader() {
        useSyncExternalStore(engine.subscribe, engine.getSnapshot)
        return null
      }
      function MetricsReader() {
        const metrics = useSyncExternalStore(engine.hostMetrics.subscribe, engine.hostMetrics.getSnapshot)
        return createElement('span', null, metrics[0]?.hostname ?? '')
      }
      const root = render(createElement('div', null,
        createElement(Profiler, { id: 'snapshot', onRender: () => commits.snapshot++ }, createElement(SnapshotReader)),
        createElement(Profiler, { id: 'metrics', onRender: () => commits.metrics++ }, createElement(MetricsReader)),
      ))
      commits.snapshot = 0
      commits.metrics = 0
      const before = publisher.derivations().snapshotProbe!
      for (let frame = 1; frame <= 3; frame++) {
        await act(async () => hub.emit('hostMetrics', [{ hostname: `host-${frame}` }] as HostMetricsWire[]))
        expect(root.container.textContent).toBe(`host-${frame}`)
      }
      const counts = { publishes, derivations: publisher.derivations().snapshotProbe! - before, ...commits }
      results.push({ legacy, ...counts })
      expect(counts).toEqual({ publishes: legacy ? 3 : 0, derivations: legacy ? 3 : 0, snapshot: legacy ? 3 : 0, metrics: 3 })
      await act(async () => root.unmount())
      off()
      undo()
      engine.destroy()
    }
    console.info('hostMetrics-frame before/after (3 frames)', results)
  })

  it('drops metrics and retained callbacks at the principal boundary', async () => {
    const old = makeEngine({ principal: 'old-user' })
    const callbacks: Array<(...args: unknown[]) => void> = []
    const on = old.hub.on.bind(old.hub)
    vi.spyOn(old.hub, 'on').mockImplementation((kind, cb) => {
      if (kind === 'hostMetrics') callbacks.push(cb)
      return on(kind, cb)
    })
    old.engine.start()
    await settle()
    old.hub.emit('hostMetrics', [{ hostname: 'private-host' }])
    const listener = vi.fn()
    old.engine.hostMetrics.subscribe(listener)
    old.engine.destroy()
    expect(old.engine.hostMetrics.getSnapshot()).toEqual([])
    for (const cb of callbacks) cb([{ hostname: 'late-private-host' }])
    expect(old.engine.hostMetrics.getSnapshot()).toEqual([])
    expect(listener).not.toHaveBeenCalled()
    const next = makeEngine({ principal: 'new-user' })
    expect(next.engine.hostMetrics).not.toBe(old.engine.hostMetrics)
    expect(next.engine.hostMetrics.getSnapshot()).toEqual([])
    next.engine.start()
    await settle()
    next.hub.emit('hostMetrics', [{ hostname: 'new-host' }])
    expect(next.engine.hostMetrics.getSnapshot()).toEqual([{ hostname: 'new-host' }])
    expect(old.engine.hostMetrics.getSnapshot()).toEqual([])
    next.engine.destroy()
  })
})

describe('opt-in runtime publication diagnostics', () => {
  it('retains the union of changed keys without a separate reaction publication', async () => {
    const { storeStats, readStoreStats } = await import('../perf/store-stats')
    const { engine } = makeEngine()
    // Controlled reaction isolates the nesting boundary from unrelated timers.
    const seam = engine as unknown as {
      apply(patch: Record<string, unknown>): void
      react(keys: ReadonlySet<string>): void
    }
    const reaction = vi.spyOn(seam, 'react').mockImplementation((keys) => {
      if (keys.has('view')) seam.apply({ coarseNow: 123 })
    })
    let wakes = 0
    const off = engine.subscribe(() => wakes++)
    try {
      storeStats.reset()
      storeStats.enable()
      seam.apply({ view: 'issues' })
      expect(readStoreStats().publishes).toMatchObject([
        { changedKeys: ['view', 'coarseNow'], nested: false, subscriberWakes: 1 },
      ])
      expect(readStoreStats().runtimes[0]).toMatchObject({
        publishes: 1,
        nestedPublishes: 0,
        subscriberWakes: 1,
      })
      expect(wakes).toBe(1)
      seam.apply({ view: 'issues' })
      expect(readStoreStats().publishes).toHaveLength(1)
      storeStats.enable(false)
      seam.apply({ view: 'workspace' })
      expect(wakes).toBe(2)
      expect(readStoreStats().publishes).toHaveLength(1)
    } finally {
      reaction.mockRestore()
      off()
      engine.destroy()
      storeStats.enable(false)
      storeStats.reset()
    }
  })
})


describe('shared session index', () => {
  it('the reaction table shares a build without ID scans and still follows and marks read', () => {
    const { engine } = makeEngine()
    const original = { ...session('s1', '/before'), issueId: asIssueId('old') }
    const moved = { ...original, cwd: '/after', issueId: asIssueId('new'), unread: true }
    const sessions = [moved]
    const find = vi.spyOn(sessions, 'find')
    const state = {
      ...engine.getSnapshot(), sessions, paneA: moved.sessionId, focusedPane: 'A',
      selectedWorktree: '/before', selectedIssueId: original.issueId, workspaces: {},
      repos: [{ ...KNOWN_REPO, path: '/after', worktrees: [] }],
    } as EngineState
    const publish = vi.fn()
    const info = vi.fn()
    const markSessionRead = vi.fn()
    const reactions = new Reactions({
      state: () => state, publish, notices: { info, error: vi.fn() },
      hub: {} as SocketHub, markSessionRead, markIssueRead: vi.fn(), isVisible: () => true,
    })
    reactions.seedCwds([original])
    reactions.seedIssueIds([original])
    storeStats.reset()
    storeStats.enable()
    try {
      reactions.worktreeFollow()
      reactions.sessionIssueFollow()
      reactions.updateMarkReadTimer() // also exercises fireMarkSessionRead
      expect(find).not.toHaveBeenCalled()
      expect(readStoreStats().runtimes.reduce((n, c) => n + (c.slices.sessionById ?? 0), 0)).toBe(1)
      expect(info).toHaveBeenCalledWith('s1 moved worktree', '/after')
      expect(publish).toHaveBeenCalledWith(expect.objectContaining({ selectedIssueId: moved.issueId }))
      expect(markSessionRead).toHaveBeenCalledWith(moved.sessionId)
    } finally {
      reactions.dispose()
      engine.destroy()
      storeStats.enable(false)
      storeStats.reset()
      find.mockRestore()
    }
  })

  it('indexes effective optimistic inserts and their removal without retaining absent rows', () => {
    const base = [session('base', '/w')]
    const pending = session('pending', '/w')
    const effective = foldOverlays(base, [insertOverlay('sessions', pending.sessionId, pending)], (s) => s.sessionId).rows
    expect(sessionById(base).get(pending.sessionId)).toBeUndefined()
    expect(sessionById(effective).get(pending.sessionId)).toBe(pending)
    expect(sessionById(effective).get(base[0]!.sessionId)).toBe(base[0])
    const retired = foldOverlays(base, [], (s) => s.sessionId).rows
    expect(sessionById(retired).get(pending.sessionId)).toBeUndefined()
    expect(sessionById([pending]).get(pending.sessionId)).toBe(pending)
  })
})

// Same issue click, real runtime/reactions, old setters versus planned commit.
describe('atomic navigation publication', () => {
  it.each(['warm', 'first-open'] as const)('A/B %s: one navigation publication with identical destination and focus report', async (scenario) => {
    const { storeStats, readRuntimeStoreStats, readStoreStats } = await import('../perf/store-stats')
    const results = []
    const readPublications = []
    for (const legacy of [true, false]) {
      const { engine, hub, rw } = makeEngine({ url: '/issues' })
      engine.start()
      await settle()
      const issue = { id: asIssueId('nav-issue'), title: 'Navigation', stage: 'in_progress',
        readAt: '2026-09-02T00:00:00Z', createdAt: '2026-09-01T00:00:00Z', updatedAt: '2026-09-01T00:00:00Z',
        archived: false, worktreePath: '/tmp/known-repo/.worktrees/wt1' } as IssueWire
      const session = { sessionId: asSessionId('nav-session'), cwd: issue.worktreePath,
        issueId: issue.id, name: 'Navigation', unread: false } as SessionMeta
      engine.replica.applyChanges('issues', [issue], [])
      engine.replica.applyChanges('sessions', [session], [])
      await settle()
      if (scenario === 'warm') {
        // A1's warm path: both layouts already exist in the same worktree,
        // and the workspace surface is already open. No first-open/view switch.
        const otherIssue = { ...issue, id: asIssueId('other-issue') }
        const otherSession = { ...session, sessionId: asSessionId('other-session'), issueId: otherIssue.id }
        engine.replica.applyChanges('issues', [otherIssue], [])
        engine.replica.applyChanges('sessions', [otherSession], [])
        await settle()
        engine.getSnapshot().navigateWorkspace({ selectedIssueId: issue.id,
          selectedWorktree: issue.worktreePath, tabId: session.sessionId, firstPane: true })
        engine.getSnapshot().navigateWorkspace({ selectedIssueId: otherIssue.id,
          selectedWorktree: issue.worktreePath, tabId: otherSession.sessionId, firstPane: true })
      }
      const focusBefore = hub.viewStates.length
      const snapshots: Array<ReturnType<typeof engine.getSnapshot>> = []
      const off = engine.subscribe(() => snapshots.push(engine.getSnapshot()))
      storeStats.enable(); storeStats.reset()
      const window = storeStats.begin('gesture')
      const actions = engine.getSnapshot()
      if (legacy) {
        actions.setSelectedIssueId(issue.id)
        actions.setSelectedWorktree(issue.worktreePath)
        actions.setPane('A', session.sessionId)
        const router = (engine as unknown as { router: Router }).router
        router.navigate({ ...routeDefaults('workspace'), worktree: router.current().worktree, pane: router.current().pane })
      } else {
        actions.navigateWorkspace({ selectedIssueId: issue.id, selectedWorktree: issue.worktreePath,
          tabId: session.sessionId, firstPane: true })
      }
      storeStats.end(window)
      const final = engine.getSnapshot()
      const result = { publishes: readRuntimeStoreStats(engine)?.publishes,
        selected: final.selectedIssueId, pane: final.paneA, view: final.view,
        focus: hub.viewStates.length - focusBefore, url: rw.url(), baseline: final.issueVisitBaseline?.issueId }
      results.push(result)
      if (!legacy) {
        expect(snapshots).toHaveLength(1)
        expect(snapshots[0]).toMatchObject({ selectedIssueId: issue.id, paneA: session.sessionId,
          view: 'workspace', issueVisitBaseline: { issueId: issue.id } })
        const writes = rw.writes.length
        actions.navigateWorkspace({ selectedIssueId: issue.id, selectedWorktree: issue.worktreePath,
          tabId: session.sessionId, firstPane: true })
        expect(snapshots).toHaveLength(1)
        expect(rw.writes).toHaveLength(writes)
      }
      off()
      storeStats.reset()
      const optimisticWindow = storeStats.begin('gesture')
      await actions.markIssueRead(issue.id)
      await settle()
      storeStats.end(optimisticWindow)
      const optimistic = readStoreStats().publishes.filter((p) => p.changedKeys.includes('issues')).length
      expect(engine.getSnapshot().issues.find((i) => i.id === issue.id)?.readAt).not.toBe(issue.readAt)
      storeStats.reset()
      const networkWindow = storeStats.begin('feed')
      engine.replica.applyChanges('issues', [{ ...issue, readAt: '2099-01-01T00:00:00.000Z' }], [])
      await settle()
      storeStats.end(networkWindow)
      const network = readStoreStats().publishes.filter((p) => p.changedKeys.includes('issues')).length
      readPublications.push({ optimistic, network })
      storeStats.enable(false); engine.destroy()
    }
    expect(results).toEqual([
      { publishes: scenario === 'warm' ? 1 : 4, selected: 'nav-issue', pane: 'nav-session', view: 'workspace', focus: 1,
        url: '/workspace?wt=%2Ftmp%2Fknown-repo%2F.worktrees%2Fwt1&pane=nav-session', baseline: 'nav-issue' },
      { publishes: 1, selected: 'nav-issue', pane: 'nav-session', view: 'workspace', focus: 1,
        url: '/workspace?wt=%2Ftmp%2Fknown-repo%2F.worktrees%2Fwt1&pane=nav-session', baseline: 'nav-issue' },
    ])
    expect(readPublications[0]!.optimistic).toBeGreaterThan(0)
    expect(readPublications[0]!.network).toBeGreaterThan(0)
    expect(readPublications[1]).toEqual(readPublications[0])
    console.info('B1 navigation A/B', { scenario, navigation: results, readPublications })
    storeStats.reset()
  })

  it('history failure leaves the snapshot, selection and reactions untouched', async () => {
    const { engine, rw, hub } = makeEngine({ url: '/issues' })
    engine.start(); await settle()
    const before = engine.getSnapshot()
    const focus = hub.viewStates.length
    vi.spyOn(rw.win.history, 'pushState').mockImplementation(() => { throw new Error('history failed') })
    expect(() => before.navigateWorkspace({ selectedIssueId: asIssueId('unknown') })).toThrow('history failed')
    expect(engine.getSnapshot()).toBe(before)
    expect(hub.viewStates).toHaveLength(focus)
    engine.destroy()
  })

  it('nested batches defer snapshots but expose immediate state, last-write wins, and union keys', () => {
    const { engine } = makeEngine()
    const seam = engine as unknown as { batch(fn: () => void): void; apply(p: object): void; react(k: ReadonlySet<string>): void; state: EngineState }
    const reaction = vi.spyOn(seam, 'react').mockImplementation(() => {})
    const before = engine.getSnapshot()
    const subscriber = vi.fn()
    engine.subscribe(subscriber)
    seam.batch(() => {
      seam.apply({ paletteOpen: true })
      seam.batch(() => seam.apply({ coarseNow: 123 }))
      seam.apply({ coarseNow: 456 })
      expect(engine.getSnapshot()).toBe(before)
      expect(seam.state).toMatchObject({ paletteOpen: true, coarseNow: 456 })
      expect(subscriber).not.toHaveBeenCalled()
    })
    expect(subscriber).toHaveBeenCalledTimes(1)
    expect(reaction).toHaveBeenCalledWith(new Set(['paletteOpen', 'coarseNow']))
    expect(engine.getSnapshot()).toMatchObject({ paletteOpen: true, coarseNow: 456 })
    engine.destroy()
  })
})

// Frozen pre-B2 pipeline, used only as a negative control. The same real replica,
// reactions and outbox run in both arms; production has no disable switch.
type PublicationSeam = {
  state: EngineState
  apply(patch: Partial<EngineState>): void
  batch(fn: () => void): void
  react(keys: ReadonlySet<keyof EngineState>): void
  buildSnapshot(): ReturnType<ReturnType<typeof makeEngine>['engine']['getSnapshot']>
  subStore: { publish(snapshot: ReturnType<PublicationSeam['buildSnapshot']>, keys: ReadonlySet<keyof EngineState>, nested: boolean): void }
  batchDepth: number
  statsReactionDepth: number
}
function legacyPublications(engine: ReturnType<typeof makeEngine>['engine']): () => void {
  const seam = engine as unknown as PublicationSeam
  let depth = 0
  let reacting = 0
  let pending: Partial<EngineState> | null = null
  const apply = vi.spyOn(seam, 'apply').mockImplementation((patch) => {
    if (engine.isDestroyed) return
    if (depth > 0) { pending = { ...pending, ...patch }; return }
    const changed = new Set<keyof EngineState>()
    for (const key of Object.keys(patch) as Array<keyof EngineState>) {
      if (!Object.is(seam.state[key], patch[key])) {
        ;(seam.state as unknown as Record<string, unknown>)[key] = patch[key]
        changed.add(key)
      }
    }
    if (!changed.size) return
    seam.subStore.publish(seam.buildSnapshot(), changed, reacting > 0)
    reacting++
    try { seam.react(changed) } finally { reacting-- }
  })
  const batch = vi.spyOn(seam, 'batch').mockImplementation((fn) => {
    depth++
    try { fn() } finally {
      depth--
      if (depth === 0) {
        const patch = pending
        pending = null
        if (patch) seam.apply(patch)
      }
    }
  })
  // Remove only B2's outer outbox wrapper. Optimism's pre-existing inner batch
  // still runs through the frozen implementation above.
  const originalSubscribe = engine.outbox.subscribe.bind(engine.outbox)
  const subscribe = vi.spyOn(engine.outbox, 'subscribe').mockImplementation((listener) =>
    originalSubscribe((size) => {
      batch.mockImplementationOnce((fn) => fn())
      listener(size)
    }),
  )
  return () => { subscribe.mockRestore(); batch.mockRestore(); apply.mockRestore() }

}

describe('coalesced outbox and reaction publications', () => {
  it.each(['outbox', 'fallback', 'worktree-follow', 'issue-follow', 'prune', 'visit-baseline', 'session-read', 'issue-read'] as const)(
    'A/B %s preserves reaction outcomes and publishes once', async (scenario) => {
      const results = []
      for (const legacy of [true, false]) {
        const api = makeApi()
        // Keep network completion outside this event's measurement window.
        api.sessions.rename.mutate = vi.fn(() => new Promise(() => {}))
        api.sessions.markRead.mutate = vi.fn(() => new Promise(() => {}))
        api.issues.markRead.mutate = vi.fn(() => new Promise(() => {}))
        const { engine, hub } = makeEngine({ api, url: '/workspace', workspacePruneGraceMs: 0 })
        const restore = legacy ? legacyPublications(engine) : () => {}
        engine.start()
        await settle()
        const oldId = asIssueId('b2-old')
        const newId = asIssueId('b2-new')
        const issue = { id: oldId, title: 'B2', stage: 'in_progress', archived: false,
          createdAt: '2025-01-01T00:00:00Z', updatedAt: '2025-01-01T00:00:00Z',
          readAt: '2099-01-01T00:00:00Z' } as IssueWire
        const row = { ...session('b2-session', scenario === 'fallback' ? '/unregistered' : '/tmp/known-repo'),
          issueId: oldId, readAt: '2099-01-01T00:00:00Z' } as SessionMeta
        if (scenario !== 'visit-baseline') {
          engine.replica.applyChanges('issues', [issue, { ...issue, id: newId }], [])
        }
        engine.replica.applyChanges('sessions', [row], [])
        await settle()
        engine.getSnapshot().navigateWorkspace({ selectedIssueId: oldId,
          selectedWorktree: row.cwd, tabId: row.sessionId, firstPane: true })
        await settle()
        const oldKey = engine.getSnapshot().workspaceKey()
        hub.viewStates.length = 0
        const seen: Array<ReturnType<typeof engine.getSnapshot>> = []
        const off = engine.subscribe(() => seen.push(engine.getSnapshot()))
        storeStats.reset(); storeStats.enable()
        const capture = storeStats.begin(scenario === 'outbox' ? 'gesture' : 'feed')
        try {
          switch (scenario) {
            case 'outbox':
              engine.outbox.enqueue('rename', { sessionId: row.sessionId, name: 'renamed' })
              break
            case 'fallback':
            case 'prune':
              engine.replica.applyChanges('sessions', [], [row.sessionId])
              break
            case 'worktree-follow':
              engine.replica.applyChanges('sessions', [{ ...row, cwd: '/tmp/known-repo/.worktrees/wt1' }], [])
              break
            case 'issue-follow':
              engine.replica.applyChanges('sessions', [{ ...row, issueId: newId }], [])
              break
            case 'visit-baseline':
              engine.replica.applyChanges('issues', [issue], [])
              break
            case 'session-read':
              engine.replica.applyChanges('sessions', [{ ...row, lastActiveAt: '2026-07-01T00:01:00Z', readAt: null, unread: true }], [])
              break
            case 'issue-read':
              engine.replica.applyChanges('issues', [{ ...issue, updatedAt: '2100-07-01T00:01:00Z' }], [])
              break
          }
          // Replica notifications and reactions are synchronous. End this
          // event before the optimistic action's post-await handoff (POD-4351).
          storeStats.end(capture)
          const st = engine.getSnapshot()
          const publications = readStoreStats().publishes.length
          expect(publications).toBe(seen.length)
          if (legacy) expect(publications).toBeGreaterThan(1)
          else expect(publications).toBe(1)
          if (scenario === 'outbox') {
            expect(st.outboxSize).toBe(1)
            expect(st.sessions[0]?.name).toBe('renamed')
          }
          if (scenario === 'fallback') expect(st.selectedWorktree).toBe('/tmp/known-repo')
          if (scenario === 'worktree-follow') expect(st.selectedWorktree).toBe('/tmp/known-repo/.worktrees/wt1')
          if (scenario === 'issue-follow') {
            expect(st.selectedIssueId).toBe(newId)
            expect(st.paneA).toBe(row.sessionId)
            expect(allTabIds(st.workspaces[oldKey]!)).not.toContain(row.sessionId)
            expect(st.issueVisitBaseline?.issueId).toBe(newId)
            expect(hub.viewStates.at(-1)?.visible).toContain(row.sessionId)
          }
          if (scenario === 'prune') expect(st.paneA).toBeNull()
          if (scenario === 'visit-baseline') expect(st.issueVisitBaseline?.issueId).toBe(oldId)
          if (scenario === 'session-read') expect(st.sessions[0]?.unread).toBe(false)
          if (scenario === 'issue-read') expect(st.issues.find((i) => i.id === oldId)?.readAt).not.toBe(issue.readAt)
          results.push({ publications, selectedWorktree: st.selectedWorktree, selectedIssueId: st.selectedIssueId,
            paneA: st.paneA, paneB: st.paneB, baseline: st.issueVisitBaseline?.issueId,
            tabs: Object.values(st.workspaces).map((ws) => allTabIds(ws)),
            reports: hub.viewStates, sessionReads: api.sessions.markRead.mutate.mock.calls.length,
            issueReads: api.issues.markRead.mutate.mock.calls.length })
        } finally {
          off(); storeStats.enable(false); storeStats.reset()
          await settle() // drain post-event action continuations before teardown
          engine.destroy(); restore()
        }
      }
      expect({ ...results[0], publications: 1 }).toEqual(results[1])
      process.stdout.write(`B2 publication A/B ${scenario}: ${results.map((r) => r.publications).join(' -> ')}\n`)
    },
  )

  it('keeps copied-listener unsubscribe semantics during the folded publication', () => {
    const { engine } = makeEngine()
    const seam = engine as unknown as PublicationSeam
    const calls: string[] = []
    let offSecond = () => {}
    engine.subscribe(() => { calls.push('first'); offSecond() })
    offSecond = engine.subscribe(() => calls.push('second'))
    seam.batch(() => { seam.apply({ paletteOpen: true }); seam.apply({ coarseNow: 123 }) })
    expect(calls).toEqual(['first', 'second'])
    seam.apply({ coarseNow: 456 })
    expect(calls).toEqual(['first', 'second', 'first'])
    engine.destroy()
  })

  it('restores batch and reaction depths after a nested reaction throws', () => {
    const { engine } = makeEngine()
    const seam = engine as unknown as PublicationSeam
    const reaction = vi.spyOn(seam, 'react').mockImplementation((changed) => {
      if (changed.has('paletteOpen')) seam.apply({ coarseNow: 123 })
      else throw new Error('reaction failed')
    })
    const listener = vi.fn()
    engine.subscribe(listener)
    expect(() => seam.batch(() => seam.apply({ paletteOpen: true }))).toThrow('reaction failed')
    expect(seam.batchDepth).toBe(0)
    expect(seam.statsReactionDepth).toBe(0)
    expect(engine.getSnapshot()).toMatchObject({ paletteOpen: true, coarseNow: 123 })
    expect(listener).toHaveBeenCalledTimes(1)
    reaction.mockRestore()
    seam.apply({ coarseNow: 456 })
    expect(engine.getSnapshot().coarseNow).toBe(456)
    expect(listener).toHaveBeenCalledTimes(2)
    engine.destroy()
  })
})


// Frozen pre-B11 pure fold: the production runtime, outbox and B2 batching are
// identical in both arms. Removing fold reuse MUST fail the new budget.
function legacyOptimisticFolds(engine: ReturnType<typeof makeEngine>['engine']): () => void {
  const ledger = (engine as unknown as { optimism: OptimismLedger<PodiumClientApi> }).optimism
  const seam = ledger as unknown as {
    foldStable(entity: OverlayEntity, base: object[], keyOf: (row: object) => string): ReturnType<typeof foldOverlays>
  }
  const spy = vi.spyOn(seam, 'foldStable').mockImplementation((entity, base, keyOf) =>
    foldOverlays(base, ledger.overlaysFor(entity), keyOf))
  return () => spy.mockRestore()
}

const b11Issue = () => ({ id: asIssueId('b11-issue'), title: 'B11', stage: 'in_progress',
  archived: false, createdAt: '2025-01-01T00:00:00Z', updatedAt: '2025-01-01T00:00:00Z',
  readAt: null }) as IssueWire

function b11Counts(entity: 'issues' | 'sessions') {
  const records = readStoreStats().publishes
  const affected = records.filter((p) => p.changedKeys.includes(entity))
  return { publications: records.length, entityPublications: affected.length,
    readerWakes: records.reduce((n, p) => n + p.subscriberWakes, 0),
    entityReaderWakes: affected.reduce((n, p) => n + p.subscriberWakes, 0) }
}

describe('stable optimistic folds (B11)', () => {
  it.each(['read', 'rename', 'reaction-read'] as const)(
    'A/B %s separates synchronous publication, async handoff, resolution and echo', async (scenario) => {
      const results: Array<{
        sync: ReturnType<typeof b11Counts>
        handoff: ReturnType<typeof b11Counts>
        resolution: ReturnType<typeof b11Counts>
        echo: ReturnType<typeof b11Counts>
        instant: string | null | undefined
        final: string | null | undefined
        queued: Array<{ kind: string; input: unknown; baseline?: string; chained?: boolean }>
        baseline: Pick<NonNullable<EngineState['issueVisitBaseline']>, 'issueId' | 'readAt'> | null
      }> = []
      for (const legacy of [true, false]) {
        const clock = vi.spyOn(Date, 'now').mockReturnValue(Date.parse('2026-09-18T12:00:00Z'))
        const api = makeApi()
        let confirm!: () => void
        const response = new Promise<void>((resolve) => { confirm = resolve })
        api.issues.markRead.mutate = vi.fn(() => response)
        api.sessions.rename.mutate = vi.fn(() => response)
        const { engine } = makeEngine({ api, url: '/workspace' })
        const restore = legacy ? legacyOptimisticFolds(engine) : () => {}
        const offs: Array<() => void> = []
        try {
          engine.start(); await settle(40)
          const issue = b11Issue()
          const row = session('b11-session', '/tmp/known-repo')
          if (scenario === 'reaction-read') issue.readAt = '2099-01-01T00:00:00Z'
          engine.replica.applyChanges('issues', [issue], [])
          engine.replica.applyChanges('sessions', [row], [])
          await settle()
          if (scenario === 'reaction-read') {
            engine.getSnapshot().navigateWorkspace({ selectedIssueId: issue.id,
              selectedWorktree: row.cwd, firstPane: true })
            await settle()
          }
          // The measured 23-reader cohort is explicitly installed, not inferred
          // from publication count. A2 records every actual callback wake.
          for (let i = 0; i < 23; i++) offs.push(engine.subscribe(() => {}))
          const entity = scenario === 'rename' ? 'sessions' : 'issues'
          const painted = () => scenario === 'rename' ? engine.getSnapshot().sessions[0]?.name
            : engine.getSnapshot().issues[0]?.readAt
          const phase = () => { const counts = b11Counts(entity); storeStats.reset(); return counts }
          const visitBaseline = engine.getSnapshot().issueVisitBaseline
          storeStats.reset(); storeStats.enable()
          let command: Promise<void> | undefined
          if (scenario === 'reaction-read') {
            engine.replica.applyChanges('issues', [{ ...issue, updatedAt: '2100-01-01T00:00:00Z' }], [])
          } else if (scenario === 'rename') {
            command = engine.getSnapshot().renameSession(row.sessionId, 'renamed')
          } else command = engine.getSnapshot().markIssueRead(issue.id)
          const sync = phase()
          const instant = painted()
          expect(instant).toBe(scenario === 'rename' ? 'renamed' : '2026-09-18T12:00:00.000Z')
          const entries = engine.outbox.pending()
          const queued = entries.map(({ kind, input, baseline, chained }) => ({ kind, input, baseline, chained }))
          expect(queued).toHaveLength(1)
          await command; await settle()
          const handoff = phase()
          expect(painted()).toBe(instant)
          confirm(); await settle()
          const resolution = phase()
          expect(painted()).toBe(instant)
          expect(engine.outbox.size()).toBe(0)
          expect(engine.outbox.awaiting()).toHaveLength(1)
          if (scenario === 'rename') engine.replica.applyChanges('sessions', [{ ...row, name: 'renamed' }], [])
          else engine.replica.applyChanges('issues', [{ ...issue, readAt: '2026-09-18T12:00:01.000Z' }], [])
          const echo = phase()
          const final = painted()
          expect(final).toBe(scenario === 'rename' ? 'renamed' : '2026-09-18T12:00:01.000Z')
          expect(engine.outbox.awaiting()).toHaveLength(0)
          const assertBudget = () => {
            expect(handoff.entityPublications).toBe(0)
            expect(sync.entityPublications + handoff.entityPublications + resolution.entityPublications).toBe(1)
          }
          if (legacy) expect(assertBudget).toThrow()
          else assertBudget()
          if (scenario === 'reaction-read') expect(sync.publications).toBe(1) // B2 boundary stays separate
          expect(engine.getSnapshot().issueVisitBaseline).toEqual(visitBaseline)
          const calls = scenario === 'rename' ? api.sessions.rename.mutate.mock.calls : api.issues.markRead.mutate.mock.calls
          expect(calls).toEqual([[{ ...(entries[0]!.input as object), mutationId: entries[0]!.mutationId }]])
          results.push({ sync, handoff, resolution, echo, instant, final, queued,
            baseline: visitBaseline && { issueId: visitBaseline.issueId, readAt: visitBaseline.readAt } })
        } finally {
          offs.forEach((off) => off()); engine.destroy(); restore(); clock.mockRestore()
          storeStats.enable(false); storeStats.reset()
        }
      }
      const controls = ({ instant, final, queued, baseline }: typeof results[number]) => ({ instant, final, queued, baseline })
      expect(controls(results[0]!)).toEqual(controls(results[1]!))
      const total = (r: typeof results[number]) => r.sync.entityPublications + r.handoff.entityPublications + r.resolution.entityPublications
      expect(total(results[1]!)).toBeLessThan(total(results[0]!))
      process.stdout.write(`B11 ${scenario} A/B: ${JSON.stringify(results.map(({ sync, handoff, resolution, echo }) => ({ sync, handoff, resolution, echo })))}\n`)
    },
  )

  it.each(['sync-failure', 'persistence-failure', 'async-rejection', 'server-rejection', 'offline'] as const)(
    'A/B %s preserves read command failure and durability behavior', async (scenario) => {
      const results = []
      for (const legacy of [true, false]) {
        const storage = memoryStorage()
        const api = makeApi()
        if (scenario === 'offline') api.issues.markRead.mutate = vi.fn(async () => { throw new Error('offline') })
        if (scenario === 'server-rejection') api.issues.markRead.mutate = vi.fn(async () => {
          throw Object.assign(new Error('bad input'), { data: { code: 'BAD_REQUEST', httpStatus: 400 } })
        })
        const { engine, errors } = makeEngine({ api, storage })
        const restore = legacy ? legacyOptimisticFolds(engine) : () => {}
        let enqueue: ReturnType<typeof vi.spyOn> | undefined
        try {
          engine.start(); await settle(40)
          const issue = b11Issue()
          engine.replica.applyChanges('issues', [issue], []); await settle()
          const failure = new Error('persistence refused')
          if (scenario === 'persistence-failure') {
            const seam = engine.outbox as unknown as { storage: { save(entries: unknown[]): void } }
            enqueue = vi.spyOn(seam.storage, 'save').mockImplementation(() => { throw failure })
          }
          if (scenario === 'sync-failure') enqueue = vi.spyOn(engine.outbox, 'enqueue').mockImplementation(() => { throw failure })
          if (scenario === 'async-rejection') {
            // Exercise the async port contract even though today's outbox is sync.
            enqueue = vi.spyOn(engine.outbox, 'enqueue').mockImplementation(() =>
              Promise.reject(failure) as unknown as ReturnType<typeof engine.outbox.enqueue>)
          }
          const command = engine.getSnapshot().markIssueRead(issue.id)
          if (scenario === 'sync-failure' || scenario === 'persistence-failure' || scenario === 'async-rejection') await expect(command).rejects.toBe(failure)
          else await command
          await settle()
          const read = engine.getSnapshot().issues[0]?.readAt != null
          // A real storage refusal retains the in-memory entry (POD-1231),
          // but still rejects: only a pre-enqueue rejection removes all paint.
          expect(read).toBe(scenario === 'offline' || scenario === 'persistence-failure')
          expect(engine.outbox.size()).toBe(scenario === 'offline' || scenario === 'persistence-failure' ? 1 : 0)
          const queued = engine.outbox.pending().map(({ kind, input }) => ({ kind, input }))
          if (scenario === 'offline') {
            expect(queued).toEqual([{ kind: 'issueMarkRead', input: { id: issue.id } }])
            engine.dispose()
            const reload = makeEngine({ api, storage }).engine
            try {
              expect(reload.getSnapshot().issues[0]?.readAt).toBeTruthy()
              expect(reload.outbox.pending()).toHaveLength(1)
              expect(reload.replica.rows('issues')[0]?.readAt).toBeNull()
            } finally { reload.destroy() }
          }
          results.push({ read, queued, errors, dead: engine.outbox.deadLetters().map((d) => d.reason) })
        } finally { enqueue?.mockRestore(); engine.destroy(); restore() }
      }
      expect(results[0]).toEqual(results[1])
    },
  )
})

// D4: append-only shared runtime evidence. Real outbox + settled runtime boundary.
describe('optimistic effective runtime publication', () => {
  function pilot(enabled = true) {
    const replica = createReplica({ storage: memoryStorage() })
    replica.applyChanges('sessions', [session('d4-session', '/w')], [])
    const api = makeApi()
    const engine = createClientRuntime({
      principal: asClientPrincipal(asUserId('d4-operator')),
      config: { httpOrigin: 'http://x', wsClientUrl: 'ws://x' },
      api: api as PodiumClientApi, onFatalError: () => {}, createReplicaFn: () => replica,
      createHub: () => new FakeHub() as unknown as SocketHub,
      routerWindow: makeRouterWindow('/').win, networkEnabled: false,
      effectiveChanges: enabled, spawnConfirmGraceMs: 0,
    })
    const events: import('./effective-changes').EffectivePublication[] = []
    engine.effectiveChanges?.subscribe((event) => {
      // Both APIs have installed the SAME snapshot before any consumer runs.
      expect(event.view.commit).toBe(engine.getSnapshot())
      events.push(event)
    })
    return { engine, events, api }
  }

  it('is disabled by default and has no pilot reader when opted out', async () => {
    const { engine } = makeEngine()
    expect(engine.effectiveChanges).toBeUndefined()
    engine.destroy()
    const off = pilot(false)
    try {
      off.engine.start()
      off.engine.getSnapshot().renameSession(asSessionId('d4-session'), 'offline')
      await settle()
      expect(off.engine.effectiveChanges).toBeUndefined()
      expect(nameOf(off.engine, 'd4-session')).toBe('offline')
    } finally { off.engine.destroy() }
  })

  it('publishes offline enqueue, recovery edit and discard through the same contract', async () => {
    const { engine, events } = pilot()
    try {
      engine.start()
      await settle()
      events.length = 0
      engine.getSnapshot().renameSession(asSessionId('d4-session'), 'offline')
      await settle()
      const painted = events.find((e) => e.view.row('sessions', 'd4-session')?.name === 'offline')!
      expect(painted).toMatchObject({ type: 'update', rows: [{ kind: 'sessions', id: 'd4-session', presence: 'present' }] })
      const entry = engine.outbox.pending()[0]!
      engine.getSnapshot().recoverOutbox.edit(entry.mutationId, { sessionId: asSessionId('d4-session'), name: 'edited' })
      await settle()
      expect(events.at(-1)!.view.row('sessions', 'd4-session')?.name).toBe('edited')
      engine.getSnapshot().recoverOutbox.discard(entry.mutationId)
      await settle()
      expect(events.at(-1)!.view.row('sessions', 'd4-session')?.name).toBeUndefined()
      // Earlier commit remains painted after later edit and rollback.
      expect(painted.view.row('sessions', 'd4-session')?.name).toBe('offline')
    } finally { engine.destroy() }
  })

  it('publishes failed enqueue rollback and keeps nested legacy writes in commit order', async () => {
    const { engine, events } = pilot()
    try {
      engine.start()
      await settle()
      const failure = new Error('disk failed')
      const enqueue = vi.spyOn(engine.outbox, 'enqueue').mockImplementationOnce(() =>
        Promise.reject(failure) as unknown as ReturnType<typeof engine.outbox.enqueue>)
      events.length = 0
      await expect(engine.getSnapshot().renameSession(asSessionId('d4-session'), 'failed paint')).rejects.toBe(failure)
      await settle()
      expect(events.some((e) => e.view.row('sessions', 'd4-session')?.name === 'failed paint')).toBe(true)
      expect(events.at(-1)!.view.row('sessions', 'd4-session')?.name).toBeUndefined()
      enqueue.mockRestore()
      const names: Array<string | undefined> = []
      const offEffective = engine.effectiveChanges!.subscribe((e) => {
        if (e.type === 'update' && e.rows.some((r) => r.kind === 'sessions'))
          names.push(e.view.row('sessions', 'd4-session')?.name ?? undefined)
      })
      let nested = false
      const offLegacy = engine.subscribe(() => {
        if (!nested && nameOf(engine, 'd4-session') === 'outer') {
          nested = true
          engine.getSnapshot().renameSession(asSessionId('d4-session'), 'nested')
        }
      })
      engine.getSnapshot().renameSession(asSessionId('d4-session'), 'outer')
      await settle()
      expect(names.slice(0, 2)).toEqual(['outer', 'nested'])
      offLegacy(); offEffective()
    } finally { engine.destroy() }
  })

  it('reports both spawn kinds only after the pair and pending state have settled', async () => {
    const { engine, events, api } = pilot()
    api.sessions.create = { mutate: async () => { throw new Error('refused') } }
    try {
      engine.start()
      await settle()
      events.length = 0
      const made = engine.getSnapshot().spawnDraftAgent({ target: { path: '/w', repoPath: '/w' }, agentKind: 'codex' })
      const event = events.find((e) => e.type === 'update' && e.rows.some((r) => r.id === made.sessionId))!
      expect(event).toMatchObject({ rows: expect.arrayContaining([
        { kind: 'sessions', id: made.sessionId, presence: 'present' },
        { kind: 'issues', id: made.issueId, presence: 'present' },
      ]) })
      expect(event.view.local('pendingSpawnIds').has(made.sessionId)).toBe(true)
      expect(event.view.row('issues', made.issueId)).toBeDefined()
      expect(await made.settled).toBe(false)
      const rollback = events.find((e) => e.type === 'update' && e.rows.some((r) => r.id === made.sessionId && r.presence === 'absent'))!
      expect(rollback.view.row('issues', made.issueId)).toBeUndefined()
      expect(rollback.view.local('pendingSpawnIds').has(made.sessionId)).toBe(false)
    } finally { engine.destroy() }
  })
})

// D3: append-only coverage of the replica -> settled effective publication seam.
describe('addressed kernel runtime publications', () => {
  async function fixture(enabled = true) {
    const { createKernelReplica, createSideCache } = await import('../replica/kernel')
    const records = new Map<string, import('@podium/sync/replica').EntityRecord>()
    const replica = createKernelReplica({
      cache: {
        readCursor: () => null,
        readEntities: () => [...records.values()],
        read: (entity, id) => records.get(`${entity}:${id}`),
        durability: () => 'durable',
      },
      side: createSideCache({ storage: memoryStorage(), enumerateKeys: () => [] }),
    })
    const engine = createClientRuntime({
      principal: asClientPrincipal(asUserId('operator')),
      config: { httpOrigin: 'http://x', wsClientUrl: 'ws://x' },
      api: makeApi() as PodiumClientApi,
      onFatalError: (message) => { throw new Error(message) },
      createReplicaFn: () => replica,
      routerWindow: makeRouterWindow('/').win,
      createHub: () => new FakeHub() as unknown as SocketHub,
      networkEnabled: false,
      ...(enabled ? { effectiveChanges: true } : {}),
    })
    engine.start()
    await settle()
    const publications: import('./effective-changes').EffectivePublication[] = []
    engine.effectiveChanges?.subscribe((publication) => publications.push(publication))
    publications.length = 0
    const upsert = (id: string, name: string) => {
      const record = { entity: 'session', entityId: id, value: { ...session(id, '/tmp/known-repo'), name }, provenance: { seq: 1 } }
      records.set(`session:${id}`, record)
      replica.onKernelEvent({ type: 'upserted', readmitted: false, record: { ...record, value: { ...record.value, name: 'stale event' } } })
    }
    const remove = (id: string) => {
      records.delete(`session:${id}`)
      replica.onKernelEvent({ type: 'removed', entity: 'session', entityId: id })
    }
    return { engine, replica, records, publications, upsert, remove }
  }

  it('delivers final addressed membership once with the existing Store commit and pinned reads', async () => {
    const { engine, replica, publications, upsert, remove } = await fixture()
    try {
      replica.batch(() => {
        upsert('kept', 'first'); remove('kept'); upsert('kept', 'final')
        upsert('gone', 'temporary'); remove('gone')
      })
      expect(publications).toHaveLength(1)
      const publication = publications[0]!
      expect(publication).toMatchObject({ type: 'update', rows: [
        { kind: 'sessions', id: 'kept', presence: 'present' },
        { kind: 'sessions', id: 'gone', presence: 'absent' },
      ] })
      expect(publication.view.commit).toBe(engine.getSnapshot())
      expect(publication.view.row('sessions', 'kept')?.name).toBe('final')
      expect(publication.view.row('sessions', 'gone')).toBeUndefined()
      upsert('kept', 'later')
      expect(publications).toHaveLength(2)
      expect(publications[1]!.view.row('sessions', 'kept')?.name).toBe('later')
      expect(publication.view.row('sessions', 'kept')?.name).toBe('final')
    } finally { engine.destroy() }
  })

  it('preserves no-visible-change exits, ignores cursors, and explicitly replaces an empty scope', async () => {
    const { engine, replica, records, publications, upsert } = await fixture()
    try {
      const before = engine.getSnapshot()
      replica.onKernelEvent({ type: 'evicted', entity: 'session', entityId: 'absent' })
      expect(engine.getSnapshot()).toBe(before)
      expect(publications).toHaveLength(1)
      expect(publications[0]).toMatchObject({ type: 'update', rows: [{ kind: 'sessions', id: 'absent', presence: 'absent' }] })
      publications.length = 0
      for (let seq = 1; seq <= 300; seq++) replica.onKernelEvent({
        type: 'cursor', cursor: { feedId: 'feed', epoch: 'epoch', seq }, watermarkOnly: true,
      })
      expect(publications).toHaveLength(0)
      upsert('old-scope', 'old')
      publications.length = 0
      records.clear()
      replica.onKernelEvent({ type: 'bootstrap-installed', cause: 'rescope', snapshotSeq: 301, entityCount: 0, bufferedFramesApplied: 0 })
      expect(publications).toHaveLength(1)
      expect(publications[0]).toMatchObject({ type: 'replace', reason: 'rescope' })
      expect(publications[0]!.view.commit).toBe(engine.getSnapshot())
      expect(publications[0]!.view.ids('sessions')).toEqual([])
      expect(publications[0]!.view.row('sessions', 'old-scope')).toBeUndefined()
    } finally { engine.destroy() }
  })

  it('keeps the effective pilot disabled by default', async () => {
    const { engine, upsert } = await fixture(false)
    try {
      expect(engine.effectiveChanges).toBeUndefined()
      upsert('legacy', 'unchanged consumer')
      expect(engine.getSnapshot().sessions[0]?.name).toBe('unchanged consumer')
    } finally { engine.destroy() }
  })
})
