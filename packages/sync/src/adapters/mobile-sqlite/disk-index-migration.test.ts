/**
 * POD-7159 — schema version 2 to 3: a file written by the build before the
 * disk index opens with every row and marker readable, its index built once
 * from its rows. A crash in the middle of the migration leaves the file as it
 * was (the build is one transaction); the next open builds it.
 */
import { copyFileSync } from 'node:fs'
import { afterEach, describe, expect, it } from 'vitest'
import { CollectionServer, issue, session, WORLD_NOW } from '../../conformance/collection-server'
import { instanceKey } from '../../replica/cache-state'
import { Replica } from '../../replica/replica'
import type { EntityRecord, InstanceSpec } from '../../replica/types'
import { ENTITY_TABLE, INDEX_TABLE, META_TABLE, SCHEMA_VERSION_TABLE } from './schema'
import type { SqlDatabaseLike } from './sql'
import { SqliteSyncStore } from './store'
import { FaultySqlDatabase, freshDatabaseFile, sqliteEngine } from './test-support'

const PRINCIPAL = 'u-ada'
const ISSUE = 'issueProjection'
const tree = (root: string): InstanceSpec => ({
  collection: 'issueProjection.tree',
  args: { root },
  part: 'main',
})
const keyOf = (row: Pick<EntityRecord, 'entity' | 'entityId'>) =>
  `${row.entity}\u0000${row.entityId}`

const ticks = async (count = 5): Promise<void> => {
  for (let i = 0; i < count; i += 1) await new Promise((resolve) => setTimeout(resolve, 0))
}

function world(): CollectionServer {
  const server = new CollectionServer()
  server.put(ISSUE, 'A1', issue('A1'))
  server.put(ISSUE, 'A2', issue('A2', { stage: 'review', parentId: 'A1' }))
  server.put(ISSUE, 'D1', issue('D1', { stage: 'done', closedReason: 'completed', parentId: 'A1' }))
  server.put(ISSUE, 'D2', issue('D2', { stage: 'done', closedReason: 'completed' }))
  server.put('session', 'S1', session('S1', { issueId: 'A1' }))
  server.put('session', 'S9', session('S9', { issueId: 'D1', status: 'ended' }))
  server.answerComesWith = true
  return server
}

/**
 * The comes-with markers the build before the index wrote for what records
 * come with (their own markers, via the holder); the build after records them
 * on the holder instead. D1's sessions in the tree, and its user state.
 */
const OLD_COMES_WITH = [
  {
    collection: 'session.ofIssue',
    args: { issueId: 'D1' },
    part: 'main',
    via: 'issueProjection.tree',
  },
  {
    collection: 'issueUserState.ofIssue',
    args: { issueId: 'D1' },
    part: 'main',
    via: 'issueProjection',
  },
] as const

const cleanups: (() => void)[] = []
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup()
})

const open = (connect: () => SqlDatabaseLike) =>
  SqliteSyncStore.open({
    openDatabase: connect,
    // A crashed process deletes nothing: a recovery that tried would fail here.
    deleteDatabase: () => {
      throw new Error('no delete in this test')
    },
    onDegraded: () => {},
  })

