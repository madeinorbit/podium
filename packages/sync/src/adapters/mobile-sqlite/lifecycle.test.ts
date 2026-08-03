/**
 * MOBILE LIFECYCLE (ADR 6 D4.7) — backgrounding, process death, cold-start-offline.
 *
 * D4.7 in full: "Backgrounding, process death, and cold-start-offline must preserve
 * D4.1–D4.5. SQLite transactions commit before the adapter resolves the kernel write.
 * 'Best-effort flush on `AppState` change' is insufficient as the sole durability
 * mechanism."
 *
 * ─── THE FAILURE THIS FILE IS AIMED AT ───────────────────────────────────────
 *
 * The thing being replaced is `client-core/src/replica/async-storage.ts`, whose own
 * header records the defect ADR 6 cites: it is WRITE-BEHIND, so "a crash between the
 * sync cache write and the flush loses the queue tail". A write-behind adapter passes
 * every test that flushes before asserting. It fails only when nothing gets to run
 * between the write and the kill — which on iOS and Android is the normal case, not
 * the exotic one, because the OS reclaims a backgrounded process without warning.
 *
 * So the cases below are built so that NOTHING RUNS between the kernel write and the
 * kill: no `settled()`, no flush, no AppState hook, no `close()` on the paths where a
 * real process would not get one. What survives is what the write itself committed.
 *
 * ─── AND THE ABSENCE THAT IS THE MECHANISM ───────────────────────────────────
 *
 * "There is no flush hook" is a claim about a shape, and a memory-only assertion of
 * it would be a no-op guard one edit from data loss. It is asserted two ways here:
 * behaviourally (a kill with nothing in between still finds the data) and
 * structurally (the store's prototype exposes no lifecycle method), with the
 * structural probe carrying a positive control so it cannot pass by finding nothing.
 */

import type { MutationId } from '@podium/model'
import { actorUser, asUserId } from '@podium/model'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { OutboxRecord } from '../../outbox/records'
import type { Cursor } from '../../replica/types'
import { REPLICA_SCHEMA_VERSION, SCHEMA_VERSION_TABLE } from './schema'
import { type DurabilityDegradation, SqliteSyncStore } from './store'
import { freshDatabaseFile, readDurable, sqliteEngine } from './test-support'

const PRINCIPAL = asUserId('ada')
const M1: MutationId = 'm-1' as MutationId
const M2: MutationId = 'm-2' as MutationId
const CURSOR_1: Cursor = { feedId: 'feed', epoch: 'e1', seq: 1 }

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

