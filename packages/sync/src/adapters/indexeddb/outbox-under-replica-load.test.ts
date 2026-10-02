/**
 * POD-4810 — an outbox write must not wait behind a large replica apply.
 *
 * Found on a phone right after a 63 MB / 21,901-row cold sync: a `layout.set`
 * stalled 11 s and a `resumeAndSend` 23.8 s between enqueue and POST. The
 * outbox and the replica share one physical store (ADR 6 D4.1), and before
 * this issue every outbox state change paid for the WHOLE replica twice over:
 *
 *   - `OutboxStorePort.read()` — which the kernel Outbox calls on EVERY
 *     mutation, to rebase on fresh truth — re-read every entity row, not just
 *     the outbox's own, after first waiting for every queued replica commit;
 *   - the outbox's own commit then queued behind those replica commits on the
 *     store's single serial write queue, in a transaction scoped to all three
 *     object stores, so IndexedDB itself also ordered it after them.
 *
 * A send is several state changes (enqueue, sending, applied, retire), so the
 * user waited for several full replica reads before and after the POST.
 *
 * These cases pin the design that replaced it: the outbox region reads and
 * commits in its own lane — its own serial queue and a transaction scoped to
 * the outbox object store alone — while durability (a queued write survives a
 * reload) and exactly-once delivery stay what they were.
 */

import type { MutationId } from '@podium/model'
import { actorUser, asUserId } from '@podium/model'
import { describe, expect, it } from 'vitest'
import { Outbox } from '../../outbox/outbox'
import type { OutboxRecord } from '../../outbox/records'
import { ScriptedAuthority, sequentialMutationIds } from '../../outbox/test-doubles'
import type { EntityRecord } from '../../replica/types'
import { ENTITY_STORE, META_STORE, OUTBOX_STORE } from './schema'
import { IndexedDbSyncStore } from './store'
import { FaultyIdbFactory, freshFactory } from './test-support'

const ADA = asUserId('ada')
const MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000
/** The field case was 21,901 rows; the brief's bound is stated at 20k. */
const ROWS = 20_000
/** The brief's bound: an enqueue during a 20k-row apply completes within 1 s. */
const BOUND_MS = 1_000
const command = { name: 'layout.set', version: 1, delivery: 'offline-eligible' } as const
const attribution = { actor: actorUser(ADA), onBehalfOf: ADA } as const

// ~2.9 KB a row: 63 MB over 21,901 rows is what the phone actually held, so the
// structured-clone and getAll cost is measured against a real row, not a toy.
const PAD = 'x'.repeat(2_600)
const rows = (generation: string): EntityRecord[] =>
  Array.from({ length: ROWS }, (_, i) => ({
    entity: 'issueProjection',
    entityId: `POD-${i}`,
    value: { id: `POD-${i}`, title: `issue ${i} ${generation}`, body: PAD, stage: 'backlog' },
    revision: 1,
    provenance: { seq: 1 },
  }))
const cursor = (seq: number) => ({ feedId: 'feed', epoch: 'e1', seq })

async function openStore(factory: FaultyIdbFactory): Promise<IndexedDbSyncStore> {
  return await IndexedDbSyncStore.open({
    factory,
    onDegraded: (degradation) => {
      throw new Error(`unexpected degradation: ${degradation.cause}`)
    },
  })
}

const T0 = 1_700_000_000_000
/** A reload happens later than the failed attempt's backoff, so the retry is due. */
const RELAUNCHED = T0 + 60_000

async function openOutbox(store: IndexedDbSyncStore, authority: ScriptedAuthority, at = T0) {
  return await Outbox.open({
    store: store.viewFor(ADA).outbox,
    submit: authority,
    principal: ADA,
    now: () => at,
    maxAgeMs: MAX_AGE_MS,
    newMutationId: sequentialMutationIds(),
    onStoreUnreadable: (error) => {
      throw error
    },
  })
}

/** A replica that already holds a cold sync's worth of rows, durably. */
async function syncedReplica(): Promise<{ factory: FaultyIdbFactory; store: IndexedDbSyncStore }> {
  const factory = new FaultyIdbFactory(freshFactory())
  const store = await openStore(factory)
  store.viewFor(ADA).cache.installSnapshot(rows('v1'), cursor(1), [])
  await store.settled()
  return { factory, store }
}

/** A raw queued record, for driving the storage port directly. */
const queued = (id: string): OutboxRecord => ({
  mutationId: id as MutationId,
  command,
  input: { panes: ['chat'] },
  partitionKey: 'layout:ada',
  attribution,
  state: 'queued',
  queuedAt: T0,
  attempts: 0,
})
const absent = (id: string) => ({ mutationId: id as MutationId, expect: 'absent' as const })

