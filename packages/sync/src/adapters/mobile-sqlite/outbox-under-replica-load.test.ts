/**
 * POD-4810 — an outbox write must not pay for the whole replica (phone).
 *
 * The field case: right after a 63 MB / 21,901-row cold sync, a `layout.set`
 * stalled 11 s and a `resumeAndSend` 23.8 s between enqueue and POST. On the
 * phone the store is synchronous SQLite, so there is no write queue to wait in;
 * what the outbox paid instead was `OutboxStorePort.read()` — called by the
 * kernel Outbox on EVERY mutation to rebase on fresh truth — re-reading and
 * JSON-parsing every entity row on the JS thread, once per state change. A send
 * is several state changes (enqueue, sending, applied, retire).
 *
 * The outbox's fresh-truth read now covers the outbox table alone, which is all
 * it ever returned. Durability and exactly-once are asserted across a real
 * reopen of the same database file.
 */

import type { MutationId } from '@podium/model'
import { actorUser, asUserId } from '@podium/model'
import { afterEach, describe, expect, it } from 'vitest'
import { Outbox } from '../../outbox/outbox'
import type { OutboxRecord } from '../../outbox/records'
import { ScriptedAuthority, sequentialMutationIds } from '../../outbox/test-doubles'
import type { EntityRecord } from '../../replica/types'
import { ENTITY_TABLE } from './schema'
import { SqliteSyncStore } from './store'
import { FaultySqlDatabase, freshDatabaseFile, sqliteEngine } from './test-support'

const ADA = asUserId('ada')
const MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000
const ROWS = 20_000
const BOUND_MS = 1_000
const command = { name: 'layout.set', version: 1, delivery: 'offline-eligible' } as const
const attribution = { actor: actorUser(ADA), onBehalfOf: ADA } as const

const PAD = 'x'.repeat(2_600)
const rows = (generation: string): EntityRecord[] =>
  Array.from({ length: ROWS }, (_, i) => ({
    entity: 'issue',
    entityId: `POD-${i}`,
    value: { id: `POD-${i}`, title: `issue ${i} ${generation}`, body: PAD, stage: 'backlog' },
    revision: 1,
    provenance: { seq: 1 },
  }))
const cursor = (seq: number) => ({ feedId: 'feed', epoch: 'e1', seq })

const cleanups: (() => void)[] = []
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup()
})

async function openStore(file: string): Promise<{ db: FaultySqlDatabase; store: SqliteSyncStore }> {
  const db = new FaultySqlDatabase(sqliteEngine.open(file))
  const store = await SqliteSyncStore.open({
    openDatabase: () => db,
    deleteDatabase: () => undefined,
    onDegraded: (degradation) => {
      throw new Error(`unexpected degradation: ${degradation.cause}`)
    },
  })
  return { db, store }
}

const T0 = 1_700_000_000_000
/** A relaunch happens later than the failed attempt's backoff, so the retry is due. */
const RELAUNCHED = T0 + 60_000

async function openOutbox(store: SqliteSyncStore, authority: ScriptedAuthority, at = T0) {
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

/** Statements that read entity rows. The cold-start hydrate is one; an outbox write must issue none. */
const entityReads = (prepared: readonly string[]): string[] =>
  prepared.filter((sql) => /^\s*SELECT\b/i.test(sql) && sql.includes(`FROM ${ENTITY_TABLE}`))

describe('POD-4810: outbox writes after a large replica apply (SQLite)', () => {
  it('a whole send after a 20k-row sync reads no entity row and lands within 1 s, exactly once', async () => {
    const { file, cleanup } = freshDatabaseFile()
    cleanups.push(cleanup)
    const { db, store } = await openStore(file)
    store.viewFor(ADA).cache.installSnapshot(rows('v1'), cursor(1), [])
    const authority = new ScriptedAuthority(() => ({ kind: 'applied' }))
    const outbox = await openOutbox(store, authority)
    // A heal frame between the user's actions, as a live stream delivers them.
    store.viewFor(ADA).cache.installSnapshot(rows('v2'), cursor(2), [])
    const preparedBefore = db.prepared.length

    const t0 = performance.now()
    await outbox.enqueue(layoutSet('m-send' as MutationId))
    const enqueued = performance.now() - t0
    await outbox.drain()
    const posted = performance.now() - t0
    await outbox.retireApplied('m-send' as MutationId)
    const retired = performance.now() - t0
    console.log(
      `POD-4810 sqlite send after ${ROWS}-row sync: enqueued ${enqueued.toFixed(0)} ms, posted ${posted.toFixed(0)} ms, retired ${retired.toFixed(0)} ms`,
    )

    expect(entityReads(db.prepared.slice(preparedBefore))).toEqual([])
    expect(authority.envelopes.map((e) => e.mutationId)).toEqual(['m-send'])
    expect(retired).toBeLessThan(BOUND_MS)

    // Exactly once across a relaunch: the retirement is on disk.
    store.close()
    const { store: reopened } = await openStore(file)
    const again = await openOutbox(reopened, authority)
    await again.drain()
    expect(authority.envelopes.map((e) => e.mutationId)).toEqual(['m-send'])
    expect(again.all()).toEqual([])
    expect(reopened.viewFor(ADA).cache.readEntities()).toHaveLength(ROWS)
    reopened.close()
  }, 120_000)

  it('an offline write survives a relaunch and is sent exactly once afterwards', async () => {
    const { file, cleanup } = freshDatabaseFile()
    cleanups.push(cleanup)
    const { store } = await openStore(file)
    store.viewFor(ADA).cache.installSnapshot(rows('v1'), cursor(1), [])
    const outbox = await openOutbox(store, new ScriptedAuthority(() => ({ kind: 'unreachable' })))
    await outbox.enqueue(layoutSet('m-offline' as MutationId))
    await outbox.drain()
    expect(outbox.pending().map((r) => r.state)).toEqual(['queued'])
    store.close()

    const { store: reopened } = await openStore(file)
    const online = new ScriptedAuthority(() => ({ kind: 'applied' }))
    const again = await openOutbox(reopened, online, RELAUNCHED)
    expect(again.pending().map((r) => r.mutationId)).toEqual(['m-offline'])
    await again.drain()
    await again.drain()
    expect(online.envelopes.map((e) => e.mutationId)).toEqual(['m-offline'])
    reopened.close()
  }, 120_000)

  it('an outbox re-read never hands out an ordinal an open span already took', async () => {
    // FIFO across a relaunch is carried by the ordinal. A re-read that recomputed the
    // next ordinal from durable rows alone would reuse the one an uncommitted span
    // staged, and the tie would reload in key order — here, the wrong order.
    const { file, cleanup } = freshDatabaseFile()
    cleanups.push(cleanup)
    const { store } = await openStore(file)
    const view = store.viewFor(ADA)
    const span = store.beginSpan()
    void view.outbox.apply({ put: [queued('z-first')], expect: [absent('z-first')] }, span)
    await view.outbox.read()
    await view.outbox.apply({ put: [queued('a-second')], expect: [absent('a-second')] })
    span.commit()
    store.close()
    const { store: reopened } = await openStore(file)
    const order = (await reopened.viewFor(ADA).outbox.read()).map((r) => r.mutationId)
    expect(order).toEqual(['z-first', 'a-second'])
    reopened.close()
  })
})
