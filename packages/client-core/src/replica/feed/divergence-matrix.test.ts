/**
 * POD-376 — THE DIVERGENCE MATRIX.
 *
 * Governed by `docs/agents/pod-376-shadow-comparison-basis.md` §4. Where this file
 * and that document disagree, this file is wrong.
 *
 * ---------------------------------------------------------------------------
 * WHAT IS REAL HERE, AND WHY EACH PIECE HAD TO BE
 * ---------------------------------------------------------------------------
 *
 *   THE AUTHORITY   `ConformanceAuthority` — a global log plus the SHIPPED
 *                   `GrantEdgeVisibilityPolicy` over a stub state port. Its own
 *                   header states the property that matters: a watermark is the
 *                   RESIDUE of evaluating a range against a principal, never a
 *                   literal a test asked for. A scripted authority would let every
 *                   case below pass while proving nothing about scoping.
 *   THE WIRE        Kernel frames are re-expressed as v2 WIRE messages and fed
 *                   through `frames.ts` and `FeedSink`. Handing kernel frames
 *                   straight to the Replica would skip the translation this issue
 *                   actually adds, and every case would then be a re-test of
 *                   POD-306.
 *   THE STORAGE     A real `IndexedDbSyncStore` on a real IndexedDB engine, so
 *                   cold-start paint and the cursor-after-data invariant are
 *                   claims about durable state rather than about a Map.
 *   THE POLICY      A STUB, deliberately and per the brief: share/unshare commands
 *                   are Phase 3 (POD-290). `grant`/`revoke` here move the table,
 *                   which is the mechanism; they are not the product's commands.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS CANNOT EVIDENCE
 * ---------------------------------------------------------------------------
 *
 * Two principals here are two `FeedPrincipal` values. The shipped authenticator is
 * device-grade — one shared password, two connections indistinguishable AS PERSONS
 * — so these cases prove the MECHANISM carries the distinction end to end, and do
 * not prove per-person isolation. Basis document §5 states the split; nothing here
 * should be read as the second-account check.
 */

import { ConformanceAuthority, type ConformancePrincipal, conformanceUser } from '@podium/sync'
import { type IdbFactoryLike, IndexedDbSyncStore } from '@podium/sync/adapters/indexeddb'
import {
  type BootstrapChunk,
  type DeltaFrame,
  Replica,
  type ReplicaEvent,
} from '@podium/sync/replica'
import { IDBFactory } from 'fake-indexeddb'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { FeedServerFrame } from '../../socket-transport'
import { FeedAuthorityClient } from './authority-client'
import { PushedBootstrapSource } from './bootstrap-source'
import { FeedSink } from './sink'

const ALICE: ConformancePrincipal = conformanceUser('user:alice')
const BOB: ConformancePrincipal = conformanceUser('user:bob')

/**
 * Kernel `DeltaFrame` → the v2 WIRE message.
 *
 * The inverse of `frames.ts`, and it exists so the cases below travel the code
 * under test. Note it is NOT the inverse used to check `frames.ts` against itself:
 * the assertions are about replica STATE after a frame, so a bug in either
 * direction shows up as the wrong rows, not as a mismatched round trip.
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

/**
 * A kernel `BootstrapChunk` → the v2 wire message.
 *
 * The chunks come from `ConformanceAuthority.portFor(principal).bootstrap()` —
 * the fixture's OWN walk — and not from `frameFor`. That distinction cost a
 * failing case and is worth recording: `frameFor` replays the LOG filtered per
 * principal, so a grant's anchored row stays in it after the grant is revoked,
 * because the anchored row was a legitimate per-principal delivery at its seq. A
 * bootstrap is POSITIVE CURRENT STATE (D15), which is a different question with a
 * different answer, and building one out of a log replay would have installed a
 * world containing a row the principal can no longer see.
 */
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

interface Client {
  readonly replica: Replica
  readonly sink: FeedSink
  readonly store: IndexedDbSyncStore
  readonly events: ReplicaEvent[]
  /** Feed the world the server would push at this moment. */
  pushWorld(): void
  /** Feed the certified range `(from, head]`. */
  pushDelta(from: number, upTo?: number): void
  /** `(entity, entityId)` keys the client holds, sorted. The comparison snapshot. */
  keys(): string[]
  freshWorldRequests: number
  /** Surfaced storage degradations (D4.4). Asserted empty — see `online`. */
  readonly degradations: unknown[]
}

