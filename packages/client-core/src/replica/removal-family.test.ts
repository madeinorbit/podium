/**
 * THE REMOVAL FAMILY, ON THE PATHS A USER ACTUALLY SEES (POD-378).
 *
 * ---------------------------------------------------------------------------
 * WHY THESE FOUR CASES SHARE ONE FILE
 * ---------------------------------------------------------------------------
 *
 * ADR 2 D5 warns that soft-delete and tombstone "look identical from a distance
 * and are not". Under the per-principal feed (`docs/multi-user-readiness.md`
 * §3.1) there is a THIRD member of that family — a row that leaves your view
 * because a share was revoked, without being deleted — and a FOURTH shape that is
 * not a removal at all and is repeatedly mistaken for one: a field going from
 * present to absent inside a surviving row.
 *
 * Split across four files, the distinction rots: each case looks self-evidently
 * correct beside its own fixture, and the thing that actually breaks is one of
 * them silently acquiring another's behaviour. Held together, a change that
 * collapses any two of them fails HERE, in a file whose whole subject is that
 * they are different.
 *
 *   delete            → gone, and gone for everyone. Render as deleted.
 *   revoke a share    → gone from MY view. Never a deletion, never a tombstone.
 *   watermark skip    → nothing at all. The cursor still advances and no heal starts.
 *   present → absent  → the row SURVIVES and the field is nulled, not retained.
 *
 * ---------------------------------------------------------------------------
 * WHAT IS REAL HERE, AND WHERE THE LINE IS
 * ---------------------------------------------------------------------------
 *
 * POD-1077 owns the KERNEL-level proof of this family — `packages/sync`'s
 * conformance gates `scoped/revoke-mid-session` and friends. This file owns the
 * CLIENT-instantiation proof, which is a different claim: that the distinction
 * survives the wire mapping, the client's own feed consumer, and the durable
 * store each platform actually ships, rather than only the state machine in the
 * middle.
 *
 *   THE AUTHORITY   `ConformanceAuthority` with the SHIPPED visibility policy. A
 *                   watermark here is the RESIDUE of evaluating a range against a
 *                   principal, never a literal a case asked for — so case 3
 *                   cannot pass by being handed the answer.
 *   THE WIRE        Every frame is expressed as a v2 WIRE message and travels
 *                   `frames.ts` → `FeedSink`. Handing kernel frames straight to
 *                   the Replica would skip the client half entirely, which is the
 *                   half this issue is about.
 *   THE STORAGE     BOTH shipped adapters, on real engines: IndexedDB
 *                   (`fake-indexeddb`, a spec implementation with real
 *                   transaction semantics) for web, and real SQLite on a real
 *                   FILE for mobile. Every case that claims a row is gone — or
 *                   that a field was nulled — re-reads it through a SECOND store
 *                   opened over the same durable bytes, because a claim about
 *                   what survives, made through the object that held it in
 *                   memory, is the fixture certifying itself.
 *
 * WHAT THIS DOES NOT EVIDENCE. Two principals here are two `FeedPrincipal`
 * values. The shipped authenticator is device-grade — one shared password, two
 * connections indistinguishable AS PERSONS — so these cases prove the MECHANISM
 * carries the distinction end to end on both platforms. They are not the
 * second-account check; `docs/multi-user-readiness.md` §3.2 is why there cannot
 * be one yet.
 *
 * WHY THE MOBILE LANE IS NOT "THE SAME THING TWICE". The two adapters fail
 * differently on exactly this family: IndexedDB's `delete` and a row simply not
 * being written back are indistinguishable after the fact, while SQLite's are
 * distinct statements. `packages/sync/src/conformance/instantiation.ts` records
 * the measured instance — an adapter handed `remove` for an eviction survived
 * every in-memory assertion. Running both engines is what makes the
 * remove/evict distinction a claim about DISK.
 */

import { createRequire } from 'node:module'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { IDBFactory } from 'fake-indexeddb'
import { ConformanceAuthority, type ConformancePrincipal } from '@podium/sync'
import { IndexedDbSyncStore, type IdbFactoryLike } from '@podium/sync/adapters/indexeddb'
import {
  SqliteSyncStore,
  type SqlDatabaseLike,
  type SqlValue,
} from '@podium/sync/adapters/mobile-sqlite'
import {
  Replica,
  type BootstrapChunk,
  type DeltaFrame,
  type ReplicaEvent,
} from '@podium/sync/replica'
import type { FeedServerFrame } from '@podium/terminal-client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { PushedBootstrapSource } from './feed/bootstrap-source'
import { FeedAuthorityClient } from './feed/authority-client'
import { FeedSink } from './feed/sink'