describe('mobile SQLite adapter — lifecycle (ADR 6 D4.7)', () => {
  let file: string
  let cleanup: () => void
  let degradations: DurabilityDegradation[]

  beforeEach(() => {
    const fresh = freshDatabaseFile()
    file = fresh.file
    cleanup = fresh.cleanup
    degradations = []
  })

  afterEach(() => {
    cleanup()
  })

  const open = async (): Promise<SqliteSyncStore> =>
    await SqliteSyncStore.open({
      openDatabase: () => sqliteEngine.open(file),
      deleteDatabase: () => {
        const { rmSync } = require('node:fs') as typeof import('node:fs')
        rmSync(file, { force: true })
      },
      onDegraded: (degradation) => {
        degradations.push(degradation)
      },
    })

  describe('backgrounding is not a durability event', () => {
    it('a kernel write is durable the instant it returns — no flush, no close, no settle', async () => {
      const store = await open()
      const view = store.viewFor(PRINCIPAL)

      await store.unitOfWork.transact(async (span) => {
        await view.outbox.apply(
          { put: [record(M1)], expect: [{ mutationId: M1, expect: 'absent' }] },
          span,
        )
        view.cache.applyAtomic(
          {
            operations: [
              {
                kind: 'upsert',
                entity: 'issue',
                entityId: 'ADA-1',
                value: { v: 0 },
                provenance: { seq: 1 },
              },
            ],
            cursor: CURSOR_1,
          },
          span,
        )
      })

      // THE ASSERTION, taken with the store object still alive and NOTHING having run
      // since `transact` resolved. A write-behind adapter — the shape ADR 6 D4.7 rules
      // out and `async-storage.ts` actually is — fails right here, because its flush
      // has not happened yet. Read through a connection of its own, so the mirror
      // cannot answer.
      const durable = readDurable(file)
      expect(durable.entities.map((r) => r.value)).toEqual([{ v: 0 }])
      expect(durable.cursors.map((r) => r.cursor)).toEqual([CURSOR_1])
      expect(durable.outbox.map((r) => r.mutationId)).toEqual([M1])

      store.close()
    })

    it('the same holds for a lone single-region write, which is the one a `void` port method returns from', async () => {
      // The path POD-374 could not make wait: `applyAtomic` returns `void`, so on
      // IndexedDB the mirror publishes before the commit resolves. Here the commit has
      // already happened by the time the call returns, and this is what says so.
      const store = await open()
      store.viewFor(PRINCIPAL).cache.applyAtomic({
        operations: [
          {
            kind: 'upsert',
            entity: 'issue',
            entityId: 'ADA-2',
            value: { v: 9 },
            provenance: { seq: 4 },
          },
        ],
      })
      expect(readDurable(file).entities.map((r) => r.value)).toEqual([{ v: 9 }])
      store.close()
    })

    it('there is NO lifecycle or flush hook to forget to call — asserted on the shape, with a control', () => {
      // Protecting by ABSENCE rather than by a no-op method: a no-op `flush()` would
      // satisfy every caller and is one edit away from being a real write-behind
      // buffer. Nothing to call means nothing to forget.
      const surface = [
        ...Object.getOwnPropertyNames(SqliteSyncStore.prototype),
        ...Object.getOwnPropertyNames(SqliteSyncStore),
      ]
      const lifecycleShaped = surface.filter((name) =>
        /flush|appstate|background|foreground|pause|resume|persist|drain|sync$/i.test(name),
      )
      expect(lifecycleShaped).toEqual([])

      // THE POSITIVE CONTROL: the probe is looking at a real surface and can say yes.
      // Without this, an `SqliteSyncStore` that failed to import — or a prototype the
      // probe read as empty — would report the same clean result.
      expect(surface).toContain('close')
      expect(surface).toContain('durability')
      expect(surface).toContain('open')
      expect(/flush|persist/i.test('flushPendingWrites')).toBe(true)
    })

    it('`settled()` is not a flush — the data is already durable before it is called', async () => {
      // `settled()` exists so a caller written against `IndexedDbSyncStore` still
      // compiles and behaves. If it were load-bearing, the case above (which never
      // calls it) would fail; this one pins the other direction, that calling it
      // changes nothing.
      const store = await open()
      store.viewFor(PRINCIPAL).cache.applyAtomic({
        operations: [
          {
            kind: 'upsert',
            entity: 'issue',
            entityId: 'ADA-3',
            value: { v: 1 },
            provenance: { seq: 1 },
          },
        ],
      })
      const before = readDurable(file)
      await store.settled()
      expect(readDurable(file)).toEqual(before)
      store.close()
    })
  })

  describe('cold start, offline', () => {
    /**
     * A cold start is the mobile NORMAL case: the OS reclaimed the process while the
     * user was elsewhere, and the app comes back with no network yet. Nothing in these
     * cases wires an authority, a submit port or a socket — if the adapter needed one
     * to produce a replica, that would be the bug.
     */
    it('a relaunch with no network at all recovers entities, cursor and the outbox queue', async () => {
      const first = await open()
      const view = first.viewFor(PRINCIPAL)
      await first.unitOfWork.transact(async (span) => {
        await view.outbox.apply(
          { put: [record(M1)], expect: [{ mutationId: M1, expect: 'absent' }] },
          span,
        )
        view.cache.applyAtomic(
          {
            operations: [
              {
                kind: 'upsert',
                entity: 'issue',
                entityId: 'ADA-1',
                value: { v: 7 },
                provenance: { seq: 1 },
              },
            ],
            cursor: CURSOR_1,
          },
          span,
        )
      })
      // The process is gone. Not closed politely — just gone; `close()` here only
      // releases this test's file handle.
      first.close()

      const relaunched = await open()
      const cold = relaunched.viewFor(PRINCIPAL)
      expect(relaunched.durability()).toBe('durable')
      expect(cold.cache.read('issue', 'ADA-1')?.value).toEqual({ v: 7 })
      expect(cold.cache.readCursor()).toEqual(CURSOR_1)
      expect((await cold.outbox.read()).map((r) => r.mutationId)).toEqual([M1])
      relaunched.close()
    })

    it('the outbox comes back in FIFO order, not primary-key order (ADR 3 D12)', async () => {
      // The bug this catches is invisible in memory and appears on every cold start,
      // which on mobile is constantly. `m-2` is enqueued FIRST, so an adapter that
      // hydrated in `mutation_id` order would return `m-1` first and read as correct
      // to every in-session assertion.
      const first = await open()
      const view = first.viewFor(PRINCIPAL)
      await view.outbox.apply(
        { put: [record(M2)], expect: [{ mutationId: M2, expect: 'absent' }] },
        undefined,
      )
      await view.outbox.apply(
        { put: [record(M1)], expect: [{ mutationId: M1, expect: 'absent' }] },
        undefined,
      )
      expect((await view.outbox.read()).map((r) => r.mutationId)).toEqual([M2, M1])
      first.close()

      const relaunched = await open()
      expect((await relaunched.viewFor(PRINCIPAL).outbox.read()).map((r) => r.mutationId)).toEqual([
        M2,
        M1,
      ])
      // The counterfactual: primary-key order would have been the OTHER one, so this
      // case distinguishes the two rather than asserting an order that happens to
      // match both.
      expect([M2, M1]).not.toEqual([...[M2, M1]].sort())
      relaunched.close()
    })

    it('a first launch on a device with no database file yields a working, durable, empty replica', async () => {
      // "Never wedges boot" starts here: the commonest cold start of all is the one
      // where there is nothing to read.
      const store = await open()
      const view = store.viewFor(PRINCIPAL)
      expect(store.durability()).toBe('durable')
      expect(view.cache.readEntities()).toEqual([])
      expect(view.cache.readCursor()).toBeNull()
      expect(await view.outbox.read()).toEqual([])
      expect(degradations).toEqual([])

      // …and it is genuinely usable, not merely non-throwing.
      view.cache.applyAtomic({
        operations: [
          {
            kind: 'upsert',
            entity: 'issue',
            entityId: 'ADA-1',
            value: { v: 1 },
            provenance: { seq: 1 },
          },
        ],
      })
      expect(readDurable(file).entities.map((r) => r.value)).toEqual([{ v: 1 }])
      store.close()
    })

    it('D4.5 — a corrupt database file clears and cold-starts rather than wedging the launch', async () => {
      const { writeFileSync } = await import('node:fs')
      writeFileSync(file, 'this is not a SQLite database, it is a truncated download')

      const store = await open()
      // Boot completed. On a phone this is the difference between a re-bootstrap and
      // an app the user can only fix by deleting it.
      expect(store.durability()).toBe('durable')
      expect(store.viewFor(PRINCIPAL).cache.readEntities()).toEqual([])
      // LOUD, not silent: the outbox went with it, and that is the one case where user
      // work is lost (ADR 2 D7).
      expect(degradations).toHaveLength(1)
      expect(degradations[0]).toMatchObject({ mode: 'degraded-memory', cause: 'corrupt' })

      // And the cleared store is usable — a clear that left an unwritable file would
      // satisfy every assertion above and fail the user on the next write.
      store.viewFor(PRINCIPAL).cache.applyAtomic({
        operations: [
          {
            kind: 'upsert',
            entity: 'issue',
            entityId: 'ADA-1',
            value: { v: 2 },
            provenance: { seq: 1 },
          },
        ],
      })
      expect(readDurable(file).entities.map((r) => r.value)).toEqual([{ v: 2 }])
      store.close()
    })

    it('D5.1 — a file written by a NEWER build is forward-only: cleared and cold-started, never misread', async () => {
      // The upgrade-or-rebootstrap posture (D6). The dangerous alternative is reading
      // a layout this build does not understand, which produces a replica that is
      // wrong rather than empty.
      const seeded = await open()
      seeded.viewFor(PRINCIPAL).cache.applyAtomic({
        operations: [
          {
            kind: 'upsert',
            entity: 'issue',
            entityId: 'ADA-1',
            value: { v: 'from the future' },
            provenance: { seq: 1 },
          },
        ],
        cursor: CURSOR_1,
      })
      seeded.close()

      const raw = sqliteEngine.open(file)
      raw
        .prepare(`UPDATE ${SCHEMA_VERSION_TABLE} SET version = ? WHERE singleton = 1`)
        .run(REPLICA_SCHEMA_VERSION + 1)
      raw.close()

      const store = await open()
      expect(store.durability()).toBe('durable')
      expect(store.viewFor(PRINCIPAL).cache.readEntities()).toEqual([])
      expect(store.viewFor(PRINCIPAL).cache.readCursor()).toBeNull()
      expect(degradations).toHaveLength(1)
      expect(degradations[0]).toMatchObject({ cause: 'corrupt' })
      store.close()

      // COUNTERFACTUAL, and the reason this case is not vacuous: at the CURRENT
      // version the very same file is read back rather than cleared. Without this,
      // "cleared" would be equally consistent with an adapter that clears every time.
      const again = await open()
      again.viewFor(PRINCIPAL).cache.applyAtomic({
        operations: [
          {
            kind: 'upsert',
            entity: 'issue',
            entityId: 'ADA-1',
            value: { v: 'current' },
            provenance: { seq: 1 },
          },
        ],
      })
      again.close()
      const third = await open()
      expect(third.viewFor(PRINCIPAL).cache.read('issue', 'ADA-1')?.value).toEqual({
        v: 'current',
      })
      third.close()
    })
  })
})
