/**
 * THE ADAPTER'S OWN OBLIGATIONS — the ones neither the conformance suite nor the
 * crash, quota and lifecycle files reach.
 *
 * Each case here pins a property that a plausible-looking adapter can break while
 * every other suite in this directory stays green:
 *
 *  - the in-transaction precondition re-check (ADR 6 D4.6), which only a SECOND
 *    CONNECTION can exercise, because a single connection's mirror already knows;
 *  - "no SQLite at all still yields a working replica" (ADR 6 D1's in-memory adapter
 *    of the same port);
 *  - the JSON round trip, which is what a column actually stores;
 *  - `discardCache()` cannot reach the outbox, carried through to durable rows;
 *  - two principals over one file are disjoint by KEY, not by a filter.
 */

import type { MutationId } from '@podium/model'
import { actorUser, asUserId } from '@podium/model'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { policyBudgets } from '../../conformance/test-budgets'
import type { OutboxRecord } from '../../outbox/records'
import { INSTANCE_META_PREFIX, instanceKey } from '../../replica/cache-state'
import { ReplicaStoreCorruptError } from '../../replica/ports'
import type { Cursor } from '../../replica/types'
import { SyncCommitConflict } from '../../span'
import {
  ENTITY_TABLE,
  INDEX_TABLE,
  META_TABLE,
  REPLICA_SCHEMA_VERSION,
  SCHEMA_VERSION_TABLE,
} from './schema'
import type { SqlDatabaseLike, SqlValue } from './sql'
import { type DurabilityDegradation, SqliteSyncStore } from './store'
import { FaultySqlDatabase, freshDatabaseFile, readDurable, sqliteEngine } from './test-support'

const ADA = asUserId('ada')
const GRACE = asUserId('grace')
const M: MutationId = 'm-1' as MutationId
const CURSOR_1: Cursor = { feedId: 'feed', epoch: 'e1', seq: 1 }

const record = (state: OutboxRecord['state']): OutboxRecord => ({
  mutationId: M,
  command: { name: 'issues.close', version: 1, delivery: 'offline-eligible' },
  input: { entityId: 'ADA-1' },
  partitionKey: 'issue:ADA-1',
  attribution: { actor: actorUser(ADA), onBehalfOf: ADA },
  state,
  queuedAt: 1_700_000_000_000,
  attempts: 0,
})

