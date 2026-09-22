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

import type { PodiumClientApi } from '@podium/client-core/api'
import { createClientRuntime, type PendingOverlay } from '@podium/client-core/engine'
import { asClientPrincipal } from '@podium/client-core/principal'
import {
  createKernelReplica,
  createSideCache,
  type KernelCacheRead,
  memoryStorage,
} from '@podium/client-core/replica'
import type { SocketHub } from '@podium/client-core/socket-transport'
import { asIssueId, asUserId } from '@podium/model'
import type { EntityRecord } from '@podium/sync/replica'
import { afterEach, describe, expect, it, vi } from 'vitest'
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
    this.records = this.records.filter((r) => !(r.entity === entity && r.entityId === entityId))
  }
}

const sessionValue = (id: string, extra: Record<string, unknown> = {}) =>
  ({ sessionId: id, ...extra }) as unknown as { sessionId: string }
const issueValue = (id: string, extra: Record<string, unknown> = {}) =>
  ({ id, ...extra }) as unknown as { id: string }

type Entity = 'sessions' | 'issues' | 'issueProjections'

/** Controllable runtime: the test sets the ledger's pending overlays by row,
 *  then publishes. Entity rows are NOT here — the row source reads them from
 *  the replica by id. */
function fakeRuntime(
  initial: { repos?: { path: string; repoId?: string | null }[] } = {},
): RowSourceRuntime & {
  setPending: (entity: Entity, id: string, overlays: PendingOverlay[] | null) => void
  publish: () => void
} {
  const repos = initial.repos ?? []
  const pending: Record<Entity, Map<string, PendingOverlay[]>> = {
    sessions: new Map(),
    issues: new Map(),
    issueProjections: new Map(),
  }
  const listeners = new Set<() => void>()
  return {
    subscribe: (listener: () => void) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    getSnapshot: () => ({ repos }),
    pendingOverlaysByRow: (entity) => pending[entity],
    setPending: (entity, id, overlays) => {
      if (overlays === null) pending[entity].delete(id)
      else pending[entity].set(id, overlays)
    },
    publish: () => {
      for (const listener of [...listeners]) listener()
    },
  }
}

const patch = (entity: Entity, id: string, fields: Record<string, unknown>): PendingOverlay => ({
  op: 'patch',
  key: `m-${entity}-${id}-${Object.keys(fields).join(',')}`,
  entity,
  id,
  patch: fields,
  coveredBy: () => false,
})

const insert = (entity: Entity, id: string, row: object): PendingOverlay =>
  ({ op: 'insert', key: `spawn:${id}`, entity, id, insert: row }) as PendingOverlay

