// @vitest-environment happy-dom
/**
 * POD-4444 — row-source tests: one event per runtime publication, folded
 * (post-optimism) values by identity, batch coalescing, O(addresses) visits.
 *
 * Part A drives a fake runtime against the REAL kernel facade (no engine), so
 * the addressed seam is exercised, not mocked. Part B runs the real
 * `ClientRuntime` for the optimistic markIssueRead → echo → rejection
 * identity chain, which only the true optimism ledger can produce.
 */
import type { EntityRecord } from '@podium/sync/replica'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { PodiumClientApi } from '@podium/client-core/api'
import { createClientRuntime } from '@podium/client-core/engine'
import { asClientPrincipal } from '@podium/client-core/principal'
import {
  createKernelReplica,
  createSideCache,
  memoryStorage,
  type KernelCacheRead,
} from '@podium/client-core/replica'
import type { SocketHub } from '@podium/client-core/socket-transport'
import { asIssueId, asUserId } from '@podium/model'
import { createRowSource, type RowSourceReplica, type RowSourceRuntime } from './row-source'
import type { RowSourceEvent } from './stats'

// ------------------------------------------------------------------ fakes

class FakeCache implements KernelCacheRead {
  records: EntityRecord[] = []
  readCursor() {
    return null
  }
  readEntities(): readonly EntityRecord[] {
    return this.records
  }
  read(entity: string, entityId: string): EntityRecord | undefined {
    return this.records.find((r) => r.entity === entity && r.entityId === entityId)
  }
  durability(): 'durable' {
    return 'durable'
  }
  put(entity: string, entityId: string, value: unknown): void {
    this.records = [
      ...this.records.filter((r) => !(r.entity === entity && r.entityId === entityId)),
      { entity, entityId, value, provenance: { seq: 1 } },
    ]
  }
  drop(entity: string, entityId: string): void {
    this.records = this.records.filter(
      (r) => !(r.entity === entity && r.entityId === entityId),
    )
  }
}

const sessionValue = (id: string, extra: Record<string, unknown> = {}) =>
  ({ sessionId: id, ...extra }) as unknown as { sessionId: string }
const issueValue = (id: string, extra: Record<string, unknown> = {}) =>
  ({ id, ...extra }) as unknown as { id: string }

/** Controllable runtime: the test sets the folded snapshot, then publishes. */
function fakeRuntime(initial: {
  sessions?: { sessionId: string }[]
  issues?: { id: string }[]
  issueProjections?: { id: string }[]
  repos?: { path: string; repoId?: string | null }[]
} = {}): RowSourceRuntime & { set: (next: Partial<typeof initial>) => void; publish: () => void } {
  let sessions = initial.sessions ?? []
  let issues = initial.issues ?? []
  let issueProjections = initial.issueProjections ?? []
  let repos = initial.repos ?? []
  const listeners = new Set<() => void>()
  return {
    subscribe: (listener: () => void) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    getSnapshot: () => ({ sessions, issues, issueProjections, repos }),
    set: (next) => {
      if (next.sessions !== undefined) sessions = next.sessions
      if (next.issues !== undefined) issues = next.issues
      if (next.issueProjections !== undefined) issueProjections = next.issueProjections
      if (next.repos !== undefined) repos = next.repos
    },
    publish: () => {
      for (const listener of [...listeners]) listener()
    },
  }
}

function fixture() {
  const cache = new FakeCache()
  const replica = createKernelReplica({
    cache,
    side: createSideCache({ storage: memoryStorage(), enumerateKeys: () => [] }),
  })
  return { cache, replica: replica as unknown as RowSourceReplica & { batch: (fn: () => void) => void; onKernelEvent: (e: never) => void } }
}

const upserted = (entity: string, entityId: string) =>
  ({
    type: 'upserted',
    record: { entity, entityId, value: {}, provenance: { seq: 1 } },
    readmitted: false,
  }) as never

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

// ------------------------------------------------------------ Part A: seam