describe('mobile SQLite adapter — store obligations', () => {
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
      deleteDatabase: () => undefined,
      onDegraded: (degradation) => {
        degradations.push(degradation)
      },
    })

  const SIDEBAR = { collection: 'issueProjection.sidebar', part: 'main' as const }
  const SIDEBAR_KEY = instanceKey(SIDEBAR)

  it.each([
    'not-json',
    '{"seq":1}',
    '{"key":"k","collection":"issueProjection.sidebar","part":"main"}',
    JSON.stringify(CURSOR_1),
  ])('opens a file with an unreadable marker row as holding no marker (%s)', async (marker) => {
    const store = await open()
    await store.unitOfWork.transact(async (span) =>
      store.viewFor(ADA).cache.applyAtomic(
        {
          operations: [
            {
              kind: 'upsert',
              entity: 'sessionUserState',
              entityId: 'personal',
              value: { readAt: 'read' },
              provenance: { seq: 1 },
            },
          ],
          cursor: CURSOR_1,
        },
        span,
      ),
    )
    store.close()
    const db = sqliteEngine.open(file)
    try {
      db.prepare(`INSERT INTO ${META_TABLE} (principal, key, value) VALUES (?, ?, ?)`).run(
        ADA,
        `${INSTANCE_META_PREFIX}broken`,
        marker,
      )
    } finally {
      db.close()
    }
    const reopened = await open()
    const cache = reopened.viewFor(ADA).cache
    expect(cache.readCursor()).toEqual(CURSOR_1)
    expect(cache.read('sessionUserState', 'personal')?.value).toEqual({ readAt: 'read' })
    expect(cache.readInstances().size).toBe(0)
    expect(degradations).toEqual([])
    reopened.close()
  })

  it('stores markers, the policy and the load state durably, and erasing the principal drops them', async () => {
    const store = await open()
    const policy = { clientType: 'phone', steps: [], recentDays: 7, ...policyBudgets() }
    await store.unitOfWork.transact(async (span) =>
      store.viewFor(ADA).cache.applyAtomic(
        {
          operations: [],
          cursor: CURSOR_1,
          instances: [
            { kind: 'mark', instance: { ...SIDEBAR, key: SIDEBAR_KEY, completeAt: CURSOR_1 } },
          ],
          policy,
          loadingSince: 1,
        },
        span,
      ),
    )
    store.close()
    const warm = await open()
    const cache = warm.viewFor(ADA).cache
    expect(cache.readInstances().get(SIDEBAR_KEY)).toEqual({
      ...SIDEBAR,
      key: SIDEBAR_KEY,
      completeAt: CURSOR_1,
    })
    expect(cache.readPolicy()).toEqual(policy)
    expect(cache.readLoadingSince()).toBe(1)
    expect(warm.viewFor(GRACE).cache.readInstances().size).toBe(0)
    await warm.erasePrincipal(ADA)
    warm.close()
    const erased = await open()
    expect(erased.viewFor(ADA).cache.readInstances().size).toBe(0)
    expect(erased.viewFor(ADA).cache.readPolicy()).toBeNull()
    expect(erased.viewFor(ADA).cache.readLoadingSince()).toBeNull()
    expect(erased.viewFor(ADA).cache.readCursor()).toBeNull()
    erased.close()
  })

  it('device reload audit preserves offline writes after an interrupted version-1 migration', async () => {
    const store = await open()
    const queued = record('queued')
    expect(
      await store.viewFor(ADA).outbox.apply({
        put: [queued],
        expect: [{ mutationId: M, expect: 'absent' }],
      }),
    ).toEqual({ ok: true })
    store.close()

    // This is the layout if the process dies after ADD COLUMN part commits,
    // before ADD COLUMN as_of and before the version stamp advances.
    const raw = sqliteEngine.open(file)
    try {
      raw.exec(`ALTER TABLE ${ENTITY_TABLE} DROP COLUMN as_of`)
      raw.exec(`DROP TABLE ${INDEX_TABLE}`)
      raw.prepare(`UPDATE ${SCHEMA_VERSION_TABLE} SET version = 1 WHERE singleton = 1`).run()
    } finally {
      raw.close()
    }

    const reopened = await open()
    try {
      expect(reopened.durability()).toBe('durable')
      expect(await reopened.viewFor(ADA).outbox.read()).toEqual([queued])
      expect(degradations).toEqual([])
    } finally {
      reopened.close()
    }
  })

  it('rolls back schema changes after a refused version stamp and retries with the outbox', async () => {
    const store = await open()
    const queued = record('queued')
    await store.viewFor(ADA).outbox.apply({
      put: [queued],
      expect: [{ mutationId: M, expect: 'absent' }],
    })
    store.close()

    const raw = sqliteEngine.open(file)
    raw.exec(`ALTER TABLE ${ENTITY_TABLE} DROP COLUMN as_of`)
    raw.exec(`DROP TABLE ${INDEX_TABLE}`)
    raw.prepare(`UPDATE ${SCHEMA_VERSION_TABLE} SET version = 1 WHERE singleton = 1`).run()
    const faulty = new FaultySqlDatabase(raw)
    const error = new Error('schema stamp refused')
    faulty.denyWriteAt({ at: 0, error })
    const refused = await SqliteSyncStore.open({
      openDatabase: () => faulty,
      deleteDatabase: () => {
        throw new Error('unexpected file deletion')
      },
      onDegraded: (degradation) => degradations.push(degradation),
    })
    expect(faulty.denials).toBe(1)
    expect(refused.durability()).toBe('unavailable')
    expect(degradations).toEqual([{ mode: 'unavailable', cause: 'unavailable', error }])
    refused.close()

    const checkpoint = sqliteEngine.open(file)
    try {
      expect(checkpoint.prepare(`PRAGMA table_info(${ENTITY_TABLE})`).all()).not.toContainEqual(
        expect.objectContaining({ name: 'as_of' }),
      )
    } finally {
      checkpoint.close()
    }
    const recovered = await open()
    try {
      expect(recovered.durability()).toBe('durable')
      expect(await recovered.viewFor(ADA).outbox.read()).toEqual([queued])
    } finally {
      recovered.close()
    }
  })

  it('migrates a version-1 file in place: rows read whole, the outbox survives', async () => {
    expect(REPLICA_SCHEMA_VERSION).toBe(3)
    const store = await open()
    const view = store.viewFor(ADA)
    await store.unitOfWork.transact(async (span) => {
      view.cache.applyAtomic(
        {
          operations: [
            {
              kind: 'upsert',
              entity: 'issueProjection',
              entityId: 'ADA-1',
              value: { id: 'ADA-1', title: 'old' },
              provenance: { seq: 1 },
            },
          ],
          cursor: CURSOR_1,
        },
        span,
      )
      await view.outbox.apply(
        { put: [record('queued')], expect: [{ mutationId: M, expect: 'absent' }] },
        span,
      )
    })
    store.close()
    // The version-1 layout: no row part, no per-row feed number.
    const raw = sqliteEngine.open(file)
    try {
      raw.exec(`ALTER TABLE ${ENTITY_TABLE} DROP COLUMN part`)
      raw.exec(`ALTER TABLE ${ENTITY_TABLE} DROP COLUMN as_of`)
      raw.prepare(`UPDATE ${SCHEMA_VERSION_TABLE} SET version = 1 WHERE singleton = 1`).run()
    } finally {
      raw.close()
    }
    const migrated = await open()
    try {
      const cache = migrated.viewFor(ADA).cache
      expect(degradations).toEqual([])
      expect(cache.readCursor()).toEqual(CURSOR_1)
      expect(cache.read('issueProjection', 'ADA-1')).toMatchObject({
        value: { id: 'ADA-1', title: 'old' },
      })
      expect(cache.read('issueProjection', 'ADA-1')?.part).toBeUndefined()
      expect(await migrated.viewFor(ADA).outbox.read()).toEqual([record('queued')])
      // The new columns are written from now on.
      await migrated.unitOfWork.transact(async (span) =>
        cache.applyAtomic(
          {
            operations: [
              {
                kind: 'upsert',
                entity: 'issueProjection',
                entityId: 'ADA-2',
                value: { id: 'ADA-2' },
                provenance: { seq: 2 },
                part: 'stub',
                asOf: 2,
              },
            ],
          },
          span,
        ),
      )
    } finally {
      migrated.close()
    }
    const again = await open()
    expect(again.viewFor(ADA).cache.readRow('issueProjection', 'ADA-2')).toMatchObject({
      part: 'stub',
      asOf: 2,
    })
    expect(again.viewFor(ADA).cache.read('issueProjection', 'ADA-2')).toBeUndefined()
    again.close()
  })

  describe('D4.6 — preconditions are re-checked inside the transaction, against durable rows', () => {
    /**
     * D4.6 is written for web's multi-TAB case. The mobile equivalent is a second
     * CONNECTION to the same file — a share extension, a notification-service process,
     * or the app relaunched while the old process is still finishing — and it is the
     * only way to reach this branch, because one connection's mirror already knows
     * what it wrote. A test with a single store can never fail this case, which is
     * exactly why it would be the one nobody writes.
     */
    it('a mutation staged against a stale belief is REFUSED at commit, not applied', async () => {
      const first = await open()
      const firstView = first.viewFor(ADA)
      await firstView.outbox.apply(
        { put: [record('queued')], expect: [{ mutationId: M, expect: 'absent' }] },
        undefined,
      )

      // A second connection, with a mirror of its own, moves the record on.
      const second = await open()
      await second
        .viewFor(ADA)
        .outbox.apply(
          { put: [record('sending')], expect: [{ mutationId: M, expect: 'queued' }] },
          undefined,
        )
      second.close()

      // The first connection still believes `queued` — its mirror says so, so the
      // staging check passes and only the durable re-check can catch this.
      await expect(
        first.unitOfWork.transact(async (span) => {
          const result = await firstView.outbox.apply(
            { remove: [M], expect: [{ mutationId: M, expect: 'queued' }] },
            span,
          )
          expect(result).toEqual({ ok: true })
          firstView.cache.applyAtomic(
            {
              operations: [
                {
                  kind: 'upsert',
                  entity: 'issueProjection',
                  entityId: 'ADA-1',
                  value: { v: 1 },
                  provenance: { seq: 1 },
                },
              ],
              cursor: CURSOR_1,
            },
            span,
          )
        }),
      ).rejects.toBeInstanceOf(SyncCommitConflict)

      // NOTHING was applied — including the ENTITY write in the same span, which is
      // the part a conflict handler that only rolled back the outbox would leave
      // behind. The record is still what the other connection made it.
      const durable = readDurable(file)
      expect(durable.entities).toEqual([])
      expect(durable.cursors).toEqual([])
      expect((durable.outbox[0]?.record as OutboxRecord).state).toBe('sending')
      first.close()
    })

    it('COUNTERFACTUAL — with a belief that is still true, the same commit lands', async () => {
      // Without this, the refusal above is equally consistent with an adapter that
      // refuses every multi-region commit, which would make the whole gate vacuous in
      // the other direction.
      const store = await open()
      const view = store.viewFor(ADA)
      await view.outbox.apply(
        { put: [record('queued')], expect: [{ mutationId: M, expect: 'absent' }] },
        undefined,
      )
      await store.unitOfWork.transact(async (span) => {
        await view.outbox.apply(
          { remove: [M], expect: [{ mutationId: M, expect: 'queued' }] },
          span,
        )
        view.cache.applyAtomic(
          {
            operations: [
              {
                kind: 'upsert',
                entity: 'issueProjection',
                entityId: 'ADA-1',
                value: { v: 1 },
                provenance: { seq: 1 },
              },
            ],
            cursor: CURSOR_1,
          },
          span,
        )
      })
      const durable = readDurable(file)
      expect(durable.entities.map((r) => r.value)).toEqual([{ v: 1 }])
      expect(durable.outbox).toEqual([])
      store.close()
    })
  })

  it('ADR 6 D1 — no usable SQLite at all still yields a working replica, and says it is not durable', async () => {
    const store = await SqliteSyncStore.open({
      openDatabase: () => {
        throw new Error('no SQLite on this platform')
      },
      deleteDatabase: () => {
        throw new Error('and nothing to delete either')
      },
      onDegraded: (degradation) => {
        degradations.push(degradation)
      },
    })

    // SURFACED, never silent — the client can tell the user its offline guarantees
    // are gone rather than discovering it after a relaunch.
    expect(store.durability()).toBe('unavailable')
    expect(degradations).toEqual([
      expect.objectContaining({ mode: 'unavailable', cause: 'unavailable' }),
    ])

    // …and the session still works, in memory. A store that threw here would take the
    // app down on launch, which D4.5 rules out for the corrupt case and which is no
    // more acceptable for the absent one.
    const view = store.viewFor(ADA)
    view.cache.applyAtomic({
      operations: [
        {
          kind: 'upsert',
          entity: 'issueProjection',
          entityId: 'ADA-1',
          value: { v: 3 },
          provenance: { seq: 1 },
        },
      ],
      cursor: CURSOR_1,
    })
    expect(view.cache.read('issueProjection', 'ADA-1')?.value).toEqual({ v: 3 })
    expect(view.cache.readCursor()).toEqual(CURSOR_1)
  })

  it('uses the async SQLite open hook before any synchronous transaction', async () => {
    let syncCalled = false
    const store = await SqliteSyncStore.open({
      openDatabase: () => {
        syncCalled = true
        throw new Error('sync open must not run when async open is supplied')
      },
      openDatabaseAsync: async () => sqliteEngine.open(file),
      deleteDatabase: () => undefined,
      onDegraded: (degradation) => {
        degradations.push(degradation)
      },
    })
    expect(syncCalled).toBe(false)
    expect(store.durability()).toBe('durable')
    store.viewFor(ADA).cache.applyAtomic({
      operations: [
        {
          kind: 'upsert',
          entity: 'issueProjection',
          entityId: 'ADA-1',
          value: { v: 4 },
          provenance: { seq: 4 },
        },
      ],
      cursor: CURSOR_1,
    })
    expect(readDurable(file).entities.map((row) => row.value)).toEqual([{ v: 4 }])
    store.close()
  })

  it('ADR 2 D7 rung 5 — an unreadable store refuses reads with ReplicaStoreCorruptError', async () => {
    const store = await open()
    const view = store.viewFor(ADA)
    view.cache.applyAtomic({
      operations: [
        {
          kind: 'upsert',
          entity: 'issueProjection',
          entityId: 'ADA-1',
          value: { v: 1 },
          provenance: { seq: 1 },
        },
      ],
    })
    // It can say yes first.
    expect(view.cache.read('issueProjection', 'ADA-1')?.value).toEqual({ v: 1 })

    store.setCorrupt(true)
    expect(store.durability()).toBe('unavailable')
    expect(() => view.cache.readEntities()).toThrow(ReplicaStoreCorruptError)
    expect(() => view.cache.readCursor()).toThrow(ReplicaStoreCorruptError)
    await expect(view.outbox.read()).rejects.toBeInstanceOf(ReplicaStoreCorruptError)
    store.close()
  })

  it('values ride through JSON, because that is what the column holds', async () => {
    // The class of bug ADR 6 D4 exists to catch: anything surviving only by object
    // identity fails here the same way it would on device. Asserting the PROJECTION
    // rather than the input is what makes that visible instead of a surprise later.
    const store = await open()
    const view = store.viewFor(ADA)
    view.cache.applyAtomic({
      operations: [
        {
          kind: 'upsert',
          entity: 'issueProjection',
          entityId: 'ADA-1',
          value: { at: new Date('2026-01-01T00:00:00.000Z'), nested: { list: [1, 2] } },
          provenance: { seq: 1 },
        },
      ],
    })
    store.close()

    const relaunched = await open()
    expect(relaunched.viewFor(ADA).cache.read('issueProjection', 'ADA-1')?.value).toEqual({
      at: '2026-01-01T00:00:00.000Z',
      nested: { list: [1, 2] },
    })
    relaunched.close()
  })

  it('discardCache() reaches entities and cursor and CANNOT reach the outbox — durably', async () => {
    const store = await open()
    const view = store.viewFor(ADA)
    await store.unitOfWork.transact(async (span) => {
      await view.outbox.apply(
        { put: [record('queued')], expect: [{ mutationId: M, expect: 'absent' }] },
        span,
      )
      view.cache.applyAtomic(
        {
          operations: [
            {
              kind: 'upsert',
              entity: 'issueProjection',
              entityId: 'ADA-1',
              value: { v: 1 },
              provenance: { seq: 1 },
            },
          ],
          cursor: CURSOR_1,
        },
        span,
      )
    })

    view.cache.discardCache()

    // The user's unsent write survives the cache being thrown away. Under
    // private-by-default a rescope fires whenever anyone's shares change, so this path
    // is reachable by a colleague clicking "share" — losing the queue here is data
    // loss on a normal path, not an exotic one.
    const durable = readDurable(file)
    expect(durable.entities).toEqual([])
    expect(durable.cursors).toEqual([])
    expect(durable.outbox.map((r) => r.mutationId)).toEqual([M])
    store.close()
  })

  it('two principals over one file are disjoint by KEY, and a discard reaches only one', async () => {
    const store = await open()
    for (const [principal, value] of [
      [ADA, { v: 'ada' }],
      [GRACE, { v: 'grace' }],
    ] as const) {
      store.viewFor(principal).cache.applyAtomic({
        operations: [
          {
            kind: 'upsert',
            entity: 'issueProjection',
            entityId: 'SHARED-1',
            value,
            provenance: { seq: 1 },
          },
        ],
        cursor: CURSOR_1,
      })
    }

    // Same entity id, two rows, no interference — which a shared keyspace with a
    // `principal` column would not give: the second write would have replaced the
    // first.
    expect(store.viewFor(ADA).cache.read('issueProjection', 'SHARED-1')?.value).toEqual({
      v: 'ada',
    })
    expect(store.viewFor(GRACE).cache.read('issueProjection', 'SHARED-1')?.value).toEqual({
      v: 'grace',
    })

    store.viewFor(ADA).cache.discardCache()
    const durable = readDurable(file)
    expect(durable.entities).toEqual([
      { principal: GRACE, entity: 'issueProjection', entityId: 'SHARED-1', value: { v: 'grace' } },
    ])
    expect(durable.cursors.map((r) => r.principal)).toEqual([GRACE])
    store.close()
  })

  it('sign-out erases entity, cursor and outbox for only that principal', async () => {
    const store = await open()
    for (const principal of [ADA, GRACE]) {
      const view = store.viewFor(principal)
      await store.unitOfWork.transact(async (span) => {
        await view.outbox.apply(
          { put: [record('queued')], expect: [{ mutationId: M, expect: 'absent' }] },
          span,
        )
        view.cache.applyAtomic(
          {
            operations: [
              {
                kind: 'upsert',
                entity: 'issueProjection',
                entityId: 'SHARED-1',
                value: { owner: principal },
                provenance: { seq: 1 },
              },
            ],
            cursor: CURSOR_1,
          },
          span,
        )
      })
    }

    await store.erasePrincipal(ADA)
    store.close()

    const durable = readDurable(file)
    expect(durable.entities).toEqual([
      {
        principal: GRACE,
        entity: 'issueProjection',
        entityId: 'SHARED-1',
        value: { owner: GRACE },
      },
    ])
    expect(durable.cursors.map((row) => row.principal)).toEqual([GRACE])
    expect(durable.outbox.map((row) => row.principal)).toEqual([GRACE])
  })

  it('POD-7170: a stub-level record has no row, and a file whose stubs live in an unreadable index starts its cache cold, keeping the outbox', async () => {
    const store = await open()
    const cache = store.viewFor(ADA).cache
    await store.unitOfWork.transact(async (span) =>
      cache.applyAtomic(
        {
          operations: [
            {
              kind: 'upsert',
              entity: 'issueProjection',
              entityId: 'S1',
              value: { id: 'S1', stage: 'done' },
              provenance: { seq: 1 },
              part: 'stub',
              asOf: 1,
            },
          ],
          cursor: CURSOR_1,
        },
        span,
      ),
    )
    await store.viewFor(ADA).outbox.apply({
      put: [record('queued')],
      expect: [{ mutationId: M, expect: 'absent' }],
    })
    store.close()
    const raw = sqliteEngine.open(file)
    try {
      expect(raw.prepare(`SELECT COUNT(*) AS n FROM ${ENTITY_TABLE}`).get()).toEqual({ n: 0 })
      raw
        .prepare(`INSERT INTO ${INDEX_TABLE} (principal, key, value) VALUES (?, ?, ?)`)
        .run(ADA, 'unreadable', '42')
    } finally {
      raw.close()
    }
    const reopened = await open()
    try {
      const view = reopened.viewFor(ADA)
      expect(view.cache.readCursor()).toBeNull()
      expect(view.cache.readStubs()).toEqual([])
      expect((await view.outbox.read()).map((row) => row.mutationId)).toEqual([M])
    } finally {
      reopened.close()
    }
  })
})

