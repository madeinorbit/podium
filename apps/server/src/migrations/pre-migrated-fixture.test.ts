/**
 * The acceptance evidence for POD-523's pre-migrated store fixture.
 *
 * It lives under `src/migrations/` on purpose: that directory is opted out of the
 * fixture STRUCTURALLY, so this file starts on the real 54-step chain and can put
 * both arms — chain and clone — side by side in one process. The first test proves
 * that opt-out is real rather than asserted.
 */

import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDatabase, openDatabaseFromImage, type SqlDatabase } from '@podium/runtime/sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import { SessionStore } from '../store'
import { installStoreDatabaseOpener, storeDatabaseOpenerInstalled } from '../store-database'
import {
  currentSchemaImage,
  FIXTURE_DISABLED_ENV,
  installPreMigratedStoreFixture,
  useRealMigrationChain,
  usesRealMigrationChain,
} from '../test-support/pre-migrated-store'
import { schemaCachePath, schemaFingerprint } from '../test-support/pre-migrated-store.build'
import { buildSchemaImage } from '../test-support/pre-migrated-store.image'
import { DRIZZLE_MIGRATIONS } from './drizzle-manifest.generated'
import { appliedDrizzleNames, runDrizzleMigrations } from './index'

/** The A/B arm that disables the fixture has no image to compare against. */
const disabled = process.env[FIXTURE_DISABLED_ENV] !== undefined

afterEach(() => useRealMigrationChain())

function raw(store: SessionStore): SqlDatabase {
  // @ts-expect-error private db — schema/migration assertions
  return store.db
}

/** Every object in the schema, as sqlite itself describes it. */
function schemaObjects(db: SqlDatabase): { type: string; name: string; sql: string | null }[] {
  return db
    .prepare(
      `SELECT type, name, sql FROM sqlite_master
         WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name`,
    )
    .all() as { type: string; name: string; sql: string | null }[]
}

/** ISO-8601 instants written by the per-boot heals — two boots are two clocks. */
const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/

/** Every row of every table, so migration DML is compared and not just DDL. */
function allRows(db: SqlDatabase): Record<string, unknown[]> {
  const tables = (
    db
      .prepare(
        `SELECT name FROM sqlite_master
           WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name`,
      )
      .all() as { name: string }[]
  ).map((t) => t.name)
  const rows: Record<string, unknown[]> = {}
  for (const table of tables) {
    rows[table] = (db.prepare(`SELECT * FROM "${table}"`).all() as Record<string, unknown>[]).map(
      (row) =>
        Object.fromEntries(
          Object.entries(row).map(([column, value]) => [
            column,
            typeof value === 'string' && ISO_INSTANT.test(value) ? '<instant>' : value,
          ]),
        ),
    )
  }
  return rows
}

describe('migration suites keep the full 54-step path [POD-523]', () => {
  it('does not install the fixture for a file under src/migrations/', () => {
    // This very file. If the setupFile ever stopped honouring the structural
    // opt-out, every assertion below would be comparing the clone with itself.
    expect(storeDatabaseOpenerInstalled()).toBe(false)
  })

  it('still applies every migration in the manifest on a fresh database', () => {
    const db = openDatabase(':memory:')
    db.exec('PRAGMA foreign_keys = OFF')
    const applied = runDrizzleMigrations(db, DRIZZLE_MIGRATIONS)
    expect(applied).toEqual(DRIZZLE_MIGRATIONS.map((m) => m.name))
    expect(applied.length).toBe(54)
    db.close()
  })

  it('opts out src/migrations/** structurally and keeps ordinary suites on the clone', () => {
    const root = '/repo/apps/server/src/'
    expect(usesRealMigrationChain(`${root}migrations/convergence.test.ts`)).toBe(true)
    expect(usesRealMigrationChain(`${root}migrations/nested/deep.test.ts`)).toBe(true)
    expect(usesRealMigrationChain(`${root}store.test.ts`)).toBe(false)
    expect(usesRealMigrationChain(`${root}modules/messages/service.test.ts`)).toBe(false)
    expect(usesRealMigrationChain(`${root}relay.test.ts`)).toBe(false)
    // Anything outside apps/server never gets the fixture at all.
    expect(usesRealMigrationChain('/repo/packages/sync/src/replica.test.ts')).toBe(true)
  })
})

describe.skipIf(disabled)('the clone is the chain [POD-523]', () => {
  it('reaches byte-identical schema objects and rows', () => {
    const chain = new SessionStore(':memory:', 'machine-under-test')
    const fromChain = { schema: schemaObjects(raw(chain)), rows: allRows(raw(chain)) }
    chain.close()

    installPreMigratedStoreFixture()
    const cloned = new SessionStore(':memory:', 'machine-under-test')
    const fromClone = { schema: schemaObjects(raw(cloned)), rows: allRows(raw(cloned)) }
    cloned.close()

    expect(fromClone.schema).toEqual(fromChain.schema)
    // Not just counts: the ten migrations carrying DML seed rows, and the per-boot
    // heals write more. Equality here is what makes "the clone is the chain" a
    // claim about the database rather than about its table list.
    expect(fromClone.rows).toEqual(fromChain.rows)
  })

  it('carries the whole migration ledger, so nothing is left pending', () => {
    installPreMigratedStoreFixture()
    const store = new SessionStore(':memory:')
    expect([...appliedDrizzleNames(raw(store))].sort()).toEqual(
      DRIZZLE_MIGRATIONS.map((m) => m.name).sort(),
    )
    store.close()
  })

  it('seeds a fresh file database and leaves an existing one to the chain', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pod523-'))
    installPreMigratedStoreFixture()

    const fresh = join(dir, 'fresh.db')
    const seeded = new SessionStore(fresh)
    expect(appliedDrizzleNames(raw(seeded)).size).toBe(DRIZZLE_MIGRATIONS.length)
    seeded.close()

    // A database the test built on purpose (here: one migration deep) must NOT be
    // overwritten — that is how the upgrade suites build their old schemas.
    const existing = join(dir, 'existing.db')
    const old = openDatabase(existing)
    old.exec('PRAGMA foreign_keys = OFF')
    runDrizzleMigrations(old, DRIZZLE_MIGRATIONS.slice(0, 1))
    old.close()
    const upgraded = new SessionStore(existing)
    // It advanced by its pending migrations rather than being replaced by the image.
    expect(appliedDrizzleNames(raw(upgraded)).size).toBe(DRIZZLE_MIGRATIONS.length)
    upgraded.close()
  })
})

