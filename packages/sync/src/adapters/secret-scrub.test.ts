/**
 * THE CLIENT SCRUB, AGAINST BOTH REAL ENGINES (POD-419, 3.7b).
 *
 * The claim is "zero secret material on any client, including historical rows".
 * Everything about how that claim can be false is a fixture question, so the
 * traps are named and each one has a case:
 *
 *  1. AN EMPTY-HISTORY FIXTURE PASSES VACUOUSLY. A store with no pre-existing
 *     rows is scrubbed correctly by a scrub that does nothing. Every case here
 *     seeds material BEFORE the adapter ever opens the store — through the
 *     engine directly, the way an earlier build left it on disk — and asserts on
 *     the addresses the pass reports removing.
 *  2. "HISTORICAL" IS NOT "CURRENT". The outbox retains terminal and
 *     dead-lettered entries whose `input` is kept verbatim, and those are the
 *     rows a scrub written against the live queue walks past. The fixture seeds
 *     a dead-lettered, an applied-terminal and a live entry, each with DISTINCT
 *     material, and identifies survivors BY VALUE.
 *  3. READING BACK THROUGH THE WRITER PROVES NOTHING (POD-374). Every assertion
 *     goes through `readDurable` — a connection of its own — never through the
 *     store object that performed the scrub. A mirror scrubbed ahead of its
 *     durable write would satisfy any assertion made through the adapter.
 *  5. STATED LIMIT, so the fixture does not imply more than it proves: the walk
 *     treats a `Map`, `Set` or TypedArray as an OPAQUE LEAF and does not descend
 *     into it. That is deliberate — rebuilding a container this module does not
 *     understand is how a scrub corrupts the rows it was sent to protect — and it
 *     is sound here because no replica row nests a settings blob inside one. If a
 *     future writer does, the scrub will not reach it.
 *  4. A SCRUB THAT DESTROYS DATA REPORTS A CLEAN STORE, TRUTHFULLY. This is the
 *     defect the scrub's own unit test found: a `Date` satisfies a naive
 *     plain-object check, so a rebuilding walker turns structured-clone values
 *     into `{}` while every "is the secret gone" assertion passes. No test of
 *     the removal can catch it — only a test of what SURVIVED. So each engine
 *     seeds rows carrying a Date, nested arrays and unicode, and asserts they
 *     come back byte-identical.
 */

import { actorUser, asUserId, SETTINGS_SECRET_PATHS } from '@podium/model'
import type { MutationId } from '@podium/protocol'
import { afterEach, describe, expect, it } from 'vitest'
import type { OutboxRecord } from '../outbox/records'
import type { IdbDatabaseLike, IdbFactoryLike } from './indexeddb/idb'
import {
  ALL_STORES,
  ENTITY_STORE,
  META_STORE,
  OUTBOX_STORE,
  REPLICA_DB_NAME,
  REPLICA_SCHEMA_VERSION,
  upgradeSchema,
} from './indexeddb/schema'
import { IndexedDbSyncStore } from './indexeddb/store'
import { freshFactory, readDurable as readDurableIdb } from './indexeddb/test-support'
import {
  applySchema,
  CURSOR_KEY,
  ENTITY_TABLE,
  META_TABLE,
  OUTBOX_TABLE,
} from './mobile-sqlite/schema'
import { SqliteSyncStore } from './mobile-sqlite/store'
import {
  freshDatabaseFile,
  readDurable as readDurableSqlite,
  sqliteEngine,
} from './mobile-sqlite/test-support'
import type { SecretScrubReport } from './secret-scrub'

const ADA = asUserId('ada')

/** DISTINCT per row and per region. A fixture that reused one value could not
 *  tell "removed all five" from "removed one and the others were never there",
 *  and could not tell WHICH row survived a partial scrub. */
const SECRET = {
  entity: 'sk-ENTITY-row-material',
  cursor: 'sk-CURSOR-row-material',
  live: 'sk-OUTBOX-live-material',
  applied: 'sk-OUTBOX-applied-material',
  deadLettered: 'sk-OUTBOX-deadlettered-material',
} as const

const ALL_SECRETS = Object.values(SECRET)

/**
 * The survivor fixture: everything a scrub must NOT touch, including the values
 * that a rebuilding walker silently destroys. `Date` is the one that actually
 * bit — IndexedDB stores it through structured clone, and `{...date}` is `{}`.
 */
const SURVIVORS = {
  telegramChatId: '-1001234567890',
  experimental: { 'feature.flag': true },
  nested: [1, [2, [3]], { deep: 'value' }],
  unicode: 'héllo — ünicode ✓',
} as const