/**
 * POD-2666: expo-sqlite on iOS binds a text parameter as a C string, so it ends at
 * the first NUL. Marker rows are keyed `instance\u0000<key>`; on a phone every
 * marker landed on the one key `instance`, overwrote the last, and a relaunch read
 * no marker at all while the device still held the rows and loaded nothing. These
 * cases run the real engine behind a wrapper that truncates bound strings the
 * same way.
 */
describe('mobile SQLite adapter — a driver that ends bound strings at NUL', () => {
  let file: string
  let cleanup: () => void

  beforeEach(() => {
    const fresh = freshDatabaseFile()
    file = fresh.file
    cleanup = fresh.cleanup
  })

  afterEach(() => {
    cleanup()
  })

  const truncate = (value: SqlValue): SqlValue =>
    typeof value === 'string' && value.includes('\u0000')
      ? value.slice(0, value.indexOf('\u0000'))
      : value
  const nulTruncating = (db: SqlDatabaseLike): SqlDatabaseLike => ({
    prepare(sql) {
      const statement = db.prepare(sql)
      return {
        run: (...params) => statement.run(...params.map(truncate)),
        get: (...params) => statement.get(...params.map(truncate)),
        all: (...params) => statement.all(...params.map(truncate)),
      }
    },
    exec: (sql) => db.exec(sql),
    close: () => db.close(),
  })
  const open = async (): Promise<SqliteSyncStore> =>
    await SqliteSyncStore.open({
      openDatabase: () => nulTruncating(sqliteEngine.open(file)),
      deleteDatabase: () => undefined,
      onDegraded: () => undefined,
    })

  const SIDEBAR = { collection: 'issueProjection.sidebar', part: 'main' as const }
  const STUBS = { collection: 'issueProjection.stubs', part: 'stub' as const }
  const policy = { clientType: 'phone', steps: [], recentDays: 7, ...policyBudgets() }

  it('keeps every marker across a relaunch', async () => {
    const store = await open()
    await store.unitOfWork.transact(async (span) =>
      store.viewFor(ADA).cache.applyAtomic(
        {
          operations: [],
          cursor: CURSOR_1,
          instances: [
            {
              kind: 'mark',
              instance: { ...SIDEBAR, key: instanceKey(SIDEBAR), completeAt: CURSOR_1 },
            },
            { kind: 'mark', instance: { ...STUBS, key: instanceKey(STUBS), completeAt: CURSOR_1 } },
          ],
          policy,
        },
        span,
      ),
    )
    store.close()
    const warm = await open()
    try {
      expect([...warm.viewFor(ADA).cache.readInstances().keys()].sort()).toEqual(
        [instanceKey(SIDEBAR), instanceKey(STUBS)].sort(),
      )
      expect(warm.viewFor(ADA).cache.readLoadingSince()).toBeNull()
    } finally {
      warm.close()
    }
  })

  it('resumes the load on a device whose markers collapsed into one truncated row', async () => {
    const store = await open()
    await store.unitOfWork.transact(async (span) =>
      store.viewFor(ADA).cache.applyAtomic({ operations: [], cursor: CURSOR_1, policy }, span),
    )
    store.close()
    // What builds before the fix left behind: the marker prefix cut at its NUL.
    const raw = sqliteEngine.open(file)
    try {
      raw
        .prepare(`INSERT INTO ${META_TABLE} (principal, key, value) VALUES (?, ?, ?)`)
        .run(
          ADA,
          'instance',
          JSON.stringify({ ...SIDEBAR, key: instanceKey(SIDEBAR), completeAt: CURSOR_1 }),
        )
    } finally {
      raw.close()
    }
    const warm = await open()
    try {
      // No marker is trusted, and the load restarts at its first missing
      // collection; 0 sweeps nothing the device still holds.
      expect(warm.viewFor(ADA).cache.readInstances().size).toBe(0)
      expect(warm.viewFor(ADA).cache.readLoadingSince()).toBe(0)
      expect(warm.viewFor(ADA).cache.readCursor()).toEqual(CURSOR_1)
    } finally {
      warm.close()
    }
    const durable = sqliteEngine.open(file)
    try {
      expect(
        durable
          .prepare(`SELECT COUNT(*) AS n FROM ${META_TABLE} WHERE principal = ? AND key = ?`)
          .get(ADA, 'instance'),
      ).toEqual({ n: 0 })
    } finally {
      durable.close()
    }
  })
})