describe('row-source over the real facade (fake runtime)', () => {
  it('one upsert yields one update carrying the folded row by identity', () => {
    const { cache, replica } = fixture()
    const value = sessionValue('s1', { lastActiveAt: '2026-09-20T12:00:00Z' })
    const runtime = fakeRuntime()
    const handle = createRowSource(runtime, replica)
    const events: RowSourceEvent[] = []
    const off = handle.source.subscribe((e) => events.push(e))
    try {
      cache.put('session', 's1', value)
      replica.onKernelEvent(upserted('session', 's1'))
      runtime.set({ sessions: [value] })
      runtime.publish()
      const event = handle.flush()
      expect(event?.type).toBe('update')
      expect(event?.rows).toHaveLength(1)
      expect(event?.rows[0]).toMatchObject({ kind: 'session', id: 's1' })
      expect(event?.rows[0]?.value).toBe(value)
      expect(events).toHaveLength(1)
    } finally {
      off()
      handle.dispose()
    }
  })

  it('a remove carries the address with value undefined', () => {
    const { cache, replica } = fixture()
    const value = sessionValue('s1')
    cache.put('session', 's1', value)
    const runtime = fakeRuntime({ sessions: [value] })
    const handle = createRowSource(runtime, replica)
    const events: RowSourceEvent[] = []
    const off = handle.source.subscribe((e) => events.push(e))
    try {
      cache.drop('session', 's1')
      replica.onKernelEvent({ type: 'removed', entity: 'session', entityId: 's1' } as never)
      runtime.set({ sessions: [] })
      runtime.publish()
      const event = handle.flush()
      expect(event?.rows).toEqual([{ kind: 'session', id: 's1', value: undefined }])
      expect(events).toHaveLength(1)
    } finally {
      off()
      handle.dispose()
    }
  })

  it('a replica.batch() of 50 upserts yields exactly one update with 50 rows', () => {
    const { cache, replica } = fixture()
    const runtime = fakeRuntime()
    const handle = createRowSource(runtime, replica)
    const events: RowSourceEvent[] = []
    const off = handle.source.subscribe((e) => events.push(e))
    try {
      const rows = Array.from({ length: 50 }, (_, n) => sessionValue(`s${n}`))
      replica.batch(() => {
        for (const row of rows) {
          cache.put('session', row.sessionId, row)
          replica.onKernelEvent(upserted('session', row.sessionId))
        }
      })
      runtime.set({ sessions: rows })
      runtime.publish()
      const event = handle.flush()
      expect(events).toHaveLength(1)
      expect(event?.type).toBe('update')
      expect(event?.rows).toHaveLength(50)
    } finally {
      off()
      handle.dispose()
    }
  })

  it('nested batches still yield one event', () => {
    const { cache, replica } = fixture()
    const runtime = fakeRuntime()
    const handle = createRowSource(runtime, replica)
    const events: RowSourceEvent[] = []
    const off = handle.source.subscribe((e) => events.push(e))
    try {
      const a = sessionValue('a')
      const b = sessionValue('b')
      replica.batch(() => {
        cache.put('session', 'a', a)
        replica.onKernelEvent(upserted('session', 'a'))
        replica.batch(() => {
          cache.put('session', 'b', b)
          replica.onKernelEvent(upserted('session', 'b'))
        })
      })
      runtime.set({ sessions: [a, b] })
      runtime.publish()
      handle.flush()
      expect(events).toHaveLength(1)
      expect(events[0]?.rows).toHaveLength(2)
    } finally {
      off()
      handle.dispose()
    }
  })

  it('bootstrap and rescope emit replace with all rows', () => {
    const { replica } = fixture()
    const s = sessionValue('s1')
    const i = issueValue('i1')
    const runtime = fakeRuntime({ sessions: [s], issues: [i] })
    const handle = createRowSource(runtime, replica)
    const events: RowSourceEvent[] = []
    const off = handle.source.subscribe((e) => events.push(e))
    try {
      replica.onKernelEvent({
        type: 'bootstrap-installed',
        cause: 'cold-start',
        snapshotSeq: 1,
        entityCount: 2,
        bufferedFramesApplied: 0,
      } as never)
      const boot = handle.flush()
      expect(boot?.type).toBe('replace')
      expect(boot?.rows.map((r) => `${r.kind}:${r.id}`).sort()).toEqual([
        'issue:i1',
        'session:s1',
      ])
      replica.onKernelEvent({
        type: 'bootstrap-installed',
        cause: 'rescope',
        snapshotSeq: 2,
        entityCount: 2,
        bufferedFramesApplied: 0,
      } as never)
      const rescope = handle.flush()
      expect(rescope?.type).toBe('replace')
      expect(events).toHaveLength(2)
    } finally {
      off()
      handle.dispose()
    }
  })

  it('out-of-slice kinds and locals-only publications emit nothing', () => {
    const { cache, replica } = fixture()
    const runtime = fakeRuntime()
    const handle = createRowSource(runtime, replica)
    const events: RowSourceEvent[] = []
    const off = handle.source.subscribe((e) => events.push(e))
    try {
      cache.put('conversation', 'c1', { id: 'c1' })
      replica.onKernelEvent(upserted('conversation', 'c1'))
      runtime.publish()
      expect(handle.flush()).toBeNull()
      // Locals-only: no kernel address, folded rows unchanged.
      runtime.publish()
      expect(handle.flush()).toBeNull()
      expect(events).toHaveLength(0)
    } finally {
      off()
      handle.dispose()
    }
  })

  it('a disposed source never emits again', () => {
    const { cache, replica } = fixture()
    const runtime = fakeRuntime()
    const handle = createRowSource(runtime, replica)
    const events: RowSourceEvent[] = []
    handle.source.subscribe((e) => events.push(e))
    handle.dispose()
    const value = sessionValue('s9')
    cache.put('session', 's9', value)
    replica.onKernelEvent(upserted('session', 's9'))
    runtime.set({ sessions: [value] })
    runtime.publish()
    expect(handle.flush()).toBeNull()
    expect(events).toHaveLength(0)
  })

  it('an optimistic-only fold change emits one update; restoring the array restores identity', () => {
    const { replica } = fixture()
    const before = issueValue('i1', { readAt: null })
    const runtime = fakeRuntime({ issues: [before] })
    const handle = createRowSource(runtime, replica)
    const events: RowSourceEvent[] = []
    const off = handle.source.subscribe((e) => events.push(e))
    try {
      // No kernel address: the folded array moved under optimism alone.
      const pressed = issueValue('i1', { readAt: '2026-09-20T12:00:01Z' })
      runtime.set({ issues: [pressed] })
      runtime.publish()
      const press = handle.flush()
      expect(press?.type).toBe('update')
      expect(press?.rows).toHaveLength(1)
      expect(press?.rows[0]?.value).toBe(pressed)
      // Rejection: the fold returns the prior object itself.
      runtime.set({ issues: [before] })
      runtime.publish()
      const restored = handle.flush()
      expect(restored?.rows[0]?.value).toBe(before)
      expect(events).toHaveLength(2)
    } finally {
      off()
      handle.dispose()
    }
  })

  it('snapshot() serves current rows by kind for arm bootstrap', () => {
    const { replica } = fixture()
    const s = sessionValue('s1')
    const i = issueValue('i1')
    const runtime = fakeRuntime({ sessions: [s], issues: [i] })
    const handle = createRowSource(runtime, replica)
    try {
      expect(handle.source.snapshot('session')).toEqual([
        { kind: 'session', id: 's1', value: s },
      ])
      expect(handle.source.snapshot('issue')).toEqual([{ kind: 'issue', id: 'i1', value: i }])
    } finally {
      handle.dispose()
    }
  })

  it('a heartbeat visits 1 row regardless of corpus size', () => {
    const { cache, replica } = fixture()
    for (const n of [100, 1000]) {
      const rows = Array.from({ length: n }, (_, i) => sessionValue(`s${i}`))
      const runtime = fakeRuntime({ sessions: rows })
      const handle = createRowSource(runtime, replica)
      try {
        const before = { visited: handle.stats.rowsVisited, rebuilds: handle.stats.rebuilds }
        const next = sessionValue('s0', { lastActiveAt: '2026-09-20T13:00:00Z' })
        cache.put('session', 's0', next)
        replica.onKernelEvent(upserted('session', 's0'))
        const updated = [next, ...rows.slice(1)]
        runtime.set({ sessions: updated })
        runtime.publish()
        const event = handle.flush()
        expect(event?.rows).toHaveLength(1)
        expect(handle.stats.rowsVisited - before.visited).toBe(1)
        expect(handle.stats.rebuilds - before.rebuilds).toBe(1)
      } finally {
        handle.dispose()
      }
    }
  })
})