describe('POD-376 divergence matrix', () => {
  let factory: IdbFactoryLike
  let authority: ConformanceAuthority
  let clients: Client[]

  beforeEach(() => {
    factory = new IDBFactory() as unknown as IdbFactoryLike
    authority = new ConformanceAuthority()
    clients = []
  })

  afterEach(() => {
    clients = []
  })

  /** One client: real store, real kernel Replica, real client-side feed consumer. */
  async function openClient(
    principal: ConformancePrincipal,
    opts: { databaseName?: string } = {},
  ): Promise<Client> {
    const degradations: unknown[] = []
    const store = await IndexedDbSyncStore.open({
      factory,
      databaseName: opts.databaseName ?? `replica-${principal.kind}-${JSON.stringify(principal)}`,
      // COLLECTED AND ASSERTED, not discarded. D4.4 requires degradation to be
      // surfaced rather than silent, and a matrix that ran against a store which
      // had quietly fallen back to memory would be asserting cold-start paint on
      // state that never touched IndexedDB — an all-green probe measuring nothing.
      onDegraded: (degradation) => degradations.push(degradation),
    })
    const view = store.viewFor('default')
    const events: ReplicaEvent[] = []
    let freshWorldRequests = 0
    const bootstraps = new PushedBootstrapSource({
      requestFreshWorld: () => {
        freshWorldRequests += 1
        // The transport would reconnect and the server would push. Here the push
        // is explicit, so a case that forgets it FAILS on the bootstrap timeout
        // rather than silently reading a stale slot.
        client.pushWorld()
      },
    })
    const port = authority.portFor(principal)
    const replica = new Replica({
      store: view.cache,
      // The heal half is the CONFORMANCE authority's own port — the same
      // `changesSince` the suite uses — because rung 1 is not what this issue
      // changed. The bootstrap half is the pushed seam, which is.
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
      replica,
      sink,
      store,
      events,
      pushWorld: () => {
        // ASYNCHRONOUS, like the real one: the server pushes after a reconnect,
        // and the source's waiter is registered before the request is made
        // precisely so both timings work. Multi-chunk by default (the fixture's
        // chunkSize is 2), so this also walks the source's chunk loop rather than
        // only its first-chunk path.
        void (async () => {
          for await (const chunk of port.bootstrap()) sink.frame(asWireBootstrap(chunk))
        })()
      },
      pushDelta: (from, upTo) => sink.frame(asWireDelta(authority.frameFor(principal, from, upTo))),
      keys: () =>
        replica
          .entities()
          .map((row) => `${row.entity}:${row.entityId}`)
          .sort(),
      get freshWorldRequests() {
        return freshWorldRequests
      },
      degradations,
    }
    clients.push(client)
    return client
  }

  /** Bring a client online and let its ladder settle. */
  async function online(client: Client): Promise<void> {
    client.sink.connected()
    await client.replica.settled()
    await client.store.settled()
    // The storage stayed DURABLE through the bootstrap. Every case below asserts
    // on persisted state, and a store that degraded to memory would satisfy most
    // of them while proving nothing about IndexedDB.
    expect(client.degradations).toEqual([])
    expect(client.store.viewFor('default').cache.durability()).toBe('durable')
  }

  // ── 1–3: the ordinary cases ────────────────────────────────────────────────

  it('case 1 · a cold client bootstraps to exactly the authority slice', async () => {
    authority.append({ entity: 'session', entityId: 's1', op: 'upsert', payload: { id: 's1' } })
    authority.grant('user:alice', 'session', 's1')
    const alice = await openClient(ALICE)
    await online(alice)
    expect(alice.keys()).toEqual(['session:s1'])
    expect(alice.replica.cursor).not.toBeNull()
  })

  it('case 3 · steady-state deltas leave the client equal to the slice', async () => {
    authority.append({ entity: 'session', entityId: 's1', op: 'upsert', payload: { id: 's1' } })
    authority.grant('user:alice', 'session', 's1')
    const alice = await openClient(ALICE)
    await online(alice)
    const at = alice.replica.cursor?.seq ?? 0
    authority.append({ entity: 'issue', entityId: 'i1', op: 'upsert', payload: { id: 'i1' } })
    authority.grant('user:alice', 'issue', 'i1')
    alice.pushDelta(at)
    await alice.replica.settled()
    expect(alice.keys()).toEqual(['issue:i1', 'session:s1'])
  })

  // ── 2: cold-start paint from durable state ────────────────────────────────

  it('case 2 · a warm client paints from IndexedDB BEFORE the network, and its cursor never leads its data', async () => {
    authority.append({ entity: 'session', entityId: 's1', op: 'upsert', payload: { id: 's1' } })
    authority.grant('user:alice', 'session', 's1')
    const first = await openClient(ALICE, { databaseName: 'warm-start' })
    await online(first)
    const cursorAtShutdown = first.replica.cursor
    expect(cursorAtShutdown).not.toBeNull()

    // A NEW store object over the SAME IndexedDB origin — the reload. Nothing of
    // the previous object survives, so what is read back is what committed.
    const reloaded = await openClient(ALICE, { databaseName: 'warm-start' })

    // THE PAINT, BEFORE ANY FRAME. `connected()` has not been called; no socket
    // exists. This assertion is the cold-start-paint criterion, and it is made at
    // the one moment where the network cannot be the source.
    expect(reloaded.keys()).toEqual(['session:s1'])
    expect(reloaded.replica.posture).toBe('stale')

    // CURSOR-AFTER-DATA (ADR 6 D4.2): the persisted cursor implies every mutation
    // it covers is durable. Asserted as "the cursor came back with the rows",
    // never "a cursor came back" — a store that persisted a cursor and lost the
    // rows would satisfy the weaker claim and is exactly the torn state D4.1
    // forbids.
    expect(reloaded.replica.cursor).toEqual(cursorAtShutdown)
  })

  // ── 4: grant mid-session ──────────────────────────────────────────────────

  it('case 4 · a grant mid-session arrives as a re-admitting upsert, contiguous, with no heal', async () => {
    authority.append({ entity: 'session', entityId: 'mine', op: 'upsert', payload: { id: 'mine' } })
    authority.grant('user:alice', 'session', 'mine')
    authority.append({
      entity: 'session',
      entityId: 'theirs',
      op: 'upsert',
      payload: { id: 'theirs' },
    })
    authority.grant('user:bob', 'session', 'theirs')

    const alice = await openClient(ALICE)
    await online(alice)
    expect(alice.keys()).toEqual(['session:mine'])
    const healsBefore = alice.replica.stats().heals

    const at = alice.replica.cursor?.seq ?? 0
    authority.grant('user:alice', 'session', 'theirs')
    alice.pushDelta(at)
    await alice.replica.settled()

    expect(alice.keys()).toEqual(['session:mine', 'session:theirs'])
    // CONTIGUITY INTACT. The grant burned a global seq and the row was anchored at
    // that same seq, so the frame's `fromSeq` chained onto the cursor and rung 0
    // accepted it. A heal here would mean the anchored row arrived at a seq the
    // replica could not chain — the invisible-gap failure D13 exists to prevent.
    expect(alice.replica.stats().heals).toBe(healsBefore)
    expect(alice.replica.stats().pendingGaps).toBe(0)
  })

  // ── 5: revoke mid-session — NOT a deletion ────────────────────────────────

  it('case 5 · a revoke leaves the view as an EVICT, and is not rendered as a deletion', async () => {
    authority.append({
      entity: 'session',
      entityId: 'shared',
      op: 'upsert',
      payload: { id: 'shared' },
    })
    authority.grant('user:alice', 'session', 'shared')
    const alice = await openClient(ALICE)
    await online(alice)
    expect(alice.keys()).toEqual(['session:shared'])

    const at = alice.replica.cursor?.seq ?? 0
    authority.revoke('user:alice', 'session', 'shared')
    alice.pushDelta(at)
    await alice.replica.settled()

    expect(alice.keys()).toEqual([])
    // THE DISTINCTION, ASSERTED THREE WAYS — because "the row is gone" is true of a
    // deletion too, and a test that only checked absence would pass against the
    // exact bug D14.5 names (folding evict into remove).
    expect(alice.replica.exitKind('session', 'shared')).toBe('evicted')
    expect(alice.events.filter((e) => e.type === 'removed')).toEqual([])
    expect(alice.events.filter((e) => e.type === 'evicted')).toHaveLength(1)
  })

  it('case 5b · a real DELETION is still rendered as one — the two arms are distinguishable', async () => {
    // The counterfactual. Without it, case 5 is satisfied by a client that reports
    // EVERYTHING as an eviction, which loses the distinction just as completely.
    authority.append({
      entity: 'session',
      entityId: 'doomed',
      op: 'upsert',
      payload: { id: 'doomed' },
    })
    authority.grant('user:alice', 'session', 'doomed')
    const alice = await openClient(ALICE)
    await online(alice)

    const at = alice.replica.cursor?.seq ?? 0
    authority.append({ entity: 'session', entityId: 'doomed', op: 'remove' })
    alice.pushDelta(at)
    await alice.replica.settled()

    expect(alice.keys()).toEqual([])
    expect(alice.replica.exitKind('session', 'doomed')).toBe('removed')
    expect(alice.events.filter((e) => e.type === 'removed')).toHaveLength(1)
    expect(alice.events.filter((e) => e.type === 'evicted')).toEqual([])
  })

  // ── 6: a long watermark-only stretch ──────────────────────────────────────

  it('case 6 · 200 watermark-only frames advance the cursor and change nothing else', async () => {
    authority.append({ entity: 'session', entityId: 'mine', op: 'upsert', payload: { id: 'mine' } })
    authority.grant('user:alice', 'session', 'mine')
    const alice = await openClient(ALICE)
    await online(alice)

    const keysBefore = alice.keys()
    const healsBefore = alice.replica.stats().heals
    const bootstrapsBefore = alice.replica.stats().bootstraps

    for (let i = 0; i < 200; i += 1) {
      // Bob's rows. Alice may not see any of them, so every frame she receives is
      // a watermark — DERIVED from the evaluation, not a literal. That is what
      // makes this a scoping case rather than a "does the replica accept empty
      // frames" case.
      const id = `theirs-${i}`
      authority.append({ entity: 'session', entityId: id, op: 'upsert', payload: { id } })
      authority.grant('user:bob', 'session', id)
      alice.pushDelta(alice.replica.cursor?.seq ?? 0)
    }
    await alice.replica.settled()

    expect(alice.replica.cursor?.seq).toBe(authority.head())
    expect(alice.keys()).toEqual(keysBefore)
    // NO HEAL LOOP. The failure this guards is the one POD-351 named: a filter
    // without a watermark leaves a permanent invisible gap and the replica heals
    // forever. Both counters, because a heal that escalated to a re-bootstrap
    // would leave `heals` flat.
    expect(alice.replica.stats().heals).toBe(healsBefore)
    expect(alice.replica.stats().bootstraps).toBe(bootstrapsBefore)
    expect(alice.replica.stats().pendingGaps).toBe(0)
    // STATE STAYS BOUNDED (D13.4) — a watermark stretch must not accumulate.
    expect(alice.replica.stats().bufferedFrames).toBe(0)
    expect(alice.replica.stats().watermarksApplied).toBeGreaterThan(0)
  })

  // ── 7: scoped re-bootstrap ────────────────────────────────────────────────

  it('case 7 · a rescope re-bootstraps scoped, through the pushed-world seam', async () => {
    authority.append({ entity: 'session', entityId: 'a', op: 'upsert', payload: { id: 'a' } })
    authority.grant('user:alice', 'session', 'a')
    authority.append({ entity: 'session', entityId: 'b', op: 'upsert', payload: { id: 'b' } })
    authority.grant('user:alice', 'session', 'b')
    const alice = await openClient(ALICE)
    await online(alice)
    expect(alice.keys()).toEqual(['session:a', 'session:b'])
    const requestsBefore = alice.freshWorldRequests

    // The rights moved by more than it is worth enumerating. The replica must
    // discard and re-bootstrap SCOPED — and the world it re-installs is the one
    // the authority evaluates NOW, so the revoked row does not come back.
    authority.policy.revoke('user:alice', 'session', 'b')
    alice.sink.frame({
      type: 'feedRescope',
      feedId: alice.replica.cursor?.feedId ?? '',
      epoch: alice.replica.cursor?.epoch ?? '',
      seq: authority.head(),
      cause: 'rights-changed',
    } as FeedServerFrame)
    await alice.replica.settled()

    expect(alice.keys()).toEqual(['session:a'])
    // The re-bootstrap went through the PUSH/PULL seam rather than some other
    // route: the source had no fresh world, so it asked for one. Without this the
    // case would pass against a client that re-read its own cache.
    expect(alice.freshWorldRequests).toBe(requestsBefore + 1)
  })

  it('case 7b · a rescope keeps the OUTBOX — the cache port structurally cannot reach it', async () => {
    // ADR 2 D7's keep-the-outbox rule, asserted where it now MATTERS: before
    // multi-user a rescope was unreachable, and under private-by-default a
    // colleague clicking "share" fires it. `replica/ports.ts` makes this
    // structural — `ReplicaCacheStore` has no outbox method — and this is the
    // observation that the structure holds through a real store.
    authority.append({ entity: 'session', entityId: 'a', op: 'upsert', payload: { id: 'a' } })
    authority.grant('user:alice', 'session', 'a')
    const alice = await openClient(ALICE)
    await online(alice)

    const view = alice.store.viewFor('default')
    await view.outbox.apply({
      put: [
        {
          mutationId: 'm-1' as never,
          command: 'session.rename' as never,
          input: { name: 'x' },
          partitionKey: 'session:a',
          attribution: { actor: 'user:alice', onBehalfOf: 'user:alice' } as never,
          state: 'queued',
          queuedAt: 1,
          attempts: 0,
        },
      ],
      // REQUIRED, and it must cover every key touched — `ports.ts` explains why an
      // optional `expect` would be a hole. 'absent' is the honest expectation for
      // a first enqueue.
      expect: [{ mutationId: 'm-1' as never, expect: 'absent' }],
    })
    await alice.store.settled()
    expect(await view.outbox.read()).toHaveLength(1)

    alice.sink.frame({
      type: 'feedRescope',
      feedId: alice.replica.cursor?.feedId ?? '',
      epoch: alice.replica.cursor?.epoch ?? '',
      seq: authority.head(),
      cause: 'rights-changed',
    } as FeedServerFrame)
    await alice.replica.settled()
    await alice.store.settled()

    // The user's unsent work survived the discard. This is the assertion that
    // would fail if `discardCache` ever grew a reach into the outbox.
    expect(await view.outbox.read()).toHaveLength(1)
  })

  // ── the comparison basis itself ───────────────────────────────────────────

  it('the classification is against the AUTHORITY slice: a row Bob cannot see is absent from Bob and present for Alice', async () => {
    // The basis document's §2.2 rule, at the seam it governs. Alice and Bob run
    // the SAME client code against the SAME authority and legitimately hold
    // different sets of rows — which is precisely why a naive snapshot diff
    // between two paths would report correct scoping as divergence.
    authority.append({
      entity: 'session',
      entityId: 'private-to-alice',
      op: 'upsert',
      payload: { id: 'p' },
    })
    authority.grant('user:alice', 'session', 'private-to-alice')

    const alice = await openClient(ALICE, { databaseName: 'alice' })
    const bob = await openClient(BOB, { databaseName: 'bob' })
    await online(alice)
    await online(bob)

    expect(alice.keys()).toEqual(['session:private-to-alice'])
    expect(bob.keys()).toEqual([])
    // And the authority AGREES about both, which is what makes Bob's absence an
    // expected difference rather than an unexplained one.
    expect(authority.policy.canSee(ALICE, 'session', 'private-to-alice')).toBe(true)
    expect(authority.policy.canSee(BOB, 'session', 'private-to-alice')).toBe(false)
  })
})
