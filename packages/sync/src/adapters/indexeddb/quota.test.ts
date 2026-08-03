/**
 * QUOTA-FULL (ADR 6 D4.4), against a denial the storage engine actually issues.
 *
 * D4.4 has five clauses and this file asserts each one separately, because they
 * fail independently and an adapter can satisfy any four while breaking the fifth:
 *
 *   1. the failing operation does not partially apply
 *   2. durability flips to `degraded-memory` for the remainder of the session
 *   3. the UI is EXPLICITLY informed
 *   4. the adapter MUST NOT fall back to localStorage for the replica payload
 *   5. next cold start hydrates from durable storage if it is usable again
 *
 * ─── WHY THE DENIAL IS INJECTED WHERE IT IS ──────────────────────────────────
 *
 * At request index 1 of a live transaction whose index 0 has ALREADY BEEN ISSUED
 * to the engine. A denial injected before the transaction opens would make clause
 * 1 vacuous — nothing was applied because nothing was attempted — and that is the
 * "quota test that never reaches the quota" the brief names. Here the first write
 * really is in flight, and it is IndexedDB's own abort that takes it back out;
 * clause 1 is therefore an observation about the engine, not about the injector.
 *
 * The counterpart lives in `conformance.ts`: the suite's `setWritesDenied` refuses
 * at the PORT, before staging, which is the semantics `suite.ts` asserts (surface
 * the denial, change nothing, succeed again once space is freed). Two injectors,
 * two instants, two different claims — the split `instantiation.ts` already draws
 * between `setWritesDenied` and `failNextCommit`.
 */

import { actorUser, asUserId } from '@podium/model'
import type { MutationId } from '@podium/protocol'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { OutboxRecord } from '../../outbox/records'
import type { Cursor } from '../../replica/types'
import type { IdbFactoryLike } from './idb'
import { CURSOR_KEY, ENTITY_STORE, META_STORE, OUTBOX_STORE, REPLICA_DB_NAME } from './schema'
import { type DurabilityDegradation, IndexedDbSyncStore } from './store'
import { FaultyIdbFactory, freshFactory, QuotaExceededDomError, readDurable } from './test-support'

const PRINCIPAL = asUserId('ada')
const M1: MutationId = 'm-1' as MutationId
const M2: MutationId = 'm-2' as MutationId
const CURSOR_1: Cursor = { feedId: 'feed', epoch: 'e1', seq: 1 }
const CURSOR_2: Cursor = { feedId: 'feed', epoch: 'e1', seq: 2 }

const record = (mutationId: MutationId): OutboxRecord => ({
  mutationId,
  command: { name: 'issues.close', version: 1, delivery: 'offline-eligible' },
  input: { entityId: 'ADA-1' },
  partitionKey: 'issue:ADA-1',
  attribution: { actor: actorUser(PRINCIPAL), onBehalfOf: PRINCIPAL },
  state: 'queued',
  queuedAt: 1_700_000_000_000,
  attempts: 0,
})