const ALICE: ConformancePrincipal = { kind: 'user', userId: 'user:alice' }
const BOB: ConformancePrincipal = { kind: 'user', userId: 'user:bob' }

/**
 * A real SQLite, or a refusal.
 *
 * `bun:sqlite`, because the unit lane runs on the Bun runtime (SP-3f93) — the
 * same lazy `createRequire` the repo already uses for it, since the repo carries
 * no bun types. There is deliberately no Map-backed fallback: an imitation engine
 * would make every mobile case below pass while proving nothing about the durable
 * bytes, which is precisely the shape this file exists to rule out.
 */
interface BunStatement {
  run(...params: unknown[]): unknown
  get(...params: unknown[]): unknown
  all(...params: unknown[]): unknown[]
}
const BunDatabase = (
  createRequire(import.meta.url)('bun:sqlite') as {
    Database: new (path: string) => SqlDatabaseLike
  }
).Database

/** Adapt bun:sqlite to the adapter's structural SQL surface. */
function openSqlite(file: string): SqlDatabaseLike {
  const db = new BunDatabase(file) as unknown as {
    prepare(sql: string): BunStatement
    exec(sql: string): void
    close(): void
  }
  return {
    prepare: (sql) => {
      const statement = db.prepare(sql)
      return {
        run: (...params: SqlValue[]) => statement.run(...params),
        get: (...params: SqlValue[]) => statement.get(...params),
        all: (...params: SqlValue[]) => statement.all(...params),
      }
    },
    exec: (sql) => {
      db.exec(sql)
    },
    close: () => {
      db.close()
    },
  } as SqlDatabaseLike
}

/**
 * Kernel `DeltaFrame` → the v2 WIRE message. The inverse of `frames.ts`, present
 * so every case below travels the client code under test rather than around it.
 */
function asWireDelta(frame: DeltaFrame): FeedServerFrame {
  return {
    type: 'feedDelta',
    feedId: frame.feedId,
    epoch: frame.epoch,
    fromSeq: frame.fromSeq,
    seq: frame.seq,
    minAvailableSeq: frame.minAvailableSeq,
    changes: frame.changes.map((change) =>
      change.op === 'upsert'
        ? {
            seq: change.seq,
            entity: change.entity,
            entityId: change.entityId,
            op: 'upsert',
            value: change.payload,
          }
        : { seq: change.seq, entity: change.entity, entityId: change.entityId, op: change.op },
    ),
  } as FeedServerFrame
}

function asWireBootstrap(chunk: BootstrapChunk): FeedServerFrame {
  return {
    type: 'feedBootstrap',
    feedId: chunk.feedId,
    epoch: chunk.epoch,
    fromSeq: 0,
    seq: chunk.snapshotSeq,
    minAvailableSeq: 0,
    changes: chunk.changes.map((change) => ({
      seq: change.seq,
      entity: change.entity,
      entityId: change.entityId,
      op: 'upsert',
      value: change.payload,
    })),
    last: chunk.last,
  } as FeedServerFrame
}

/**
 * The two shipped client storage backends, behind one seam.
 *
 * `reopen` is the load-bearing member: it opens a SECOND store over the same
 * durable bytes with no shared in-memory state, which is how an assertion about
 * what a user sees after a reload stops being an assertion about a live object's
 * cache.
 */
/** One durable row as both adapters report it. */
interface DurableRow {
  readonly entity: string
  readonly entityId: string
  readonly value: unknown
}

interface Backend {
  readonly name: 'web (IndexedDB)' | 'mobile (SQLite)'
  open(id: string): Promise<{ cache: unknown }>
  /**
   * A fresh store over the same durable bytes — the reload.
   *
   * Waits on the LIVE store's own durability fence first. `Replica.settled()`
   * covers the kernel's work and stops there; on IndexedDB the commit is still in
   * the engine's request queue at that moment, so a reopen without this fence
   * reads the PRE state and every case below would report the previous frame's
   * answer. Found by three cases failing on web while the same cases passed on
   * SQLite, whose commit is synchronous — which is exactly the platform
   * difference this file runs both engines to catch.
   */
  reopen(id: string): Promise<readonly DurableRow[]>
  cleanup(): void
}