describe.skipIf(disabled)('state cannot cross test cases [POD-523]', () => {
  it('gives every store an independent database', () => {
    installPreMigratedStoreFixture()
    const first = new SessionStore(':memory:')
    first.repos.addRepo('/only-in-first', first.hostMachineId)
    const second = new SessionStore(':memory:')
    expect(second.repos.listRepoPaths()).toEqual([])
    expect(first.repos.listRepoPaths()).toEqual(['/only-in-first'])
    first.close()
    second.close()
  })

  it('never lets a write reach the shared image', () => {
    installPreMigratedStoreFixture()
    const before = Buffer.from(currentSchemaImage()).toString('base64')
    const store = new SessionStore(':memory:')
    // Enough writing to force page allocation and growth, not just a header touch:
    // ~4 MB against an 816 KB image, straight at the connection.
    raw(store).exec('CREATE TABLE zz_growth (x TEXT)')
    const insert = raw(store).prepare('INSERT INTO zz_growth VALUES (?)')
    for (let i = 0; i < 20_000; i++) insert.run('x'.repeat(200))
    store.repos.addRepo('/written', store.hostMachineId)
    store.close()
    expect(Buffer.from(currentSchemaImage()).toString('base64')).toBe(before)
    // And the next clone still sees an empty database.
    const after = new SessionStore(':memory:')
    expect(after.repos.listRepoPaths()).toEqual([])
    after.close()
  })
})

describe.skipIf(disabled)('the clone invalidates automatically [POD-523]', () => {
  it('keys the cache on every migration name and sql', () => {
    const base = schemaFingerprint(DRIZZLE_MIGRATIONS)
    expect(schemaFingerprint([...DRIZZLE_MIGRATIONS])).toBe(base)

    const renamed = DRIZZLE_MIGRATIONS.map((m, i) =>
      i === 0 ? { ...m, name: `${m.name}-renamed` } : m,
    )
    expect(schemaFingerprint(renamed)).not.toBe(base)

    const edited = DRIZZLE_MIGRATIONS.map((m, i) =>
      i === 3
        ? { ...m, sql: `${m.sql}\n--> statement-breakpoint\nALTER TABLE repos ADD x TEXT;` }
        : m,
    )
    expect(schemaFingerprint(edited)).not.toBe(base)

    const added = [
      ...DRIZZLE_MIGRATIONS,
      { name: '29990101000000_hypothetical', sql: 'CREATE TABLE hypothetical (id TEXT);' },
    ]
    expect(schemaFingerprint(added)).not.toBe(base)

    // A different key is a different file — that is the whole invalidation story.
    expect(schemaCachePath(schemaFingerprint(edited))).not.toBe(schemaCachePath(base))
    expect(schemaCachePath(base)).toContain(base)
  })

  it('caches an image equivalent to one built from the live manifest right now', () => {
    const cached = schemaCachePath()
    expect(existsSync(cached)).toBe(true)
    // Not a byte comparison: sqlite's page layout is not required to be reproducible.
    // What must hold is that the cached database and one built from today's manifest
    // are the same database — same objects, same rows, same ledger.
    const fromCache = openDatabaseFromImage(readFileSync(cached))
    const fromManifest = openDatabaseFromImage(buildSchemaImage())
    expect(schemaObjects(fromCache)).toEqual(schemaObjects(fromManifest))
    expect(allRows(fromCache)).toEqual(allRows(fromManifest))
    fromCache.close()
    fromManifest.close()
  })
})

describe('the seam cannot reach production [POD-523]', () => {
  it('refuses to install an opener outside a test runner', () => {
    const { VITEST, NODE_ENV } = process.env
    delete process.env.VITEST
    delete process.env.NODE_ENV
    try {
      expect(() => installStoreDatabaseOpener(() => openDatabase(':memory:'))).toThrow(
        /test-only seam/,
      )
    } finally {
      if (VITEST !== undefined) process.env.VITEST = VITEST
      if (NODE_ENV !== undefined) process.env.NODE_ENV = NODE_ENV
    }
  })

  it.skipIf(disabled)('writes the image only where a test asked for a database', () => {
    // Guards the file branch of the opener: it must never invent a path.
    const dir = mkdtempSync(join(tmpdir(), 'pod523-'))
    const decoy = join(dir, 'not-a-database.txt')
    writeFileSync(decoy, 'untouched')
    installPreMigratedStoreFixture()
    const store = new SessionStore(join(dir, 'db', 'podium.db'))
    store.close()
    expect(readFileSync(decoy, 'utf8')).toBe('untouched')
  })
})
