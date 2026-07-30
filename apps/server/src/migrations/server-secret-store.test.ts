/**
 * THE LIVE-UPGRADE CONTINUITY TEST for the server-secret lift (POD-419).
 *
 * The migration copies five values out of a JSON blob into a new table and then
 * removes them from the blob. That is a backfill followed by a delete — the
 * POD-1076 shape exactly, which shipped as three correctly-shaped EMPTY tables
 * with no error and total silent loss. The bar is therefore not "it does not
 * error": it is that each specific value is observed to ARRIVE, under the RIGHT
 * KEY, and to be GONE from where it was.
 *
 * ---------------------------------------------------------------------------
 * THE FOUR FIXTURE TRAPS THIS AVOIDS, NAMED
 * ---------------------------------------------------------------------------
 *
 * 1. A database with no `__drizzle_migrations` ledger is not an OLD database —
 *    it is one drizzle has never seen, so the migrator replays the baseline and
 *    the test silently exercises FIRST BOOT instead of an upgrade (POD-305).
 *    Every case rewinds a REAL database by applying the manifest up to but not
 *    including this migration, and asserts the ledger exists.
 * 2. An all-empty or all-identical secret fixture passes whether the migration
 *    lifted five values or one. Every seeded secret has a DISTINCT value, and
 *    every assertion is BY KEY AND VALUE — never a count. All five are TEXT out
 *    of one blob, so a mis-keyed lift is invisible to every schema, NOT NULL and
 *    count check there is.
 * 3. A fixture with only secrets in the blob would pass a migration that
 *    replaced the whole `meta['settings']` row. The blob is seeded with
 *    preferences from all three tiers, and they are asserted to survive
 *    unchanged — including `experimental`, which POD-352's drift refresh
 *    whitelists as intentionally-replicated preference data.
 * 4. Reading back through the connection that ran the migration can observe
 *    state the write never durably reached (POD-374). The scrub assertions read
 *    the blob back out of `meta` directly, and the repository cases go through
 *    `ServerSecretsRepository` — the object production actually uses.
 *
 * NOT ASSERTED: that this migration is LAST. Siblings land migrations
 * concurrently, and pinning "last" makes a green test a function of merge order.
 */

import { openDatabase } from '@podium/runtime/sqlite'
import { SERVER_SECRET_KEYS } from '@podium/model'
import { describe, expect, it } from 'vitest'
import { ServerSecretsRepository } from '../store/server-secrets'
import { DRIZZLE_MIGRATIONS } from './drizzle-manifest.generated'
import { runDrizzleMigrations } from './index'

const MIGRATION = 'server-secret-store'

/**
 * The keys the migration's SQL spells out, transcribed. Asserted below to equal
 * POD-418's shipped vocabulary — this is where the frozen-history literals and
 * the live vocabulary are tied together, and a secret added to the model without
 * a migration to lift it fails HERE rather than silently staying in the blob.
 */
const LIFTED_KEYS = [
  'apiKeys.openrouter',
  'apiKeys.anthropic',
  'apiKeys.openai',
  'integrations.linearApiKey',
  'notifications.telegramBotToken',
] as const

/** DISTINCT per key, and recognisable in a failure message: a swapped pair is
 *  the mutant that no schema assertion can see. */
const SEEDED: Readonly<Record<(typeof LIFTED_KEYS)[number], string>> = {
  'apiKeys.openrouter': 'or-v1-DISTINCT-openrouter',
  'apiKeys.anthropic': 'sk-ant-DISTINCT-anthropic',
  'apiKeys.openai': 'sk-DISTINCT-openai',
  'integrations.linearApiKey': 'lin_api_DISTINCT-linear',
  'notifications.telegramBotToken': '1234:DISTINCT-telegram',
}

/** Preferences from all three of the blob's other homes, seeded beside the
 *  secrets so "the migration replaced the row" is distinguishable from "the
 *  migration removed five members of it". */
const PREFERENCES = {
  sidebar: { repoSort: 'name', groupByRepo: true },
  hibernation: { memoryPct: 73 },
  experimental: { 'feature.someFlag': true },
  notifications: { telegramChatId: '99887766', web: true },
  integrations: { linearWorkspace: 'acme' },
}

type Db = ReturnType<typeof openDatabase>

const cutIndex = () => {
  const cut = DRIZZLE_MIGRATIONS.findIndex((m) => m.name.includes(MIGRATION))
  expect(cut).toBeGreaterThan(0)
  return cut
}