function webBackend(): Backend {
  const factory = new IDBFactory() as unknown as IdbFactoryLike
  const degradations: unknown[] = []
  const live = new Map<string, IndexedDbSyncStore>()
  const open = async (id: string): Promise<IndexedDbSyncStore> =>
    IndexedDbSyncStore.open({
      factory,
      databaseName: `replica-${id}`,
      // COLLECTED AND ASSERTED. A store that had quietly fallen back to memory
      // would make every durability claim below vacuous.
      onDegraded: (degradation) => degradations.push(degradation),
    })
  return {
    name: 'web (IndexedDB)',
    open: async (id) => {
      const store = await open(id)
      live.set(id, store)
      return { cache: store.viewFor('default').cache }
    },
    reopen: async (id) => {
      await live.get(id)?.settled()
      const store = await open(id)
      const rows = store.viewFor('default').cache.readEntities()
      expect(degradations).toEqual([])
      return rows
    },
    cleanup: () => {
      live.clear()
    },
  }
}

function mobileBackend(): Backend {
  const directory = mkdtempSync(join(tmpdir(), 'podium-removal-family-'))
  const degradations: unknown[] = []
  const open = async (id: string): Promise<SqliteSyncStore> => {
    const file = join(directory, `${id}.db`)
    return SqliteSyncStore.open({
      openDatabase: () => openSqlite(file),
      deleteDatabase: () => {
        rmSync(file, { force: true })
      },
      onDegraded: (degradation) => degradations.push(degradation),
    })
  }
  return {
    name: 'mobile (SQLite)',
    open: async (id) => {
      const store = await open(id)
      return { cache: store.viewFor('default').cache }
    },
    reopen: async (id) => {
      const store = await open(id)
      const rows = store.viewFor('default').cache.readEntities()
      expect(degradations).toEqual([])
      return rows
    },
    cleanup: () => {
      rmSync(directory, { recursive: true, force: true })
    },
  }
}

interface Client {
  readonly id: string
  readonly replica: Replica
  readonly sink: FeedSink
  readonly events: ReplicaEvent[]
  /**
   * Events emitted SINCE `mark` — the only honest window for a "nothing was
   * rendered" claim.
   *
   * The first draft counted from index 0 and the watermark case failed on an
   * `upserted` from its own bootstrap, three frames earlier. That is the benign
   * direction of the mistake; the dangerous one is the same off-by-a-lifetime in
   * a case asserting an ABSENCE, which would have passed by measuring a window
   * where the thing genuinely never happened.
   */
  since(mark: number, type: ReplicaEvent['type']): ReplicaEvent[]
  pushWorld(): void
  pushDelta(from: number, upTo?: number): void
  /** `entity:entityId` keys currently held, sorted. */
  keys(): string[]
}