/** A settings-shaped payload carrying ONE secret plus every survivor. */
const payloadWith = (secret: string): Record<string, unknown> => ({
  apiKeys: { openai: secret },
  notifications: { telegramChatId: SURVIVORS.telegramChatId },
  experimental: SURVIVORS.experimental,
  nested: SURVIVORS.nested,
  unicode: SURVIVORS.unicode,
})

const outboxRecord = (
  mutationId: string,
  state: OutboxRecord['state'],
  secret: string,
): OutboxRecord => ({
  mutationId: mutationId as MutationId,
  command: { name: 'settings.set', version: 1, delivery: 'offline-eligible' },
  // The author's intent, verbatim — which is exactly why a secret can be here.
  input: { settings: payloadWith(secret) },
  partitionKey: 'settings',
  attribution: { actor: actorUser(ADA), onBehalfOf: ADA },
  state,
  queuedAt: 1_700_000_000_000,
  attempts: 0,
})

/** Assert the two-sided contract: the material is gone AND the survivors are
 *  intact. Only the second half can catch a rebuilding walker. */
function expectScrubbedButIntact(serialized: string, payload: Record<string, unknown>): void {
  for (const secret of ALL_SECRETS) expect(serialized).not.toContain(secret)
  expect(payload.apiKeys).toEqual({})
  expect(payload.notifications).toEqual({ telegramChatId: SURVIVORS.telegramChatId })
  expect(payload.experimental).toEqual(SURVIVORS.experimental)
  expect(payload.nested).toEqual(SURVIVORS.nested)
  expect(payload.unicode).toBe(SURVIVORS.unicode)
}

describe('the classification this scrub consumes is not empty', () => {
  it('names at least one secret path — an empty list scrubs nothing and passes everything', () => {
    expect(SETTINGS_SECRET_PATHS.length).toBeGreaterThan(0)
    expect(SETTINGS_SECRET_PATHS).toContain('apiKeys.openai')
  })
})

// ───────────────────────────── IndexedDB (web) ─────────────────────────────

/** Seed rows the way an EARLIER BUILD left them: straight into the engine, with
 *  no adapter involved, so the store meets them for the first time at `open`. */
async function seedIdb(factory: IdbFactoryLike): Promise<void> {
  const db = await new Promise<IdbDatabaseLike>((resolve, reject) => {
    const request = factory.open(REPLICA_DB_NAME, REPLICA_SCHEMA_VERSION)
    request.onupgradeneeded = () => {
      upgradeSchema(request.result)
    }
    request.onsuccess = () => {
      resolve(request.result)
    }
    request.onerror = () => {
      reject(request.error ?? new Error('open failed'))
    }
  })
  const tx = db.transaction([...ALL_STORES], 'readwrite')
  tx.objectStore(ENTITY_STORE).put({
    principal: ADA,
    entity: 'settings',
    entityId: 'singleton',
    // EVERY VALUE CLASS structured clone admits that a naive plain-object check
    // would swallow. `Date` is the one that actually bit; `Map`, `Set` and a
    // TypedArray satisfy the same naive `typeof v === 'object'` test and would be
    // rebuilt as `{}` by the same walker. The scrub's contract is two-sided —
    // remove exactly the secret, preserve exactly everything else — and only this
    // half is at risk from a rebuilding walker.
    value: {
      ...payloadWith(SECRET.entity),
      fetchedAt: new Date(0),
      labels: new Map([['a', 1]]),
      seen: new Set(['x', 'y']),
      bytes: new Uint8Array([1, 2, 3]),
    },
    revision: 7,
    provenance: { origin: 'authority' },
  })
  tx.objectStore(META_STORE).put({
    principal: ADA,
    key: CURSOR_KEY,
    value: { feedId: 'feed', epoch: 'e1', seq: 3, leaked: payloadWith(SECRET.cursor) },
  })
  const outbox = tx.objectStore(OUTBOX_STORE)
  outbox.put({
    principal: ADA,
    mutationId: 'mut-live',
    ordinal: 0,
    record: outboxRecord('mut-live', 'queued', SECRET.live),
  })
  // HISTORY. A terminal entry and a dead-lettered one — the rows a scrub written
  // against the live queue never visits.
  outbox.put({
    principal: ADA,
    mutationId: 'mut-applied',
    ordinal: 1,
    record: { ...outboxRecord('mut-applied', 'applied', SECRET.applied), appliedAt: 1 },
  })
  outbox.put({
    principal: ADA,
    mutationId: 'mut-dead',
    ordinal: 2,
    record: {
      ...outboxRecord('mut-dead', 'dead-letter', SECRET.deadLettered),
      deadLetteredAt: 2,
      parkedFrom: 'rejected',
    },
  })
  await new Promise<void>((resolve, reject) => {
    tx.oncomplete = () => {
      resolve()
    }
    tx.onerror = () => {
      reject(tx.error ?? new Error('seed failed'))
    }
  })
  db.close()
}