/** A device that downloaded the world and opened the tree of A1, as the build before the index left it. */
async function versionTwoFile(): Promise<{
  readonly file: string
  readonly rows: readonly EntityRecord[]
  readonly markers: readonly string[]
}> {
  const fresh = freshDatabaseFile()
  cleanups.push(fresh.cleanup)
  const store = await open(() => sqliteEngine.open(fresh.file))
  const { cache } = store.viewFor(PRINCIPAL)
  const replica = new Replica({ store: cache, authority: world(), now: () => WORLD_NOW })
  replica.connect()
  await replica.settled()
  await ticks()
  await replica.settled()
  await replica.load([tree('A1')])
  await replica.settled()
  const rows = [...cache.readEntities(), ...cache.readStubs()]
  const markers = [...cache.readInstances().keys()].sort()
  store.close()
  // The version-2 layout: the same entity and meta rows, no index table, no flag.
  const raw = sqliteEngine.open(fresh.file)
  try {
    raw.exec(`DROP TABLE ${INDEX_TABLE}`)
    raw.prepare(`DELETE FROM ${META_TABLE} WHERE principal = ?`).run('')
    raw.prepare(`UPDATE ${SCHEMA_VERSION_TABLE} SET version = 2 WHERE singleton = 1`).run()
    // The build before the index wrote a stub-level record as an entity row too
    // (this build keeps it in its index entry only, POD-7170).
    for (const row of rows)
      if (row.part === 'stub')
        raw
          .prepare(
            `INSERT INTO ${ENTITY_TABLE} (principal, entity, entity_id, value, revision, provenance, part, as_of)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            PRINCIPAL,
            row.entity,
            row.entityId,
            JSON.stringify(row.value),
            row.revision ?? null,
            JSON.stringify(row.provenance),
            'stub',
            row.asOf ?? null,
          )
    const cursor = (
      raw
        .prepare(`SELECT value FROM ${META_TABLE} WHERE principal = ? AND key = ?`)
        .get(PRINCIPAL, 'cursor') as {
        value: string
      }
    ).value
    for (const spec of OLD_COMES_WITH)
      raw
        .prepare(`INSERT INTO ${META_TABLE} (principal, key, value) VALUES (?, ?, ?)`)
        .run(
          PRINCIPAL,
          `instance\u0000${instanceKey(spec)}`,
          JSON.stringify({ ...spec, key: instanceKey(spec), completeAt: JSON.parse(cursor) }),
        )
  } finally {
    raw.close()
  }
  expect(rows.length).toBeGreaterThan(4)
  expect(markers).toContain(instanceKey(tree('A1')))
  return { file: fresh.file, rows, markers }
}

async function expectReadable(
  store: SqliteSyncStore,
  rows: readonly EntityRecord[],
  markers: readonly string[],
): Promise<void> {
  const { cache } = store.viewFor(PRINCIPAL)
  expect([...cache.readInstances().keys()].sort()).toEqual(markers)
  const index = cache.readDiskIndex()
  const read = await cache.readDiskRows(rows.map(keyOf))
  const byKey = new Map(read.map((row) => [keyOf(row), row]))
  for (const row of rows) {
    expect(index.record(keyOf(row)), row.entityId).toMatchObject({
      level: row.part === 'stub' ? 'stub' : 'main',
    })
    expect(byKey.get(keyOf(row))?.value, row.entityId).toEqual(row.value)
  }
  // The tree is answered from disk: the server is never asked for it (what
  // its records come with and the old store did not mark is asked, as ever).
  const server = world()
  const asked: string[] = []
  const answer = server.collections.bind(server)
  server.collections = (instances) => {
    asked.push(...instances.map((instance) => instanceKey(instance)))
    return answer(instances)
  }
  // A row a record brings is not in memory at start: it comes with the record.
  expect(cache.read('session', 'S9')).toBeUndefined()
  const replica = new Replica({ store: cache, authority: server, now: () => WORLD_NOW })
  await replica.load([tree('A1')])
  await replica.settled()
  expect(asked).not.toContain(instanceKey(tree('A1')))
  expect(replica.isComplete(tree('A1'))).toBeDefined()
  for (const id of ['A1', 'A2', 'D1']) expect(cache.read(ISSUE, id), id).toBeDefined()
  // The old comes-with markers are on D1 now: its tree sessions came with it from disk.
  for (const spec of OLD_COMES_WITH)
    expect(cache.readInstances().has(instanceKey(spec))).toBe(false)
  expect(index.record(`${ISSUE}\u0000D1`)?.cw).toContain('issueProjection.tree')
  expect(index.record('session\u0000S9')?.holders).toContain(`^${ISSUE}\u0000D1`)
  expect(cache.read('session', 'S9')).toBeDefined()
}

describe('mobile SQLite schema 2 to 3: the disk index (POD-7159)', () => {
  it('opens a version-2 file with every row and marker readable, and builds the index once', async () => {
    const { file, rows, markers } = await versionTwoFile()
    const store = await open(() => sqliteEngine.open(file))
    await expectReadable(store, rows, markers)
    store.close()
    const counted = new FaultySqlDatabase(sqliteEngine.open(file))
    const again = await open(() => counted)
    expect(counted.prepared.some((sql) => /FROM entities\s*$/.test(sql.trim()))).toBe(false)
    await expectReadable(again, rows, markers)
    again.close()
  })

  for (const at of [0, 1, 5])
    it(`keeps every row after a crash at write ${at} of the migration, and builds it on the next open`, async () => {
      const { file, rows, markers } = await versionTwoFile()
      const copy = `${file}.crash`
      copyFileSync(file, copy)
      const connection = sqliteEngine.open(copy)
      const faulty = new FaultySqlDatabase(connection)
      faulty.denyWriteAt({ at, mode: 'crash', error: new Error('power loss') })
      // THE CRASH: whatever this process makes of it, it is gone.
      const crashed = await open(() => faulty)
      expect(faulty.denials).toBe(1)
      // The OS reclaims the dead process's handle: its open transaction rolls
      // back and its lock goes (before the handle is closed, which a pending
      // statement could otherwise leave open).
      try {
        connection.exec('ROLLBACK')
      } catch {
        // No transaction was open.
      }
      crashed.close()
      try {
        connection.close()
      } catch {
        // Already closed with the store.
      }
      const store = await open(() => sqliteEngine.open(copy))
      await expectReadable(store, rows, markers)
      store.close()
    })
})