// ------------------------------------------------- Part B: real runtime

class FakeHub {
  private handlers = new Map<string, Set<(...a: unknown[]) => void>>()
  on(kind: string, cb: (...a: unknown[]) => void): () => void {
    let set = this.handlers.get(kind)
    if (!set) {
      set = new Set()
      this.handlers.set(kind, set)
    }
    set.add(cb)
    return () => set.delete(cb)
  }
  connectionHealth() {
    return { status: 'down' as const, rttMs: null, since: 0 }
  }
  seedMetadata(): void {}
  connect(): void {}
  connectNow(): void {}
  dispose(): void {}
  setVisible(): void {}
  setViewState(): void {}
  sendSessionDraft(): void {}
  sendDraftEdit(): boolean {
    return true
  }
}

// biome-ignore lint/suspicious/noExplicitAny: test API stub — shaped per-test like runtime.test.ts
function makeApi(): any {
  let rejectNext = false
  const api = {
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
        mutate: async () => ({ repositories: [], diagnostics: [], machines: [] }),
      },
    },
    pins: { list: { query: async () => ({ panels: [], worktrees: [], repos: [] }) } },
    tabs: { listOrders: { query: async () => ({}) } },
    settings: {
      get: {
        query: async () => ({ sidebar: { repoSort: 'lastUsed', repoOrder: [] } }),
      },
    },
    superagent: { listThreads: { query: async () => [] } },
    sessions: { markRead: { mutate: async () => ({}) } },
    issues: {
      markRead: {
        mutate: async () => {
          if (rejectNext) {
            rejectNext = false
            throw Object.assign(new Error('fixture rejection'), {
              data: { code: 'BAD_REQUEST', httpStatus: 400 },
            })
          }
          return {}
        },
      },
    },
  }
  return {
    api,
    rejectNextMarkRead() {
      rejectNext = true
    },
  }
}