describe('IndexedDB: a replica written by an earlier build is scrubbed at open', () => {
  it('removes material from EVERY region and EVERY outbox state, and says where', async () => {
    const factory = freshFactory()
    await seedIdb(factory)

    const reports: SecretScrubReport[] = []
    await IndexedDbSyncStore.open({
      factory,
      onDegraded: () => {},
      onSecretsScrubbed: (report) => reports.push(report),
    })

    // The pass FOUND something — the non-vacuity check. Without this, a scrub
    // that silently did nothing would satisfy every absence assertion below on
    // a store that had never held anything.
    const report = reports[0]
    expect(report).toBeDefined()
    expect(report?.rewritten).toBe(5)
    expect([...(report?.removed ?? [])].sort()).toEqual([
      'entities[ada/settings/singleton].apiKeys.openai',
      'meta[ada/cursor].leaked.apiKeys.openai',
      'outbox[ada/mut-applied].input.settings.apiKeys.openai',
      'outbox[ada/mut-dead].input.settings.apiKeys.openai',
      'outbox[ada/mut-live].input.settings.apiKeys.openai',
    ])

    // …and it is DURABLE. Read through a connection of its own: the store's own
    // mirror could report clean while the material sat in the object store.
    const durable = await readDurableIdb(factory)
    const serialized = JSON.stringify(durable)
    for (const secret of ALL_SECRETS) expect(serialized).not.toContain(secret)

    const entity = durable[ENTITY_STORE]?.[0] as { value: Record<string, unknown> }
    expectScrubbedButIntact(JSON.stringify(entity.value), entity.value)
    // THE SURVIVOR THAT ONLY THIS CATCHES: a rebuilding walker turns a Date into
    // `{}` and reports a perfectly clean scrub.
    expect(entity.value.fetchedAt).toBeInstanceOf(Date)
    expect((entity.value.fetchedAt as Date).getTime()).toBe(0)
    // …and the rest of the structured-clone menagerie, BY VALUE rather than by
    // "is it still truthy": a rebuilt `{}` is truthy and has the wrong contents.
    expect(entity.value.labels).toBeInstanceOf(Map)
    expect([...(entity.value.labels as Map<string, number>)]).toEqual([['a', 1]])
    expect(entity.value.seen).toBeInstanceOf(Set)
    expect([...(entity.value.seen as Set<string>)]).toEqual(['x', 'y'])
    expect(entity.value.bytes).toBeInstanceOf(Uint8Array)
    expect([...(entity.value.bytes as Uint8Array)]).toEqual([1, 2, 3])

    const outboxRows = (durable[OUTBOX_STORE] ?? []) as {
      mutationId: string
      record: { input: { settings: Record<string, unknown> }; state: string }
    }[]
    expect(outboxRows.map((r) => r.mutationId).sort()).toEqual([
      'mut-applied',
      'mut-dead',
      'mut-live',
    ])
    for (const row of outboxRows) {
      expectScrubbedButIntact(JSON.stringify(row.record), row.record.input.settings)
    }
    // The entries are still THERE, in their own states — a scrub that deleted
    // the rows would satisfy every absence assertion above and destroy the
    // user's recoverable intent (ADR 6 D9).
    expect(outboxRows.map((r) => r.record.state).sort()).toEqual([
      'applied',
      'dead-letter',
      'queued',
    ])
  })

  it('is a no-op on a clean store, and says so', async () => {
    const factory = freshFactory()
    const reports: SecretScrubReport[] = []
    await IndexedDbSyncStore.open({
      factory,
      onDegraded: () => {},
      onSecretsScrubbed: (report) => reports.push(report),
    })
    // The mirror trap of a scrub: one that ate everything would satisfy every
    // absence assertion in this file.
    expect(reports[0]?.removed).toEqual([])
    expect(reports[0]?.rewritten).toBe(0)
  })

  it('converges — a second open finds nothing left to do', async () => {
    const factory = freshFactory()
    await seedIdb(factory)
    await IndexedDbSyncStore.open({ factory, onDegraded: () => {} })

    const reports: SecretScrubReport[] = []
    await IndexedDbSyncStore.open({
      factory,
      onDegraded: () => {},
      onSecretsScrubbed: (report) => reports.push(report),
    })
    // It still SCANNED — "nothing to do" must not be "did not look".
    expect(reports[0]?.scanned).toBe(5)
    expect(reports[0]?.rewritten).toBe(0)
  })
})

