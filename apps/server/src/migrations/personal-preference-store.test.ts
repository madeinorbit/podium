/**
 * THE LIVE-UPGRADE CONTINUITY TEST for the personal-preference move (POD-1213).
 *
 * The migration copies twenty-four values out of a JSON blob into a
 * `(user_id, key)` table and then removes them from the blob. That is a backfill
 * followed by a delete — the POD-1076 shape, which shipped as three correctly
 * shaped EMPTY tables with no error and total silent loss, and the POD-419 shape
 * after it. The bar is therefore not "it does not error": it is that each
 * specific value is observed to ARRIVE, under the RIGHT KEY, WITH ITS JSON TYPE
 * INTACT, and to be GONE from where it was.
 *
 * ---------------------------------------------------------------------------
 * THE FIXTURE TRAPS THIS AVOIDS, NAMED
 * ---------------------------------------------------------------------------
 *
 * 1. A database with no `__drizzle_migrations` ledger is not an OLD database —
 *    it is one drizzle has never seen, so the migrator replays the baseline and
 *    the test silently exercises FIRST BOOT instead of an upgrade (POD-305).
 *    Every case rewinds a REAL database by applying the manifest up to but not
 *    including this migration, and asserts the ledger exists.
 * 2. A fixture of default values passes whether the migration lifted the blob's
 *    values or wrote the shape's defaults. EVERY seeded value below is
 *    DISTINCT and NON-DEFAULT, and every assertion is BY KEY AND VALUE — never a
 *    count. Eighteen of the twenty-four leaves are strings out of one blob, so a
 *    mis-keyed lift is invisible to every schema, NOT NULL and count check there
 *    is; the swapped-pair mutant has to fail on the pairwise comparison.
 * 3. A fixture with only personal keys would pass a migration that replaced the
 *    whole `meta['settings']` row. The blob carries INSTANCE-tier preferences
 *    too, and they are asserted to survive UNCHANGED and IN PLACE — this
 *    migration moves twenty-four leaves, not the blob.
 * 4. A string-only fixture cannot see the `->` vs `->>` distinction. Booleans and
 *    an array are seeded on purpose: `->>` would deliver `true` as the integer 1
 *    and `["a","b"]` as something `JSON.parse` cannot round-trip, and no count,
 *    schema or NOT NULL assertion would notice.
 *
 * NOT ASSERTED: that this migration is LAST. Siblings land migrations
 * concurrently, and pinning "last" makes a green test a function of merge order.
 */

import { FIRST_ADMIN_USER_ID, settingsPathsInTier } from '@podium/model'
import { openDatabase } from '@podium/runtime/sqlite'
import { describe, expect, it } from 'vitest'
import { UserPreferencesRepository } from '../store/user-preferences'
import { DRIZZLE_MIGRATIONS } from './drizzle-manifest.generated'
import { runDrizzleMigrations } from './index'

const MIGRATION = 'personal-preference-store'

/**
 * The keys the migration's SQL spells out, transcribed. Asserted below to equal
 * POD-418's shipped classification — this is where the frozen-history literals
 * and the live vocabulary are tied together, and a personal preference added to
 * the model with no migration to lift it fails HERE rather than silently staying
 * in the blob forever.
 */
const LIFTED_KEYS = [
  'roles.coding.accountId',
  'roles.coding.model',
  'roles.coding.effort',
  'roles.coding.harness',
  'roles.coding.subagentModel',
  'roles.coding.subagentStrategy',
  'roles.coding.startScreen',
  'roles.coding.seedCliTheme',
  'roles.superagent.accountId',
  'roles.superagent.model',
  'roles.superagent.effort',
  'roles.superagent.harness',
  'roles.background.accountId',
  'roles.background.model',
  'roles.background.effort',
  'roles.background.harness',
  'sidebar.repoSort',
  'sidebar.repoOrder',
  'sidebar.groupByRepo',
  'autoContinue.enabled',
  'autoContinue.promptDismissed',
  'notifications.web',
  'notifications.ntfyTopic',
  'notifications.telegramChatId',
] as const

/**
 * DISTINCT per key, NON-DEFAULT, and recognisable in a failure message.
 *
 * Same-typed neighbours are given different values on purpose (`roles.*.model`,
 * `roles.*.effort`, the three account ids): a swap between two of them is the
 * mutant no schema assertion can see, and it is the one an operator would
 * experience as their superagent silently running the background role's model.
 */