describe.each([webBackend, mobileBackend].map((make) => [make().name, make] as const))(
  'POD-378 removal family — %s',
  (_name, makeBackend) => {
    let backend: Backend
    let authority: ConformanceAuthority
    let clients: Client[]

    beforeEach(() => {
      backend = makeBackend()
      authority = new ConformanceAuthority()
      clients = []
    })

    afterEach(() => {
      backend.cleanup()
      clients = []
    })

    /** One client: the real store, the real kernel Replica, the real feed consumer. */
    async function openClient(principal: ConformancePrincipal, id: string): Promise<Client> {
      const opened = await backend.open(id)
      const events: ReplicaEvent[] = []
      const bootstraps = new PushedBootstrapSource({
        requestFreshWorld: () => {
          // The transport would reconnect and the server would push. Explicit
          // here, so a case that needs one and does not get it FAILS on the
          // bootstrap timeout rather than silently reading a stale slot.
          client.pushWorld()
        },
      })
      const port = authority.portFor(principal)
      const replica = new Replica({
        store: opened.cache as never,
        authority: new FeedAuthorityClient({
          fetchChangesSince: async (cursor) => {
            const reply = await port.changesSince(cursor)
            if (reply.kind === 'bootstrap-required') {
              return {
                kind: 'bootstrap-required',
                ...(reply.reason === undefined ? {} : { reason: reply.reason }),
              }
            }
            return {
              kind: 'delta',
              feedId: reply.feedId,
              epoch: reply.epoch,
              fromSeq: reply.fromSeq,
              seq: reply.seq,
              minAvailableSeq: reply.minAvailableSeq,
              changes: reply.changes.map((change) =>
                change.op === 'upsert'
                  ? {
                      seq: change.seq,
                      entity: change.entity,
                      entityId: change.entityId,
                      op: 'upsert' as const,
                      value: change.payload,
                    }
                  : {
                      seq: change.seq,
                      entity: change.entity,
                      entityId: change.entityId,
                      op: change.op,
                    },
              ),
            }
          },
          bootstraps,
        }),
        onEvent: (event) => events.push(event),
      })
      const sink = new FeedSink({ replica, bootstraps })
      const client: Client = {
        id,
        replica,
        sink,
        events,
        since: (mark, type) => events.slice(mark).filter((event) => event.type === type),
        pushWorld: () => {
          void (async () => {
            for await (const chunk of port.bootstrap()) sink.frame(asWireBootstrap(chunk))
          })()
        },
        pushDelta: (from, upTo) =>
          sink.frame(asWireDelta(authority.frameFor(principal, from, upTo))),
        keys: () =>
          replica
            .entities()
            .map((row) => `${row.entity}:${row.entityId}`)
            .sort(),
      }
      clients.push(client)
      return client
    }

    async function online(client: Client): Promise<void> {
      client.sink.connected()
      await client.replica.settled()
    }

    /** A session row the cases can move around. */
    function session(id: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
      return { id, title: id, ...extra }
    }

    // ── 1. A DELETE IS GONE, AND GONE FOR EVERYONE ──────────────────────────

    it('renders a delete as gone-and-deleted, on disk and for every principal', async () => {
      authority.append({ entity: 'session', entityId: 's1', op: 'upsert', payload: session('s1') })
      authority.grant(ALICE.userId, 'session', 's1')
      authority.grant(BOB.userId, 'session', 's1')
      const alice = await openClient(ALICE, 'alice')
      const bob = await openClient(BOB, 'bob')
      await online(alice)
      await online(bob)
      expect(alice.keys()).toContain('session:s1')
      expect(bob.keys()).toContain('session:s1')

      const mark = alice.events.length
      const from = authority.head()
      authority.append({ entity: 'session', entityId: 's1', op: 'remove' })
      alice.pushDelta(from)
      bob.pushDelta(from)
      await alice.replica.settled()
      await bob.replica.settled()

      // THE DISTINGUISHING ASSERTION, and it is `exitKind` rather than absence:
      // absence is what all three removals have in common, so a case asserting
      // only absence passes just as well when a delete is applied as an eviction.
      expect(alice.replica.exitKind('session', 's1')).toBe('removed')
      expect(bob.replica.exitKind('session', 's1')).toBe('removed')
      expect(alice.since(mark, 'removed')).toHaveLength(1)
      expect(alice.since(mark, 'evicted')).toHaveLength(0)

      // Gone from the DURABLE bytes, read through a store that never held it.
      const durable = await backend.reopen('alice')
      expect(durable.map((row) => `${row.entity}:${row.entityId}`)).not.toContain('session:s1')
    })

    // ── 2. A REVOKED SHARE LEAVES MY VIEW AND IS NOT A DELETION ─────────────

    it('renders a revoked share as gone-from-my-view, never as a deletion', async () => {
      authority.append({ entity: 'session', entityId: 's1', op: 'upsert', payload: session('s1') })
      authority.grant(ALICE.userId, 'session', 's1')
      authority.grant(BOB.userId, 'session', 's1')
      const alice = await openClient(ALICE, 'alice')
      const bob = await openClient(BOB, 'bob')
      await online(alice)
      await online(bob)
      expect(bob.keys()).toContain('session:s1')

      const mark = bob.events.length
      const from = authority.head()
      authority.revoke(BOB.userId, 'session', 's1')
      bob.pushDelta(from)
      alice.pushDelta(from)
      await bob.replica.settled()
      await alice.replica.settled()

      // D14.1/D14.5. The row left Bob's view; it was NOT deleted.
      expect(bob.replica.exitKind('session', 's1')).toBe('evicted')
      expect(bob.since(mark, 'evicted')).toHaveLength(1)
      // The half that makes the distinction load-bearing rather than cosmetic: no
      // deletion semantics anywhere on Bob's side. A `removed` event here would
      // fire the domain's "deleted" reactions for a row that still exists.
      expect(bob.since(mark, 'removed')).toHaveLength(0)
      expect(bob.replica.exitKind('session', 's1')).not.toBe('removed')

      // AND IT STILL EXISTS. This is the assertion no single-client fixture can
      // make, and it is what separates an eviction from a tombstone: the row is
      // untouched for the principal who still holds the grant.
      expect(alice.keys()).toContain('session:s1')
      expect(alice.replica.exitKind('session', 's1')).toBeUndefined()

      // On disk, on both sides, through stores that never held the live state.
      expect((await backend.reopen('bob')).map((r) => `${r.entity}:${r.entityId}`)).not.toContain(
        'session:s1',
      )
      expect((await backend.reopen('alice')).map((r) => `${r.entity}:${r.entityId}`)).toContain(
        'session:s1',
      )
    })

    // ── 3. A WATERMARK-SKIPPED RANGE IS NOTHING AT ALL ──────────────────────

    it('renders a watermark-skipped range as nothing, advances the cursor, and starts no heal', async () => {
      authority.append({ entity: 'session', entityId: 's1', op: 'upsert', payload: session('s1') })
      authority.grant(BOB.userId, 'session', 's1')
      const bob = await openClient(BOB, 'bob')
      await online(bob)
      const settled = bob.replica.stats()
      const keysBefore = bob.keys()
      const mark = bob.events.length

      // A range Bob may not see ANY of: three rows granted only to Alice. The
      // suppression is the authority's own evaluation, not a literal — `frameFor`
      // resolves every seq in the covered range against Bob's grants, so the
      // watermark that arrives is the residue of a real refusal.
      const from = authority.head()
      for (const id of ['a1', 'a2', 'a3']) {
        authority.append({ entity: 'session', entityId: id, op: 'upsert', payload: session(id) })
        authority.grant(ALICE.userId, 'session', id)
      }
      const head = authority.head()
      bob.pushDelta(from, head)
      await bob.replica.settled()

      // NOTHING RENDERED — not the rows, and not a gap where they were.
      expect(bob.keys()).toEqual(keysBefore)
      expect(bob.since(mark, 'upserted')).toHaveLength(0)
      expect(bob.since(mark, 'removed')).toHaveLength(0)
      expect(bob.since(mark, 'evicted')).toHaveLength(0)

      // THE CURSOR STILL ADVANCED. Without this a suppressed range is an
      // invisible permanent gap, which is the exact failure ADR 2 names as the
      // reason a filter without a watermark is a protocol break.
      const last = bob.since(mark, 'cursor').at(-1) as
        | Extract<ReplicaEvent, { type: 'cursor' }>
        | undefined
      expect(last?.cursor.seq).toBe(head)
      expect(last?.watermarkOnly).toBe(true)
      expect(bob.replica.stats().watermarksApplied).toBeGreaterThan(settled.watermarksApplied)

      // AND NO HEAL LOOP. The counters, not the absence of a thrown error: a heal
      // that fires and succeeds leaves the same rows behind and would pass every
      // assertion above.
      expect(bob.replica.stats().heals).toBe(settled.heals)
      expect(bob.replica.stats().bootstraps).toBe(settled.bootstraps)
      expect(bob.since(mark, 'heal')).toHaveLength(0)
      expect(bob.replica.stats().pendingGaps).toBe(0)
    })

    // ── 4. PRESENT → ABSENT IS A NULLING, NOT A RETENTION ───────────────────

    it('applies a field going present→absent as a nulling, not a silent retention', async () => {
      // The shape that bit this codebase before (#170): an issue is snoozed, so
      // the row carries `deferUntil`; the server clears the snooze and the wire
      // simply STOPS carrying the field. An in-place merge that treats an absent
      // key as "unchanged" keeps the stale value forever, and the UI keeps showing
      // a snooze the user cleared — with no event left to correct it.
      authority.append({
        entity: 'issue',
        entityId: 'i1',
        op: 'upsert',
        payload: { id: 'i1', title: 'i1', deferUntil: '2026-07-07T00:00:00.000Z' },
      })
      authority.grant(BOB.userId, 'issue', 'i1')
      const bob = await openClient(BOB, 'bob')
      await online(bob)
      expect((bob.replica.view('issue', 'i1') as Record<string, unknown>).deferUntil).toBe(
        '2026-07-07T00:00:00.000Z',
      )

      const from = authority.head()
      authority.append({
        entity: 'issue',
        entityId: 'i1',
        op: 'upsert',
        payload: { id: 'i1', title: 'i1' },
      })
      bob.pushDelta(from)
      await bob.replica.settled()

      // THE ROW SURVIVES — this is not a removal, and a fix that dropped the row
      // would satisfy a naive "deferUntil is gone" assertion.
      expect(bob.keys()).toContain('issue:i1')
      expect(bob.replica.exitKind('issue', 'i1')).toBeUndefined()

      // KEY SET, not value. `toEqual` treats an undefined-valued key as absent, so
      // a value assertion passes just as well against a row that still carries the
      // field set to undefined — and a JSON round trip through storage would then
      // resurrect nothing, but an in-place merge on the NEXT delta would.
      const view = bob.replica.view('issue', 'i1') as Record<string, unknown>
      expect(Object.keys(view).sort()).toEqual(['id', 'title'])
      expect('deferUntil' in view).toBe(false)

      // And after a reload, through a store that never saw the first payload.
      const durable = await backend.reopen('bob')
      const row = durable.find((r) => r.entity === 'issue' && r.entityId === 'i1')
      expect(row).toBeDefined()
      expect(Object.keys(row?.value as Record<string, unknown>).sort()).toEqual(['id', 'title'])
    })
  },
)