function fixture() {
  const cache = new FakeCache()
  const replica = createKernelReplica({
    cache,
    side: createSideCache({ storage: memoryStorage(), enumerateKeys: () => [] }),
  })
  return {
    cache,
    replica: replica as unknown as RowSourceReplica & {
      batch: (fn: () => void) => void
      onKernelEvent: (e: never) => void
    },
  }
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
  it('refuses a replica without row() or the addressed seam', () => {
    const runtime = fakeRuntime()
    const bare = { rows: () => [] } as unknown as RowSourceReplica
    expect(() => createRowSource(runtime, bare)).toThrow(/replica\.row\(\)/)
  })

  it('one upsert yields one update carrying the replica row by identity', () => {
    const { cache, replica } = fixture()
    const value = sessionValue('s1', { lastActiveAt: '2026-09-20T12:00:00Z' })
    const runtime = fakeRuntime()
    const handle = createRowSource(runtime, replica)
    const events: RowSourceEvent[] = []
    const off = handle.source.subscribe((e) => events.push(e))
    try {
      cache.put('session', 's1', value)
      replica.onKernelEvent(upserted('session', 's1'))
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
    const runtime = fakeRuntime()
    const handle = createRowSource(runtime, replica)
    const events: RowSourceEvent[] = []
    const off = handle.source.subscribe((e) => events.push(e))
    try {
      cache.drop('session', 's1')
      replica.onKernelEvent({ type: 'removed', entity: 'session', entityId: 's1' } as never)
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
      runtime.publish()
      const event = handle.flush()
      expect(events).toHaveLength(1)
      expect(event?.type).toBe('update')
      expect(event?.rows).toHaveLength(50)
      expect(handle.stats.rowsVisited).toBe(50)
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
      runtime.publish()
      handle.flush()
      expect(events).toHaveLength(1)
      expect(events[0]?.rows).toHaveLength(2)
    } finally {
      off()
      handle.dispose()
    }
  })

  it('wire and projection of one issue in one batch are one row', () => {
    const { cache, replica } = fixture()
    const runtime = fakeRuntime()
    const handle = createRowSource(runtime, replica)
    try {
      const wire = issueValue('i1', { title: 'wire' })
      replica.batch(() => {
        cache.put('issue', 'i1', wire)
        replica.onKernelEvent(upserted('issue', 'i1'))
        cache.put('issueProjection', 'i1', issueValue('i1', { title: 'projection' }))
        replica.onKernelEvent(upserted('issueProjection', 'i1'))
      })
      const event = handle.flush()
      expect(event?.rows).toEqual([{ kind: 'issue', id: 'i1', value: wire }])
      expect(handle.stats.rowsVisited).toBe(1)
    } finally {
      handle.dispose()
    }
  })

  it('bootstrap and rescope emit replace with all rows, one enumeration each', () => {
    const { cache, replica } = fixture()
    cache.put('session', 's1', sessionValue('s1'))
    cache.put('issue', 'i1', issueValue('i1'))
    const runtime = fakeRuntime()
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
      expect(boot?.rows.map((r) => `${r.kind}:${r.id}`).sort()).toEqual(['issue:i1', 'session:s1'])
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
      expect(handle.stats.enumerations).toBe(2)
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
      // Locals-only: no kernel address, no pending overlay.
      runtime.publish()
      expect(handle.flush()).toBeNull()
      expect(events).toHaveLength(0)
      expect(handle.stats.rowsVisited).toBe(0)
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
    runtime.publish()
    expect(handle.flush()).toBeNull()
    expect(events).toHaveLength(0)
  })

  it('an optimistic-only overlay emits one update; dropping it restores the replica object', () => {
    const { cache, replica } = fixture()
    const before = issueValue('i1', { readAt: null })
    cache.put('issue', 'i1', before)
    const runtime = fakeRuntime()
    const handle = createRowSource(runtime, replica)
    const events: RowSourceEvent[] = []
    const off = handle.source.subscribe((e) => events.push(e))
    try {
      // Press: no kernel address, the ledger alone names the row.
      runtime.setPending('issues', 'i1', [
        patch('issues', 'i1', { readAt: '2026-09-20T12:00:01Z' }),
      ])
      runtime.publish()
      const press = handle.flush()
      expect(press?.type).toBe('update')
      expect(press?.rows).toHaveLength(1)
      const pressed = press?.rows[0]?.value as { readAt: unknown }
      expect(pressed.readAt).toBe('2026-09-20T12:00:01Z')
      expect(press?.rows[0]?.value).not.toBe(before)
      // The same paint recomposed (a durable commit) keeps identity: no event.
      runtime.setPending('issues', 'i1', [
        patch('issues', 'i1', { readAt: '2026-09-20T12:00:01Z' }),
      ])
      runtime.publish()
      expect(handle.flush()).toBeNull()
      // Rejection: the overlay is gone; the row is the replica's object again.
      runtime.setPending('issues', 'i1', null)
      runtime.publish()
      const restored = handle.flush()
      expect(restored?.rows[0]?.value).toBe(before)
      expect(events).toHaveLength(2)
      // Visits: the pending row on each of three flushes, never the corpus.
      expect(handle.stats.rowsVisited).toBe(3)
      expect(handle.stats.enumerations).toBe(0)
    } finally {
      off()
      handle.dispose()
    }
  })

  it('a no-op patch paints nothing; an insert shows until its server row lands', () => {
    const { cache, replica } = fixture()
    const existing = sessionValue('s1', { title: 'same' })
    cache.put('session', 's1', existing)
    const runtime = fakeRuntime()
    const handle = createRowSource(runtime, replica)
    try {
      runtime.setPending('sessions', 's1', [patch('sessions', 's1', { title: 'same' })])
      runtime.publish()
      expect(handle.flush()).toBeNull()

      const placeholder = sessionValue('s2', { title: 'Starting' })
      runtime.setPending('sessions', 's2', [insert('sessions', 's2', placeholder)])
      runtime.publish()
      expect(handle.flush()?.rows).toEqual([{ kind: 'session', id: 's2', value: placeholder }])

      // The server row lands in the same drain the ledger retires the insert.
      const real = sessionValue('s2', { title: 'Real' })
      cache.put('session', 's2', real)
      runtime.setPending('sessions', 's2', null)
      replica.onKernelEvent(upserted('session', 's2'))
      runtime.publish()
      expect(handle.flush()?.rows).toEqual([{ kind: 'session', id: 's2', value: real }])
    } finally {
      handle.dispose()
    }
  })

  it('snapshot() serves current rows by kind for arm bootstrap', () => {
    const { cache, replica } = fixture()
    const s = sessionValue('s1')
    const i = issueValue('i1')
    cache.put('session', 's1', s)
    cache.put('issue', 'i1', i)
    const runtime = fakeRuntime()
    const handle = createRowSource(runtime, replica)
    try {
      expect(handle.source.snapshot('session')).toEqual([{ kind: 'session', id: 's1', value: s }])
      expect(handle.source.snapshot('issue')).toEqual([{ kind: 'issue', id: 'i1', value: i }])
    } finally {
      handle.dispose()
    }
  })

  it('a heartbeat visits 1 row and enumerates nothing, regardless of corpus size', () => {
    for (const n of [100, 1000]) {
      const { cache, replica } = fixture()
      for (let i = 0; i < n; i += 1) cache.put('session', `s${i}`, sessionValue(`s${i}`))
      const runtime = fakeRuntime()
      const handle = createRowSource(runtime, replica)
      try {
        const next = sessionValue('s0', { lastActiveAt: '2026-09-20T13:00:00Z' })
        cache.put('session', 's0', next)
        replica.onKernelEvent(upserted('session', 's0'))
        runtime.publish()
        const event = handle.flush()
        expect(event?.rows).toHaveLength(1)
        expect(handle.stats.rowsVisited).toBe(1)
        expect(handle.stats.enumerations).toBe(0)
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
        record: {
          entity: 'issueProjection',
          entityId: 'iss_1',
          value: projection,
          provenance: { seq: 1 },
        },
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

// ------------------------------------ Part C: visited-per-publication fence

/**
 * POD-4553 fence. The real runtime and kernel facade at the live-shaped 1x and
 * 4x corpus sizes; the row source reads through counting wrappers, so any
 * whole-list read is counted wherever it hides:
 *
 * - `elementReads` — element reads of ANY entity array the source can reach
 *   (the runtime snapshot's sessions/issues/projections/repos, every
 *   `replica.rows()` result), through a Proxy. A per-kind Map rebuild reads
 *   every element; the per-row feed reads none.
 * - `rowReads` — `replica.row()` calls: by-id reads, O(rows named).
 *
 * Per flush, rows visited must equal the rows the kernel batch names plus the
 * rows with pending overlays — at both scales, with identical counts. The
 * legacy row source (round two's, per-kind Maps rebuilt on array identity)
 * fails `elementReads == 0` on the first heartbeat and the scale equality;
 * the emitted rows per step are the control dimension both arms share.
 */

/** O(1) keyed kernel cache, so seeding 4x stays linear. */
class KeyedCache implements KernelCacheRead {
  private readonly byKey = new Map<string, EntityRecord>()
  private materialised: EntityRecord[] | null = null
  readCursor() {
    return null
  }
  readEntities(): readonly EntityRecord[] {
    this.materialised ??= [...this.byKey.values()]
    return this.materialised
  }
  read(entity: string, entityId: string): EntityRecord | undefined {
    return this.byKey.get(`${entity}:${entityId}`)
  }
  durability(): 'durable' {
    return 'durable'
  }
  put(entity: string, entityId: string, value: unknown): void {
    this.byKey.set(`${entity}:${entityId}`, { entity, entityId, value, provenance: { seq: 1 } })
    this.materialised = null
  }
}

/** Live-shaped sizes (round two's GROWTH_CORPORA x1; x4 is four times it). */
const FENCE_SCALES = {
  x1: { issues: 4867, sessions: 4304 },
  x4: { issues: 4867 * 4, sessions: 4304 * 4 },
} as const

const T0 = Date.parse('2026-09-18T12:00:00Z')
const at = (ms: number): string => new Date(T0 + ms).toISOString()

function seedFence(cache: KeyedCache, spec: { issues: number; sessions: number }): void {
  for (let i = 0; i < spec.issues; i += 1) {
    const id = `i${i}`
    const common = {
      id,
      seq: i + 1,
      title: `Issue ${i}`,
      stage: 'in_progress',
      createdAt: at(i * 1000),
      updatedAt: at(i * 1000 + 500),
    }
    cache.put('issue', id, { ...common, readAt: i === 0 ? null : at(i * 1000), unread: i === 0 })
    cache.put('issueProjection', id, { ...common, description: { value: '' } })
  }
  cache.put('issueDep', 'dep0', { id: 'dep0', fromId: 'i1', toId: 'i0', type: 'discovered-from' })
  for (let s = 0; s < spec.sessions; s += 1) {
    cache.put('session', `s${s}`, {
      sessionId: `s${s}`,
      issueId: `i${s % spec.issues}`,
      agentKind: 'codex',
      cwd: '/repo',
      title: `Session ${s}`,
      status: 'live',
      createdAt: at(s * 1000),
      lastActiveAt: at(s * 1000),
      readAt: at(s * 1000),
      unread: false,
    })
  }
}

interface FenceCounters {
  elementReads: number
  rowReads: number
}

function countingWrappers(
  engine: ReturnType<typeof createClientRuntime>,
  replica: ReturnType<typeof createKernelReplica>,
): { runtime: RowSourceRuntime; replica: RowSourceReplica; counters: FenceCounters } {
  const counters: FenceCounters = { elementReads: 0, rowReads: 0 }
  const arrays = new WeakMap<object, unknown>()
  const counting = <T extends object>(arr: T): T => {
    const cached = arrays.get(arr)
    if (cached !== undefined) return cached as T
    const proxy = new Proxy(arr, {
      get(target, prop, receiver) {
        if (typeof prop === 'string' && /^\d+$/.test(prop)) counters.elementReads += 1
        return Reflect.get(target, prop, receiver)
      },
    })
    arrays.set(arr, proxy)
    return proxy
  }
  const snapshots = new WeakMap<object, unknown>()
  const ENTITY_ARRAYS = new Set(['sessions', 'issues', 'issueProjections', 'repos'])
  const runtime = {
    subscribe: engine.subscribe,
    pendingOverlaysByRow: engine.pendingOverlaysByRow,
    getSnapshot: () => {
      const snap = engine.getSnapshot()
      const cached = snapshots.get(snap)
      if (cached !== undefined) return cached
      const proxy = new Proxy(snap, {
        get(target, prop, receiver) {
          const value = Reflect.get(target, prop, receiver)
          return typeof prop === 'string' && ENTITY_ARRAYS.has(prop) && Array.isArray(value)
            ? counting(value)
            : value
        },
      })
      snapshots.set(snap, proxy)
      return proxy
    },
  } as unknown as RowSourceRuntime
  const { subscribeAddressedBatch, row } = replica
  if (subscribeAddressedBatch === undefined || row === undefined)
    throw new Error('fence: kernel facade seams')
  const wrappedReplica: RowSourceReplica = {
    subscribeAddressedBatch: (cb) => subscribeAddressedBatch.call(replica, cb),
    rows: (kind) => counting(replica.rows(kind) as object[]) as never,
    row: (kind, id) => {
      counters.rowReads += 1
      return row.call(replica, kind, id) as never
    },
  }
  return { runtime, replica: wrappedReplica, counters }
}

interface StepCost {
  flushes: number
  visited: number
  elementReads: number
  enumerations: number
  rowsEmitted: number
}

async function waitFor(check: () => boolean, label: string): Promise<void> {
  const deadline = Date.now() + 20_000
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`fence: timed out waiting for ${label}`)
    await settle(20)
  }
}

async function runFence(spec: {
  issues: number
  sessions: number
}): Promise<Record<string, StepCost>> {
  const cache = new KeyedCache()
  seedFence(cache, spec)
  const replica = createKernelReplica({
    cache,
    side: createSideCache({ storage: memoryStorage(), enumerateKeys: () => [] }),
  })
  const { api } = makeApi()
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
  await settle(100)
  // The scale is real: the replica and the runtime hold the whole corpus.
  expect(replica.rows('issues')).toHaveLength(spec.issues)
  expect(replica.rows('sessions')).toHaveLength(spec.sessions)
  expect(engine.getSnapshot().issues).toHaveLength(spec.issues)
  const wrapped = countingWrappers(engine, replica)
  const handle = createRowSource(wrapped.runtime, wrapped.replica)
  let rowsEmitted = 0
  const off = handle.source.subscribe((e) => {
    rowsEmitted += e.rows.length
  })
  const table: Record<string, StepCost> = {}
  const step = async (name: string, act: () => void | Promise<void>): Promise<void> => {
    await settle(20)
    handle.flush()
    handle.stats.reset()
    wrapped.counters.elementReads = 0
    rowsEmitted = 0
    await act()
    handle.flush()
    table[name] = {
      flushes: handle.stats.flushes,
      visited: handle.stats.rowsVisited,
      elementReads: wrapped.counters.elementReads,
      enumerations: handle.stats.enumerations,
      rowsEmitted,
    }
  }
  const upsert = (entity: string, id: string, value: object): void => {
    cache.put(entity, id, value)
    replica.onKernelEvent({
      type: 'upserted',
      record: { entity, entityId: id, value, provenance: { seq: 2 } },
      readmitted: false,
    } as never)
  }
  const session = (n: number) => replica.row('sessions', `s${n}`) as object
  const issue = (n: number) => replica.row('issues', `i${n}`) as object
  try {
    await step('heartbeat', () => upsert('session', 's0', { ...session(0), lastActiveAt: at(9e9) }))
    await step('rename (wire+projection)', () =>
      replica.batch(() => {
        upsert('issue', 'i3', { ...issue(3), title: 'Renamed' })
        upsert('issueProjection', 'i3', {
          ...(replica.row('issueProjections', 'i3') as object),
          title: 'Renamed',
        })
      }),
    )
    await step('dep edge + owner wire', () =>
      replica.batch(() => {
        upsert('issueDep', 'dep0', {
          id: 'dep0',
          fromId: 'i1',
          toId: 'i2',
          type: 'discovered-from',
        })
        upsert('issue', 'i1', { ...issue(1), deps: [{ id: 'i2', type: 'discovered-from' }] })
      }),
    )
    await step('burst of 50', () =>
      replica.batch(() => {
        for (let n = 1; n <= 50; n += 1)
          upsert('session', `s${n}`, { ...session(n), lastActiveAt: at(9e9 + n) })
      }),
    )
    await step('optimistic press', async () => {
      await engine.getSnapshot().markIssueRead(asIssueId('i0'))
      await waitFor(
        () =>
          engine.outbox.pending().length === 0 && engine.pendingOverlaysByRow('issues').has('i0'),
        'press to drain into awaiting truth',
      )
    })
    await step('echo retires the overlay', async () => {
      upsert('issue', 'i0', { ...issue(0), readAt: '2026-07-09T00:00:00.000Z', unread: false })
      await waitFor(() => !engine.pendingOverlaysByRow('issues').has('i0'), 'echo to retire')
    })
    await step('heartbeat after settle', () =>
      upsert('session', 's0', { ...session(0), lastActiveAt: at(9e9 + 99) }),
    )
  } finally {
    off()
    handle.dispose()
    engine.destroy()
  }
  return table
}

describe('visited-per-publication fence at 1x and 4x (real runtime)', () => {
  it('visits exactly the addressed rows plus the pending-overlay rows, equal at both scales', async () => {
    const tables: Record<string, Record<string, StepCost>> = {}
    for (const [scale, spec] of Object.entries(FENCE_SCALES)) tables[scale] = await runFence(spec)
    console.info(`ROW-SOURCE FENCE ${JSON.stringify(tables)}`)
    // Rows each step names: kernel addresses (deduped to slice rows), and the
    // one pending row on every flush of the optimistic steps.
    const addressed: Record<string, number> = {
      heartbeat: 1,
      'rename (wire+projection)': 1,
      'dep edge + owner wire': 1,
      'burst of 50': 50,
      'heartbeat after settle': 1,
    }
    for (const [scale, table] of Object.entries(tables)) {
      for (const [name, cost] of Object.entries(table)) {
        const where = `${scale} ${name}`
        expect(cost.elementReads, `${where}: no collection element read`).toBe(0)
        expect(cost.enumerations, `${where}: no whole-slice pass`).toBe(0)
        const expected = addressed[name]
        if (expected !== undefined) {
          expect(cost.visited, `${where}: visited == addressed rows`).toBe(expected)
          expect(cost.rowsEmitted, `${where}: emitted == addressed rows`).toBe(expected)
        } else {
          // Optimistic steps: one pending row, visited once per flush.
          expect(cost.flushes, `${where}: flushed`).toBeGreaterThan(0)
          expect(cost.visited, `${where}: visited == flushes x 1 pending row`).toBe(cost.flushes)
          expect(cost.rowsEmitted, `${where}: one paint`).toBe(1)
        }
      }
    }
    const perFlush = (table: Record<string, StepCost>) =>
      Object.fromEntries(
        Object.entries(table).map(([name, c]) => [
          name,
          c.flushes === 0 ? 0 : c.visited / c.flushes,
        ]),
      )
    const { x1, x4 } = tables
    expect(x1 && x4, 'both scales ran').toBeTruthy()
    expect(perFlush(x4 ?? {})).toEqual(perFlush(x1 ?? {}))
  }, 240_000)
})