const SEEDED: Readonly<Record<(typeof LIFTED_KEYS)[number], unknown>> = {
  'roles.coding.accountId': 'native:claude-code',
  'roles.coding.model': 'DISTINCT-coding-model',
  'roles.coding.effort': 'DISTINCT-coding-effort',
  'roles.coding.harness': 'claude',
  'roles.coding.subagentModel': 'DISTINCT-subagent-model',
  'roles.coding.subagentStrategy': 'podium',
  'roles.coding.startScreen': 'chat',
  'roles.coding.seedCliTheme': false,
  'roles.superagent.accountId': 'native:codex',
  'roles.superagent.model': 'DISTINCT-superagent-model',
  'roles.superagent.effort': 'DISTINCT-superagent-effort',
  'roles.superagent.harness': 'codex',
  'roles.background.accountId': 'managed:anthropic',
  'roles.background.model': 'DISTINCT-background-model',
  'roles.background.effort': 'DISTINCT-background-effort',
  'roles.background.harness': 'grok',
  'sidebar.repoSort': 'alphabetical',
  // An ARRAY. `->>` would flatten it; `->` keeps it parseable.
  'sidebar.repoOrder': ['/repo/DISTINCT-a', '/repo/DISTINCT-b'],
  'sidebar.groupByRepo': true,
  'autoContinue.enabled': true,
  'autoContinue.promptDismissed': false,
  // BOOLEAN beside boolean: a lift that wrote 0/1 integers passes a "the row
  // exists" check and fails `JSON.parse` round-tripping.
  'notifications.web': true,
  'notifications.ntfyTopic': 'DISTINCT-ntfy-topic',
  'notifications.telegramChatId': '-100DISTINCT',
}

/** INSTANCE-tier preferences, seeded beside the personal ones so "the migration
 *  replaced the row" is distinguishable from "the migration removed twenty-four
 *  members of it". Every one of these must survive untouched. */
const INSTANCE = {
  hibernation: { enabled: false, memoryPct: 73, maxIdleSessions: 7, idleMinutes: 11 },
  gitWorkflow: { defaultParentBranch: 'develop', mergeStyle: 'pr', autoRebaseBeforeMerge: false },
  issues: { assistantEnabled: false },
  steward: { enabled: false },
  experimental: { 'feature.someFlag': true },
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
 *  `normalizeSettings`, which would fill the defaults back in and make a removed
 *  key indistinguishable from one that was never touched. */
const rawBlob = (db: Db): Record<string, unknown> => {
  const row = db.prepare(`SELECT value FROM meta WHERE key = 'settings'`).get() as
    | { value: string }
    | undefined
  expect(row).toBeDefined()
  return JSON.parse((row as { value: string }).value)
}

/** The seeded preferences in the NESTED shape the legacy blob holds them in. */
function nestedBlob(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const out: Record<string, unknown> = { ...INSTANCE }
  for (const key of LIFTED_KEYS) {
    const segments = key.split('.')
    let node = out
    for (const segment of segments.slice(0, -1)) {
      node[segment] ??= {}
      node = node[segment] as Record<string, unknown>
    }
    node[segments[segments.length - 1] as string] = SEEDED[key]
  }
  return { ...out, ...overrides }
}

/** A real pre-migration database: every migration before this one applied, with
 *  a real drizzle ledger, and the pre-state asserted rather than assumed. */
function preMigrationDb(blob: unknown = nestedBlob()): Db {
  const db = openDatabase(':memory:')
  runDrizzleMigrations(db, DRIZZLE_MIGRATIONS.slice(0, cutIndex()))

  // THE PRE-STATE. If the table already existed, this test would be measuring a
  // database that had already been migrated.
  expect(tableExists(db, 'user_preferences')).toBe(false)
  // …and the ledger really is there, so the run below applies ONE migration
  // rather than replaying the baseline onto a virgin file.
  expect(tableExists(db, '__drizzle_migrations')).toBe(true)

  db.prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)').run(
    'settings',
    JSON.stringify(blob),
  )
  return db
}

const migrated = (blob?: unknown): Db => {
  const db = blob === undefined ? preMigrationDb() : preMigrationDb(blob)
  runDrizzleMigrations(db, DRIZZLE_MIGRATIONS)
  return db
}