// ─────────────────────────── mobile SQLite (native) ───────────────────────────

let cleanupFile: (() => void) | undefined
afterEach(() => {
  cleanupFile?.()
  cleanupFile = undefined
})

describe('mobile SQLite: a replica written by an earlier build is scrubbed at open', () => {
  it('removes material from every region and every outbox state, durably', () => {
    const { file, cleanup } = freshDatabaseFile()
    cleanupFile = cleanup

    // Seed through a connection of its own, as an earlier build left the file.
    const seed = sqliteEngine.open(file)
    applySchema(seed)
    seed
      .prepare(
        `INSERT INTO ${ENTITY_TABLE} (principal, entity, entity_id, value, revision, provenance) VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        ADA,
        'settings',
        'singleton',
        JSON.stringify(payloadWith(SECRET.entity)),
        7,
        JSON.stringify({ origin: 'authority' }),
      )
    seed
      .prepare(`INSERT INTO ${META_TABLE} (principal, key, value) VALUES (?, ?, ?)`)
      .run(
        ADA,
        CURSOR_KEY,
        JSON.stringify({ feedId: 'feed', epoch: 'e1', seq: 3, leaked: payloadWith(SECRET.cursor) }),
      )
    const insertOutbox = seed.prepare(
      `INSERT INTO ${OUTBOX_TABLE} (principal, mutation_id, ordinal, record) VALUES (?, ?, ?, ?)`,
    )
    insertOutbox.run(
      ADA,
      'mut-live',
      0,
      JSON.stringify(outboxRecord('mut-live', 'queued', SECRET.live)),
    )
    insertOutbox.run(
      ADA,
      'mut-applied',
      1,
      JSON.stringify(outboxRecord('mut-applied', 'applied', SECRET.applied)),
    )
    insertOutbox.run(
      ADA,
      'mut-dead',
      2,
      JSON.stringify(outboxRecord('mut-dead', 'dead-letter', SECRET.deadLettered)),
    )
    seed.close?.()

    const reports: SecretScrubReport[] = []
    SqliteSyncStore.open({
      openDatabase: () => sqliteEngine.open(file),
      deleteDatabase: () => {},
      onDegraded: () => {},
      onSecretsScrubbed: (report) => reports.push(report),
    })

    // It found something, at named addresses across all three regions.
    expect(reports[0]?.rewritten).toBe(5)
    expect([...(reports[0]?.removed ?? [])].sort()).toEqual([
      'entities[ada/settings/singleton].apiKeys.openai',
      'meta[ada/cursor].leaked.apiKeys.openai',
      'outbox[ada/mut-applied].input.settings.apiKeys.openai',
      'outbox[ada/mut-dead].input.settings.apiKeys.openai',
      'outbox[ada/mut-live].input.settings.apiKeys.openai',
    ])

    // Durable, through a SECOND CONNECTION — never the store that wrote it.
    const durable = readDurableSqlite(file)
    const serialized = JSON.stringify(durable)
    for (const secret of ALL_SECRETS) expect(serialized).not.toContain(secret)

    const entity = durable.entities[0]?.value as Record<string, unknown>
    expectScrubbedButIntact(JSON.stringify(entity), entity)

    expect(durable.outbox.map((r) => r.mutationId).sort()).toEqual([
      'mut-applied',
      'mut-dead',
      'mut-live',
    ])
    for (const row of durable.outbox) {
      const record = row.record as { input: { settings: Record<string, unknown> } }
      expectScrubbedButIntact(JSON.stringify(record), record.input.settings)
    }
  })

  it('is a no-op on a clean store, and still reports that it looked', () => {
    const { file, cleanup } = freshDatabaseFile()
    cleanupFile = cleanup
    const reports: SecretScrubReport[] = []
    SqliteSyncStore.open({
      openDatabase: () => sqliteEngine.open(file),
      deleteDatabase: () => {},
      onDegraded: () => {},
      onSecretsScrubbed: (report) => reports.push(report),
    })
    expect(reports[0]).toEqual({ scanned: 0, rewritten: 0, removed: [] })
  })
})