function makeRouterWindow() {
  const listeners = new Set<() => void>()
  const win = {
    location: { pathname: '/', search: '' },
    history: { pushState: () => {}, replaceState: () => {} },
    addEventListener: (_t: string, cb: () => void) => listeners.add(cb),
    removeEventListener: (_t: string, cb: () => void) => listeners.delete(cb),
  }
  return win
}

const settle = (ms = 25): Promise<void> => new Promise((r) => setTimeout(r, ms))

describe('row-source over the real runtime (optimism identity)', () => {
  it('markIssueRead paints an update, its echo another, a rejection restores the prior identity', async () => {
    const cache = new FakeCache()
    const replica = createKernelReplica({
      cache,
      side: createSideCache({ storage: memoryStorage(), enumerateKeys: () => [] }),
    })
    const { api, rejectNextMarkRead } = makeApi()
    const engine = createClientRuntime({
      principal: asClientPrincipal(asUserId('operator')),
      config: { httpOrigin: 'http://x', wsClientUrl: 'ws://x' },
      api: api as PodiumClientApi,
      onFatalError: (message) => {
        throw new Error(message)
      },
      createReplicaFn: () => replica,
      routerWindow: makeRouterWindow() as never,
      createHub: () => new FakeHub() as unknown as SocketHub,
    })
    engine.start()
    await settle(40)
    try {
      const projection = {
        id: 'iss_1',
        seq: 1,
        title: 'Issue',
        description: { value: '' },
        stage: 'in_progress',
        createdAt: '2026-07-01T00:00:00.000Z',
        updatedAt: '2026-07-01T00:00:00.000Z',
      }
      const wire = { id: 'iss_1', readAt: null, updatedAt: projection.updatedAt }
      cache.put('issueProjection', 'iss_1', projection)
      replica.onKernelEvent({
        type: 'upserted',
        record: { entity: 'issueProjection', entityId: 'iss_1', value: projection, provenance: { seq: 1 } },
        readmitted: false,
      } as never)
      cache.put('issue', 'iss_1', wire)
      replica.onKernelEvent({
        type: 'upserted',
        record: { entity: 'issue', entityId: 'iss_1', value: wire, provenance: { seq: 1 } },
        readmitted: false,
      } as never)
      await settle(40)

      const handle = createRowSource(engine, replica)
      const events: RowSourceEvent[] = []
      const off = handle.source.subscribe((e) => events.push(e))
      try {
        const before = engine.getSnapshot().issues.find((i) => i.id === 'iss_1')
        expect(before?.readAt).toBeNull()

        // Press: optimistic paint, no kernel address yet.
        const pressPromise = engine.getSnapshot().markIssueRead(asIssueId('iss_1'))
        const press = handle.flush()
        expect(press?.type).toBe('update')
        expect(press?.rows).toHaveLength(1)
        expect(press?.rows[0]).toMatchObject({ kind: 'issue', id: 'iss_1' })
        const pressedValue = press?.rows[0]?.value as { readAt: unknown }
        expect(pressedValue.readAt).not.toBeNull()
        expect(press?.rows[0]?.value).not.toBe(before)
        await pressPromise
        await settle(40)
        handle.flush()

        // Echo: the server row lands and covers the overlay. The microtask
        // flush delivers it during the settle; assert off the event log.
        const echoCount = events.length
        const echoWire = { ...wire, readAt: '2026-07-09T00:00:00.000Z' }
        cache.put('issue', 'iss_1', echoWire)
        replica.onKernelEvent({
          type: 'upserted',
          record: { entity: 'issue', entityId: 'iss_1', value: echoWire, provenance: { seq: 2 } },
          readmitted: false,
        } as never)
        await settle(40)
        expect(events.length).toBe(echoCount + 1)
        const echo = events[events.length - 1]
        expect(echo?.type).toBe('update')
        expect(echo?.rows).toHaveLength(1)
        expect((echo?.rows[0]?.value as { readAt: unknown }).readAt).toBe(
          '2026-07-09T00:00:00.000Z',
        )
        expect(echo?.rows[0]?.value).not.toBe(press?.rows[0]?.value)
        const covered = engine.getSnapshot().issues.find((i) => i.id === 'iss_1')

        // Second press, then a definitive rejection restores the echo identity.
        // (Enqueue always succeeds — the refusal surfaces at drain as a dead
        // letter, exactly as in apps/web kernel-scenarios' optimistic-rejection
        // case: the pending promise resolves, the paint rolls back after.)
        rejectNextMarkRead()
        const restoreCount = events.length
        const press2Promise = engine.getSnapshot().markIssueRead(asIssueId('iss_1'))
        const press2 = handle.flush()
        expect(press2?.rows).toHaveLength(1)
        expect(press2?.rows[0]?.value).not.toBe(covered)
        await press2Promise
        await settle(40)
        // The press painted synchronously (flushed above); the drop publishes
        // once more with the rollback. The durable commit between them is a
        // no-op by design (POD-1053: the queued entry paints the press's own
        // stamped overlay, so no new identity appears) — one press event, one
        // rollback event, and the rollback restores the echo object itself.
        expect(events.length).toBe(restoreCount + 2)
        const restored = events[events.length - 1]
        expect(restored?.type).toBe('update')
        expect(restored?.rows).toHaveLength(1)
        expect(restored?.rows[0]?.value).toBe(covered)
        // `issueMarkRead` refusals discard automatically
        // (`deadLetterHandlingFor`, wiring.ts) rather than parking: no dead
        // letter, but the paint still rolls back, which is what this asserts.
        expect(engine.outbox.deadLetters()).toHaveLength(0)
      } finally {
        off()
        handle.dispose()
      }
    } finally {
      engine.destroy()
    }
  }, 30_000)
})