describe('the migration moves the keys the model classifies — no second list', () => {
  it('the literals the SQL spells out ARE POD-418’s shipped classification', () => {
    // The frozen-history literals are pinned to the live classification HERE and
    // nowhere else. A personal preference added to `PersonalPreferences` with no
    // migration to lift it fails this, instead of quietly remaining in the blob.
    expect([...LIFTED_KEYS].sort()).toEqual([...settingsPathsInTier('personal-preference')].sort())
    // Twenty-four, asserted, so a classification that collapsed to a handful
    // would not make this suite pass by checking almost nothing.
    expect(LIFTED_KEYS).toHaveLength(24)
  })

  it('the fixture can SEE a swap: every string is distinct, and sibling booleans differ', () => {
    // The non-vacuity guard for every assertion below. A fixture of identical or
    // default values makes a mis-keyed lift indistinguishable from a correct one.
    //
    // Strings carry the burden because eighteen of the twenty-four leaves are
    // strings and every one of them is a plausible swap partner. Booleans cannot
    // all differ — there are only two — so the property asserted for them is the
    // one that actually catches a swap: two booleans under the SAME parent hold
    // OPPOSITE values, and no other boolean shares a parent with one.
    const strings = LIFTED_KEYS.filter((k) => typeof SEEDED[k] === 'string').map((k) => SEEDED[k])
    expect(strings.length).toBe(18)
    expect(new Set(strings).size).toBe(strings.length)
    expect(SEEDED['autoContinue.enabled']).not.toBe(SEEDED['autoContinue.promptDismissed'])
    const booleans = LIFTED_KEYS.filter((k) => typeof SEEDED[k] === 'boolean')
    const parents = booleans.map((k) => k.split('.').slice(0, -1).join('.'))
    // `sidebar.groupByRepo`, `roles.coding.seedCliTheme` and `notifications.web`
    // are each the only boolean under their parent; the autoContinue pair is the
    // one that shares, and it is asserted opposite above.
    expect(parents.filter((p) => p === 'autoContinue')).toHaveLength(2)
    expect(new Set(parents).size).toBe(parents.length - 1)
  })
})