const tableExists = (db: Db, name: string): boolean =>
  db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?`).get(name) !==
  undefined

/** The blob as it sits in `meta` RIGHT NOW — read raw, never through
 *  `normalizeSettings`, which would fill the legacy defaults back in and make a
 *  removed key indistinguishable from a blanked one. */
const rawBlob = (db: Db): Record<string, unknown> => {
  const row = db.prepare(`SELECT value FROM meta WHERE key = 'settings'`).get() as
    | { value: string }
    | undefined
  expect(row).toBeDefined()
  return JSON.parse((row as { value: string }).value)
}

/** A real pre-migration database: every migration before this one applied, with
 *  a real drizzle ledger, and the pre-state asserted rather than assumed. */
function preMigrationDb(blob: unknown = { ...PREFERENCES, ...nestedSecrets() }): Db {
  const db = openDatabase(':memory:')
  runDrizzleMigrations(db, DRIZZLE_MIGRATIONS.slice(0, cutIndex()))

  // THE PRE-STATE. If the table already existed, this test would be measuring a
  // database that had already been migrated.
  expect(tableExists(db, 'server_secrets')).toBe(false)
  // …and the ledger really is there, so the run below applies ONE migration
  // rather than replaying the baseline onto a virgin file.
  expect(tableExists(db, '__drizzle_migrations')).toBe(true)

  db.prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)').run(
    'settings',
    JSON.stringify(blob),
  )
  return db
}

/** The seeded secrets, in the nested shape the legacy blob holds them in. */
function nestedSecrets(): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const key of LIFTED_KEYS) {
    const [group, leaf] = key.split('.') as [string, string]
    const node = (out[group] ??= {}) as Record<string, unknown>
    node[leaf] = SEEDED[key]
  }
  // The two groups that also carry preferences merge rather than replace.
  return {
    ...out,
    notifications: { ...(out.notifications as object), ...PREFERENCES.notifications },
    integrations: { ...(out.integrations as object), ...PREFERENCES.integrations },
  }
}

describe('the migration lifts the keys the model classifies — no second list', () => {
  it('the literals the SQL spells out ARE POD-418’s shipped vocabulary', () => {
    // The frozen-history literals are pinned to the live vocabulary HERE and
    // nowhere else. A secret added to the model with no migration to lift it
    // fails this, instead of quietly remaining in the blob forever.
    expect([...LIFTED_KEYS].sort()).toEqual([...SERVER_SECRET_KEYS].sort())
  })
})

describe('the COPY happens, and lands under the right key', () => {
  it('carries every configured secret across BY KEY AND VALUE', () => {
    const db = preMigrationDb()
    runDrizzleMigrations(db, DRIZZLE_MIGRATIONS)

    const rows = db.prepare('SELECT key, value FROM server_secrets ORDER BY key').all() as {
      key: string
      value: string
    }[]

    // Pairwise, not by count and not by set-of-values: two same-typed strings
    // swapped between keys satisfies every count assertion and every NOT NULL
    // constraint, and leaves the instance authenticating to Anthropic with an
    // OpenAI key. This is the assertion the swap mutant has to fail.
    expect(Object.fromEntries(rows.map((r) => [r.key, r.value]))).toEqual(SEEDED)
  })

  it('stamps a rotation time the blob never had', () => {
    const db = preMigrationDb()
    runDrizzleMigrations(db, DRIZZLE_MIGRATIONS)
    const rows = db.prepare('SELECT updated_at FROM server_secrets').all() as {
      updated_at: string
    }[]
    // ISO-8601 with a Z, matching every other timestamp column — `datetime('now')`
    // would write the space-separated form that string comparison sorts wrongly.
    expect(rows).toHaveLength(LIFTED_KEYS.length)
    for (const row of rows) expect(row.updated_at).toMatch(/^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/)
  })

  it('does not import an unconfigured secret as a blank row', () => {
    // Absence is the ROW being absent — the property that lets
    // `SecretPresenceWire.present` mean something.
    const db = preMigrationDb({
      ...PREFERENCES,
      apiKeys: { openai: 'sk-only-this-one', anthropic: '', openrouter: '' },
    })
    runDrizzleMigrations(db, DRIZZLE_MIGRATIONS)

    const rows = db.prepare('SELECT key, value FROM server_secrets').all() as { key: string }[]
    expect(rows.map((r) => r.key)).toEqual(['apiKeys.openai'])
  })
})

describe('the CLEAR happens, and takes exactly the secrets', () => {
  it('removes every secret MEMBER from the blob — the key is gone, not blanked', () => {
    const db = preMigrationDb()
    runDrizzleMigrations(db, DRIZZLE_MIGRATIONS)

    const blob = rawBlob(db)
    expect(blob.apiKeys).toEqual({})
    expect(Object.hasOwn(blob.apiKeys as object, 'openai')).toBe(false)
    // …and no seeded material survives anywhere in the serialized row, at any
    // address. A member relocated rather than removed would pass the two checks
    // above and fail this one.
    const serialized = JSON.stringify(blob)
    for (const value of Object.values(SEEDED)) expect(serialized).not.toContain(value)
  })

  it('leaves every preference untouched, including its secret-sharing siblings', () => {
    const db = preMigrationDb()
    runDrizzleMigrations(db, DRIZZLE_MIGRATIONS)

    const blob = rawBlob(db)
    expect(blob.sidebar).toEqual(PREFERENCES.sidebar)
    expect(blob.hibernation).toEqual(PREFERENCES.hibernation)
    // POD-352's drift refresh: `experimental` is intentionally-replicated
    // preference data and must not be caught by the scrub.
    expect(blob.experimental).toEqual(PREFERENCES.experimental)
    // The two nested groups the secrets were REMOVED FROM keep their preference
    // members: `telegramChatId` is per-user routing that sat in the same object
    // as the bot token, and losing it would silently unroute every notification.
    expect(blob.notifications).toEqual(PREFERENCES.notifications)
    expect(blob.integrations).toEqual(PREFERENCES.integrations)
  })
})

describe('the edges an upgrade actually meets', () => {
  it('a corrupt settings blob does not wedge boot', () => {
    // `SettingsRepository.getSettings` already reads a corrupt row as defaults,
    // so a migration that aborted on one would refuse to boot an instance the
    // running server tolerates.
    const db = openDatabase(':memory:')
    runDrizzleMigrations(db, DRIZZLE_MIGRATIONS.slice(0, cutIndex()))
    db.prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)').run(
      'settings',
      'not json at all',
    )

    expect(() => runDrizzleMigrations(db, DRIZZLE_MIGRATIONS)).not.toThrow()
    expect(db.prepare('SELECT count(*) c FROM server_secrets').get()).toEqual({ c: 0 })
    // …and the row is left exactly as found rather than being replaced with a
    // default: an operator's unparseable settings are still their data.
    expect(db.prepare(`SELECT value FROM meta WHERE key = 'settings'`).get()).toEqual({
      value: 'not json at all',
    })
  })

  it('an instance that never wrote settings migrates to an empty store', () => {
    const db = openDatabase(':memory:')
    runDrizzleMigrations(db, DRIZZLE_MIGRATIONS.slice(0, cutIndex()))
    expect(db.prepare(`SELECT value FROM meta WHERE key = 'settings'`).get()).toBeUndefined()

    runDrizzleMigrations(db, DRIZZLE_MIGRATIONS)
    expect(tableExists(db, 'server_secrets')).toBe(true)
    expect(db.prepare('SELECT count(*) c FROM server_secrets').get()).toEqual({ c: 0 })
  })

  it('a blob missing a whole secret group is not an error', () => {
    const db = preMigrationDb({ sidebar: PREFERENCES.sidebar, apiKeys: { openai: 'sk-lonely' } })
    runDrizzleMigrations(db, DRIZZLE_MIGRATIONS)

    expect(db.prepare('SELECT key, value FROM server_secrets').all()).toEqual([
      { key: 'apiKeys.openai', value: 'sk-lonely' },
    ])
    expect(rawBlob(db).sidebar).toEqual(PREFERENCES.sidebar)
  })
})

describe('the repository reads what the migration wrote', () => {
  it('serves each lifted value under its own key, and nothing for an absent one', () => {
    const db = preMigrationDb({
      ...PREFERENCES,
      apiKeys: { openai: SEEDED['apiKeys.openai'], anthropic: '', openrouter: '' },
    })
    runDrizzleMigrations(db, DRIZZLE_MIGRATIONS)
    const secrets = new ServerSecretsRepository(db)

    // The POSITIVE control beside the negative: a repository that returned
    // `undefined` for everything would satisfy the absence assertion alone.
    expect(secrets.get('apiKeys.openai')).toBe(SEEDED['apiKeys.openai'])
    expect(secrets.get('apiKeys.anthropic')).toBeUndefined()
    expect(secrets.getOrEmpty('apiKeys.anthropic')).toBe('')
  })

  it('reports presence for every key in the vocabulary, values for none', () => {
    const db = preMigrationDb()
    runDrizzleMigrations(db, DRIZZLE_MIGRATIONS)

    const presence = new ServerSecretsRepository(db).presence()
    expect(presence.map((p) => p.key).sort()).toEqual([...SERVER_SECRET_KEYS].sort())
    expect(presence.every((p) => p.present)).toBe(true)
    // The projection has no value key BY CONSTRUCTION (it is a separate shape,
    // not a `pick`), so this asserts the serialized truth rather than the type.
    const serialized = JSON.stringify(presence)
    for (const value of Object.values(SEEDED)) expect(serialized).not.toContain(value)
  })

  it('a cleared secret leaves no row, and a blank write is a clear', () => {
    const db = preMigrationDb()
    runDrizzleMigrations(db, DRIZZLE_MIGRATIONS)
    const secrets = new ServerSecretsRepository(db)

    secrets.clear('apiKeys.openai')
    expect(secrets.get('apiKeys.openai')).toBeUndefined()
    expect(secrets.presence().find((p) => p.key === 'apiKeys.openai')?.present).toBe(false)

    // A blank must not create a row that reads as configured.
    secrets.set('apiKeys.openai', '', '2026-07-31T00:00:00.000Z')
    expect(secrets.presence().find((p) => p.key === 'apiKeys.openai')?.present).toBe(false)

    // …and the positive control: a real write DOES land, so the two assertions
    // above are not satisfied by a store that never writes anything.
    secrets.set('apiKeys.openai', 'sk-rotated', '2026-07-31T00:00:00.000Z')
    expect(secrets.get('apiKeys.openai')).toBe('sk-rotated')
    expect(secrets.updatedAt('apiKeys.openai')).toBe('2026-07-31T00:00:00.000Z')
  })
})