const layoutSet = (id: MutationId) => ({
  mutationId: id,
  command,
  input: { panes: ['chat'] },
  attribution,
  partitionKey: 'layout:ada',
})

describe('POD-4810: outbox writes during a large replica apply (IndexedDB)', () => {
  it('an enqueue during a 20k-row apply is durable within 1 s, ahead of the apply', async () => {
    const { factory, store } = await syncedReplica()
    const outbox = await openOutbox(store, new ScriptedAuthority(() => ({ kind: 'applied' })))

    // The next sync's apply: 20k rows staged and committing when the user acts.
    store.viewFor(ADA).cache.installSnapshot(rows('v2'), cursor(2), [])
    let replicaCommitted = false
    void store.settled().then(() => {
      replicaCommitted = true
    })
    const transactionsBefore = factory.transactions.length
    const getAllsBefore = factory.getAlls.length

    const t0 = performance.now()
    await outbox.enqueue(layoutSet('m-layout' as MutationId))
    const elapsed = performance.now() - t0
    console.log(`POD-4810 idb enqueue during ${ROWS}-row apply: ${elapsed.toFixed(0)} ms`)

    // What the outbox's own write touched. Not one entity row read, and every
    // transaction it opened scoped to the outbox store alone — the scope is what
    // lets IndexedDB run it beside the replica's transaction instead of after it.
    // (The replica's own transaction may open inside this window too; it is the
    // one whose scope must not include the outbox's store, and vice versa.)
    const opened = factory.transactions.slice(transactionsBefore)
    expect(factory.getAlls.slice(getAllsBefore)).not.toContain(ENTITY_STORE)
    const outboxWrites = opened.filter((tx) => tx.names.includes(OUTBOX_STORE))
    expect(outboxWrites.filter((tx) => tx.mode === 'readwrite')).toHaveLength(1)
    for (const tx of outboxWrites) expect(tx.names).toEqual([OUTBOX_STORE])
    // It overtook the apply rather than waiting for it…
    expect(replicaCommitted).toBe(false)
    // …and did so inside the bound.
    expect(elapsed).toBeLessThan(BOUND_MS)

    // Both writes are durable once everything settles: a fresh connection over the
    // same engine — the mirror died with the old object — sees the queued write
    // AND the whole apply.
    await store.settled()
    expect(replicaCommitted).toBe(true)
    store.close()
    const reopened = await openStore(factory)
    const records = await reopened.viewFor(ADA).outbox.read()
    expect(records.map((r) => [r.mutationId, r.state])).toEqual([['m-layout', 'queued']])
    const view = reopened.viewFor(ADA).cache
    expect(view.readEntities()).toHaveLength(ROWS)
    expect((view.read('issueProjection', 'POD-7')?.value as { title: string }).title).toBe(
      'issue 7 v2',
    )
    expect(view.readCursor()).toEqual(cursor(2))
  }, 120_000)

  it('the whole send — enqueue, POST, applied, retire — runs during the apply, exactly once', async () => {
    const { factory, store } = await syncedReplica()
    const authority = new ScriptedAuthority(() => ({ kind: 'applied' }))
    const outbox = await openOutbox(store, authority)

    store.viewFor(ADA).cache.installSnapshot(rows('v2'), cursor(2), [])
    let replicaCommitted = false
    void store.settled().then(() => {
      replicaCommitted = true
    })
    const getAllsBefore = factory.getAlls.length

    const t0 = performance.now()
    await outbox.enqueue(layoutSet('m-send' as MutationId))
    await outbox.drain()
    const posted = performance.now() - t0
    await outbox.retireApplied('m-send' as MutationId)
    const retired = performance.now() - t0
    console.log(
      `POD-4810 idb send during ${ROWS}-row apply: posted ${posted.toFixed(0)} ms, retired ${retired.toFixed(0)} ms`,
    )

    expect(authority.envelopes.map((e) => e.mutationId)).toEqual(['m-send'])
    expect(factory.getAlls.slice(getAllsBefore)).not.toContain(ENTITY_STORE)
    expect(replicaCommitted).toBe(false)
    expect(retired).toBeLessThan(BOUND_MS)

    // Exactly once, across a reload too: the retirement is durable, so a fresh
    // connection and a fresh Outbox find nothing to send again.
    await store.settled()
    store.close()
    const reopened = await openStore(factory)
    const again = await openOutbox(reopened, authority)
    await again.drain()
    expect(authority.envelopes.map((e) => e.mutationId)).toEqual(['m-send'])
    expect(again.all()).toEqual([])
  }, 120_000)

  it('an offline write survives a reload and is sent exactly once afterwards', async () => {
    const { factory, store } = await syncedReplica()
    const offline = new ScriptedAuthority(() => ({ kind: 'unreachable' }))
    const outbox = await openOutbox(store, offline)
    store.viewFor(ADA).cache.installSnapshot(rows('v2'), cursor(2), [])
    await outbox.enqueue(layoutSet('m-offline' as MutationId))
    await outbox.drain()
    expect(outbox.pending().map((r) => r.state)).toEqual(['queued'])

    // Reload: the tab dies with the apply and the write both committed or both in
    // flight; a fresh connection must hold the write either way.
    await store.settled()
    store.close()
    const reopened = await openStore(factory)
    const online = new ScriptedAuthority(() => ({ kind: 'applied' }))
    const again = await openOutbox(reopened, online, RELAUNCHED)
    expect(again.pending().map((r) => r.mutationId)).toEqual(['m-offline'])
    await again.drain()
    await again.drain()
    expect(online.envelopes.map((e) => e.mutationId)).toEqual(['m-offline'])
  }, 120_000)

  it('a commit spanning both regions waits for every earlier replica commit', async () => {
    // The cross-region path (a sign-out erase; a retirement enrolled with the frame
    // that confirms it) must stay behind EVERY earlier commit of both regions. Two
    // applies in flight is the shape that tells: the second one has not opened its
    // transaction yet, so if the erase skipped the replica's queue IndexedDB would
    // run it first, and the older apply's rows would land on top of the erase.
    const { factory, store } = await syncedReplica()
    const outbox = await openOutbox(store, new ScriptedAuthority(() => ({ kind: 'unreachable' })))
    await outbox.enqueue(layoutSet('m-erased' as MutationId))
    const cache = store.viewFor(ADA).cache
    cache.installSnapshot(rows('v2'), cursor(2), [])
    cache.installSnapshot(rows('v3'), cursor(3), [])
    const transactionsBefore = factory.transactions.length
    await store.erasePrincipal(ADA)
    const erase = factory.transactions
      .slice(transactionsBefore)
      .find((tx) => tx.mode === 'readwrite' && tx.names.includes(OUTBOX_STORE))
    expect(erase?.names).toEqual([ENTITY_STORE, META_STORE, OUTBOX_STORE])
    await store.settled()
    store.close()
    const reopened = await openStore(factory)
    expect(await reopened.viewFor(ADA).outbox.read()).toEqual([])
    expect(reopened.viewFor(ADA).cache.readEntities()).toEqual([])
    expect(reopened.viewFor(ADA).cache.readCursor()).toBeNull()
  }, 120_000)

  it('the outbox read waits for an outbox commit already queued behind the replica', async () => {
    // Waiting only for its own region is what makes the read fast; waiting for its
    // own region at ALL is what keeps it true. A both-regions commit sits in the
    // replica's queue behind an apply — the read must not answer without it, or a
    // rebase would stage against a queue missing a committed-to-be write.
    const { store } = await syncedReplica()
    const view = store.viewFor(ADA)
    view.cache.installSnapshot(rows('v2'), cursor(2), [])
    const span = store.beginSpan()
    view.cache.applyAtomic({ operations: [], cursor: cursor(3) }, span)
    void view.outbox.apply({ put: [queued('m-enrolled')], expect: [absent('m-enrolled')] }, span)
    span.commit()

    const read = await view.outbox.read()
    expect(read.map((r) => r.mutationId)).toEqual(['m-enrolled'])
    await store.settled()
  }, 120_000)

  it('an outbox re-read never hands out an ordinal an open span already took', async () => {
    // FIFO across a reload is carried by the ordinal. A re-read that recomputed the
    // next ordinal from durable rows alone would reuse the one an uncommitted span
    // staged, and the tie would reload in key order — here, the wrong order.
    const { factory, store } = await syncedReplica()
    const view = store.viewFor(ADA)
    const span = store.beginSpan()
    void view.outbox.apply({ put: [queued('z-first')], expect: [absent('z-first')] }, span)
    await view.outbox.read()
    await view.outbox.apply({ put: [queued('a-second')], expect: [absent('a-second')] })
    span.commit()
    await store.settled()
    store.close()
    const reopened = await openStore(factory)
    const order = (await reopened.viewFor(ADA).outbox.read()).map((r) => r.mutationId)
    expect(order).toEqual(['z-first', 'a-second'])
  }, 120_000)
})