describe('the COPY happens, and lands under the right key with the right type', () => {
  it('carries every configured preference across BY KEY AND VALUE', () => {
    const db = migrated()
    const rows = db.prepare('SELECT key, value FROM user_preferences ORDER BY key').all() as {
      key: string
      value: string
    }[]

    // Pairwise, not by count and not by set-of-values: two same-typed strings
    // swapped between keys satisfies every count assertion and every NOT NULL
    // constraint, and leaves the operator's superagent running the background
    // role's model. This is the assertion the swap mutant has to fail.
    expect(Object.fromEntries(rows.map((r) => [r.key, JSON.parse(r.value)]))).toEqual(SEEDED)
  })

  it('keeps JSON TYPES — booleans are booleans and the array is an array', () => {
    // The `->` vs `->>` property, asserted as types rather than as values so it
    // cannot pass on a stringified `"true"`.
    const prefs = new UserPreferencesRepository(migrated())
    expect(prefs.get(FIRST_ADMIN_USER_ID, 'autoContinue.enabled')).toBe(true)
    expect(prefs.get(FIRST_ADMIN_USER_ID, 'notifications.web')).toBe(true)
    expect(prefs.get(FIRST_ADMIN_USER_ID, 'autoContinue.promptDismissed')).toBe(false)
    expect(prefs.get(FIRST_ADMIN_USER_ID, 'roles.coding.seedCliTheme')).toBe(false)
    expect(prefs.get(FIRST_ADMIN_USER_ID, 'sidebar.repoOrder')).toEqual([
      '/repo/DISTINCT-a',
      '/repo/DISTINCT-b',
    ])
  })

  it('gives every row the FIRST ADMIN as its owner — backfilled, not dropped', () => {
    const db = migrated()
    const owners = db.prepare('SELECT DISTINCT user_id FROM user_preferences').all() as {
      user_id: string
    }[]
    expect(owners).toEqual([{ user_id: 'user:sole' }])
    // The migration's frozen literal and the shipped constant are the same id.
    // Asserted here rather than by importing it into the SQL, so a rename is
    // CAUGHT rather than silently followed.
    expect(owners[0]?.user_id).toBe(FIRST_ADMIN_USER_ID)
  })

  it('stamps a write time the blob never had', () => {
    const db = migrated()
    const rows = db.prepare('SELECT updated_at FROM user_preferences').all() as {
      updated_at: string
    }[]
    expect(rows).toHaveLength(LIFTED_KEYS.length)
    // ISO-8601 with a Z, matching every other timestamp column — `datetime('now')`
    // would write the space-separated form that string comparison sorts wrongly.
    for (const row of rows) expect(row.updated_at).toMatch(/^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/)
  })

  it('a path the blob never held becomes NO ROW, not a null one', () => {
    // Absence is the row being absent — the property that lets the resolver fall
    // back to the blob without having to distinguish a stored default from a
    // choice. A blob written by an older build simply has fewer rows.
    const db = migrated({ ...INSTANCE, sidebar: { repoSort: 'alphabetical' } })
    const keys = (
      db.prepare('SELECT key FROM user_preferences ORDER BY key').all() as { key: string }[]
    ).map((r) => r.key)
    expect(keys).toEqual(['sidebar.repoSort'])
  })

  it('an EMPTY STRING is a real preference and DOES become a row', () => {
    // Unlike POD-419's secrets, where `''` meant "not configured": an empty ntfy
    // topic means "mobile push off", which is a choice this person made.
    const db = migrated(nestedBlob({ notifications: { ntfyTopic: '', web: true } }))
    const prefs = new UserPreferencesRepository(db)
    expect(prefs.get(FIRST_ADMIN_USER_ID, 'notifications.ntfyTopic')).toBe('')
  })

  it('survives a corrupt blob instead of wedging boot', () => {
    const db = openDatabase(':memory:')
    runDrizzleMigrations(db, DRIZZLE_MIGRATIONS.slice(0, cutIndex()))
    db.prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)').run(
      'settings',
      'not json at all',
    )
    expect(() => runDrizzleMigrations(db, DRIZZLE_MIGRATIONS)).not.toThrow()
    expect(db.prepare('SELECT COUNT(*) AS n FROM user_preferences').get()).toEqual({ n: 0 })
  })
})

describe('the CLEAR happens, and takes exactly the personal leaves', () => {
  it('removes every personal MEMBER from the blob — the key is gone, not blanked', () => {
    const blob = rawBlob(migrated())
    // Gone, so nothing serves another user's value as a fallback: the leak is
    // closed AT REST, not filtered on the way out.
    expect(blob.roles).toEqual({ coding: {}, superagent: {}, background: {} })
    expect(blob.sidebar).toEqual({})
    expect(blob.autoContinue).toEqual({})
    expect(blob.notifications).toEqual({})
  })

  it('leaves every INSTANCE-tier preference exactly where it was', () => {
    // Twenty-four leaves moved, not the blob. A migration that took the whole
    // `settings` row — or one path too many — fails here.
    const blob = rawBlob(migrated())
    expect(blob.hibernation).toEqual(INSTANCE.hibernation)
    expect(blob.gitWorkflow).toEqual(INSTANCE.gitWorkflow)
    expect(blob.issues).toEqual(INSTANCE.issues)
    expect(blob.steward).toEqual(INSTANCE.steward)
    expect(blob.experimental).toEqual(INSTANCE.experimental)
  })

  it('every value that left the blob is present in the table — nothing is dropped in transit', () => {
    // The COPY-BEFORE-CLEAR property stated as one assertion over both halves:
    // for each key, gone from the blob AND present in the table with its value.
    // Deleting the INSERT..SELECT leaves the DDL, the CLEAR and three green
    // structural checks — and fails this.
    const db = migrated()
    const prefs = new UserPreferencesRepository(db)
    const blob = rawBlob(db)
    for (const key of LIFTED_KEYS) {
      const segments = key.split('.')
      let cursor: unknown = blob
      for (const segment of segments) {
        cursor = (cursor as Record<string, unknown> | undefined)?.[segment]
      }
      expect(cursor, `${key} should be gone from the blob`).toBeUndefined()
      expect(prefs.get(FIRST_ADMIN_USER_ID, key), `${key} should be in user_preferences`).toEqual(
        SEEDED[key],
      )
    }
  })
})