describe('IndexedDB adapter — quota-full (ADR 6 D4.4)', () => {
  let factory: FaultyIdbFactory
  let degradations: DurabilityDegradation[]

  beforeEach(() => {
    factory = new FaultyIdbFactory(freshFactory())
    degradations = []
  })

  const open = async (): Promise<IndexedDbSyncStore> =>
    await IndexedDbSyncStore.open({
      factory: factory as IdbFactoryLike,
      databaseName: REPLICA_DB_NAME,
      onDegraded: (degradation) => {
        degradations.push(degradation)
      },
    })

  /** A two-region commit: one outbox put, then one entity upsert plus the cursor. */
  const commit = async (store: IndexedDbSyncStore, id: MutationId, cursor: Cursor, v: number) => {
    const view = store.viewFor(PRINCIPAL)
    await store.unitOfWork.transact(async (span) => {
      await view.outbox.apply(
        { put: [record(id)], expect: [{ mutationId: id, expect: 'absent' }] },
        span,
      )
      view.cache.applyAtomic(
        {
          operations: [
            {
              kind: 'upsert',
              entity: 'issue',
              entityId: 'ADA-1',
              value: { v },
              provenance: { seq: cursor.seq },
            },
          ],
          cursor,
        },
        span,
      )
    })
  }

  const durableRows = async () => {
    const rows = await readDurable(factory as IdbFactoryLike)
    return {
      entities: (rows[ENTITY_STORE] as { value: unknown }[]).map((r) => r.value),
      cursor: (rows[META_STORE] as { key: string; value: Cursor }[]).find(
        (r) => r.key === CURSOR_KEY,
      )?.value,
      outbox: (rows[OUTBOX_STORE] as { mutationId: string }[]).map((r) => r.mutationId),
    }
  }

  it('POSITIVE CONTROL — with quota available the same commit lands in all regions', async () => {
    const store = await open()
    await commit(store, M1, CURSOR_1, 0)
    await store.settled()
    expect(await durableRows()).toEqual({
      entities: [{ v: 0 }],
      cursor: CURSOR_1,
      outbox: [M1],
    })
    expect(degradations).toEqual([])
    expect(store.durability()).toBe('durable')
    store.close()
  })

  it('D4.4.1 — a denial mid-transaction does not partially apply, in any region', async () => {
    const store = await open()
    await commit(store, M1, CURSOR_1, 0)
    await store.settled()
    const before = await durableRows()

    // The denial lands at request 1, so request 0 of the SAME transaction has
    // already been issued to the engine and accepted.
    const issuedBefore = factory.writesIssued
    factory.denyWriteAt({ at: 1 })
    await expect(commit(store, M2, CURSOR_2, 1)).rejects.toThrow(/quota/i)

    // The transaction really did get a write in before the denial — otherwise the
    // clause below is about a transaction that never touched the store.
    expect(factory.writesIssued - issuedBefore).toBeGreaterThanOrEqual(2)
    expect(factory.denials).toBe(1)

    // Byte-identical: the earlier commit intact, the denied one absent everywhere.
    expect(await durableRows()).toEqual(before)
    store.close()
  })

  it('D4.4.2/3 — durability flips to degraded-memory for the session, and says so ONCE', async () => {
    const store = await open()
    factory.denyWriteAt({ at: 0 })
    await expect(commit(store, M1, CURSOR_1, 0)).rejects.toThrow(/quota/i)

    expect(store.durability()).toBe('degraded-memory')
    expect(degradations).toHaveLength(1)
    expect(degradations[0]).toMatchObject({ mode: 'degraded-memory', cause: 'quota' })
    expect((degradations[0] as DurabilityDegradation).error).toBeInstanceOf(QuotaExceededDomError)

    // STICKY, and reported once. A second failure must not re-announce a state the
    // UI is already showing, and must not silently return to claiming durability.
    const afterFirst = factory.writesIssued
    await commit(store, M2, CURSOR_2, 1)
    expect(store.durability()).toBe('degraded-memory')
    expect(degradations).toHaveLength(1)

    // The session CONTINUES: the write applied in memory and reached IndexedDB not
    // at all. That is what `degraded-memory` means — not "every write now throws".
    const view = store.viewFor(PRINCIPAL)
    expect(view.cache.read('issue', 'ADA-1')?.value).toEqual({ v: 1 })
    expect((await view.outbox.read()).map((r) => r.mutationId)).toEqual([M2])
    expect(factory.writesIssued).toBe(afterFirst)
    store.close()
  })

  it('D4.4.5 — the next cold start finds exactly what committed before the quota hit', async () => {
    const store = await open()
    await commit(store, M1, CURSOR_1, 0)
    await store.settled()
    factory.denyWriteAt({ at: 0 })
    await expect(commit(store, M2, CURSOR_2, 1)).rejects.toThrow(/quota/i)
    // Work done while degraded lives in memory only, by design.
    await commit(store, M2, CURSOR_2, 1)
    store.close()

    // The device is restarted with space free again. Durable storage is usable, so
    // the client hydrates from it — and finds the pre-quota state, not the degraded
    // session's memory. "Reload may cold-start" is exactly this.
    factory.denyWriteAt(undefined)
    const reopened = await open()
    const view = reopened.viewFor(PRINCIPAL)
    expect(reopened.durability()).toBe('durable')
    expect(view.cache.read('issue', 'ADA-1')?.value).toEqual({ v: 0 })
    expect(view.cache.readCursor()).toEqual(CURSOR_1)
    expect((await view.outbox.read()).map((r) => r.mutationId)).toEqual([M1])
    reopened.close()
  })

  describe('D4.4.4 — degraded mode is in-memory ONLY, never localStorage', () => {
    let touched: string[]

    beforeEach(() => {
      touched = []
      // A recording stand-in on the global the adapter would have to reach for.
      // `Reflect.get` on ANY key is recorded, so `setItem`, `getItem` and a bare
      // property read all count — a spy that only watched `setItem` would miss an
      // adapter that read the key to decide whether to write it.
      Object.defineProperty(globalThis, 'localStorage', {
        configurable: true,
        value: new Proxy(
          {},
          {
            get: (_target, key) => {
              touched.push(String(key))
              return () => undefined
            },
            set: (_target, key) => {
              touched.push(String(key))
              return true
            },
          },
        ),
      })
    })

    afterEach(() => {
      Reflect.deleteProperty(globalThis, 'localStorage')
    })

    it('the spy CAN say yes — it records a touch when something actually reaches it', () => {
      // The positive control this whole case rests on. An absence reported by an
      // instrument that cannot report a presence is not evidence.
      ;(
        globalThis as { localStorage?: { setItem: (k: string, v: string) => void } }
      ).localStorage?.setItem('podium.probe', 'x')
      expect(touched).toContain('setItem')
    })

    it('a whole degraded session never touches it', async () => {
      const store = await open()
      factory.denyWriteAt({ at: 0 })
      await expect(commit(store, M1, CURSOR_1, 0)).rejects.toThrow(/quota/i)
      expect(store.durability()).toBe('degraded-memory')

      // Everything a client does after the denial: more writes, reads, a discard.
      await commit(store, M2, CURSOR_2, 1)
      const view = store.viewFor(PRINCIPAL)
      view.cache.readEntities()
      await view.outbox.read()
      view.cache.discardCache()
      await store.settled()
      store.close()

      expect(touched).toEqual([])
    })
  })
})
