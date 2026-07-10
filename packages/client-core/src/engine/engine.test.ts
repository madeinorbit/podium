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

import type { GitRepositoryWire, HostMetricsWire } from '@podium/protocol'
import type { SocketHub } from '@podium/terminal-client'
import { describe, expect, it, vi } from 'vitest'
import type { PodiumClientApi } from '../api'
import { createReplica, memoryStorage } from '../replica/replica'
import type { RouterWindow } from '../router'
import { createEngine } from './engine'

const settle = (ms = 25): Promise<void> => new Promise((r) => setTimeout(r, ms))

// ---------------------------------------------------------------- fakes

class FakeHub {
  onCalls: string[] = []
  viewStates: Array<{ visible: string[]; focused: string | null }> = []
  disposedCount = 0
  connectCount = 0
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
  dispose(): void {
    this.disposedCount++
  }
  setViewState(visible: string[], focused: string | null): void {
    this.viewStates.push({ visible, focused })
  }
  setVisible(): void {}
  sendSessionDraft(): void {}
}

const KNOWN_REPO = {
  path: '/tmp/known-repo',
  kind: 'repository',
  branch: 'main',
  worktrees: [],
} as unknown as GitRepositoryWire

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
        mutate: vi.fn(async () => ({ repositories: [KNOWN_REPO], diagnostics: [] })),
      },
    },
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
        query: async () => ({ sidebar: { repoSort: 'lastUsed', repoOrder: [], groupByRepo: false } }),
      },
      set: { mutate: async (s: unknown) => s },
    },
    sessions: {
      rename: { mutate: vi.fn(async () => ({})) },
      markRead: { mutate: async () => ({}) },
    },
    issues: { markRead: { mutate: async () => ({}) } },
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

function makeEngine(opts: { url?: string; api?: unknown; hub?: FakeHub } = {}) {
  const hub = opts.hub ?? new FakeHub()
  const rw = makeRouterWindow(opts.url ?? '/')
  const fatals: string[] = []
  const engine = createEngine({
    config: { httpOrigin: 'http://x', wsClientUrl: 'ws://x' },
    api: (opts.api ?? makeApi()) as PodiumClientApi,
    onFatalError: (m) => fatals.push(m),
    createReplicaFn: () => createReplica({ storage: memoryStorage() }),
    routerWindow: rw.win,
    createHub: () => hub as unknown as SocketHub,
  })
  return { engine, hub, rw, fatals }
}

// ---------------------------------------------------------------- tests

describe('engine lifecycle', () => {
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
    expect(engine.getSnapshot().hostMetrics).toBe(metrics)
    engine.dispose()
    expect(fatals).toEqual([])
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
    api.discovery.refreshRepos.mutate = vi.fn(async () => ({ repositories: [], diagnostics: [] }))
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

describe('snapshot stability (useSyncExternalStore contract)', () => {
  it('getSnapshot keeps identity when nothing changed and across no-op writes', async () => {
    const { engine } = makeEngine()
    engine.start()
    await settle(40)
    const a = engine.getSnapshot()
    expect(engine.getSnapshot()).toBe(a)
    // A real change produces a new snapshot …
    a.setSessionDraft('s1', 'x')
    const b = engine.getSnapshot()
    expect(b).not.toBe(a)
    expect(b.drafts).toEqual({ s1: 'x' })
    // … but re-writing the SAME value is a no-op that keeps identity.
    b.setSessionDraft('s1', 'x')
    expect(engine.getSnapshot()).toBe(b)
    // Action identities are stable across snapshots.
    expect(b.setSessionDraft).toBe(a.setSessionDraft)
    expect(b.markSessionRead).toBe(a.markSessionRead)
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
    await engine.getSnapshot().renameSession('s1', 'renamed')
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
