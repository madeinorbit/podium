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

import type { GitRepositoryWire, HostMetricsWire, IssueWire, SessionMeta } from '@podium/protocol'
import type { SocketHub } from '@podium/terminal-client'
import { describe, expect, it, vi } from 'vitest'
import type { PodiumClientApi } from '../api'
import { createReplica, memoryStorage, type StorageApi } from '../replica/replica'
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
        query: async () => ({
          sidebar: { repoSort: 'lastUsed', repoOrder: [], groupByRepo: false },
        }),
      },
      set: { mutate: async (s: unknown) => s },
    },
    sessions: {
      rename: { mutate: vi.fn(async () => ({})) },
      markRead: { mutate: async () => ({}) },
      markUnread: { mutate: async () => ({}) },
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
  opts: { url?: string; api?: unknown; hub?: FakeHub; storage?: StorageApi } = {},
) {
  const hub = opts.hub ?? new FakeHub()
  const rw = makeRouterWindow(opts.url ?? '/')
  const fatals: string[] = []
  const errors: string[] = []
  const engine = createEngine({
    config: { httpOrigin: 'http://x', wsClientUrl: 'ws://x' },
    api: (opts.api ?? makeApi()) as PodiumClientApi,
    onFatalError: (m) => fatals.push(m),
    notices: { error: (m) => errors.push(m), info: () => {} },
    createReplicaFn: () => createReplica({ storage: opts.storage ?? memoryStorage() }),
    routerWindow: rw.win,
    createHub: () => hub as unknown as SocketHub,
  })
  return { engine, hub, rw, fatals, errors }
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
    void engine.getSnapshot().renameSession('s1', 'renamed')
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

  it('after resolution, truth that DIVERGES from the prediction retires the overlay (server wins)', async () => {
    const api = makeApi()
    const { engine } = makeEngine({ api })
    engine.start()
    await settle(40)
    engine.replica.applyChanges('sessions', [session('s1', '/w')], [])
    await settle()
    void engine.getSnapshot().renameSession('s1', 'mine')
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
    void engine.getSnapshot().renameSession('s1', 'first')
    void engine.getSnapshot().markSessionUnread('s1')
    void engine.getSnapshot().renameSession('s1', 'second')
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
    void engine.getSnapshot().renameSession('s1', 'doomed')
    expect(nameOf(engine, 's1')).toBe('doomed') // painted while queued
    await settle()
    expect(nameOf(engine, 's1')).toBeUndefined() // poison drop → overlay gone
    expect(engine.getSnapshot().outboxSize).toBe(0)
    expect(errors.some((m) => m.includes('rename'))).toBe(true)
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
    void first.engine.getSnapshot().renameSession('s1', 'renamed')
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

  it('markIssueRead paints unread=false instantly and reconciles with the server echo without flicker', async () => {
    const api = makeApi()
    const { engine } = makeEngine({ api })
    engine.start()
    await settle(40)
    const issue = { id: 'iss_1', unread: true, readAt: null } as unknown as IssueWire
    engine.replica.applyChanges('issues', [issue], [])
    await settle()
    expect(engine.getSnapshot().issues[0]?.unread).toBe(true)
    void engine.getSnapshot().markIssueRead('iss_1')
    expect(engine.getSnapshot().issues[0]?.unread).toBe(false) // instant
    await settle() // mutation resolves → awaiting truth, still painted
    expect(engine.getSnapshot().issues[0]?.unread).toBe(false)
    // Echo: the server's own readAt clock differs from the client stamp — the
    // covering predicate is the unread flag, so the overlay retires cleanly.
    engine.replica.applyChanges(
      'issues',
      [{ ...issue, unread: false, readAt: '2026-07-09T00:00:00.000Z' } as typeof issue],
      [],
    )
    await settle()
    expect(engine.getSnapshot().issues[0]?.unread).toBe(false)
    expect(engine.getSnapshot().issues[0]?.readAt).toBe('2026-07-09T00:00:00.000Z')
    expect(engine.getSnapshot().issues).toHaveLength(1)
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
