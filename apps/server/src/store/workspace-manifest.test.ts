import * as identitySchema from '@podium/identity/schema/sqlite'
import { SERVER_SECRET_KEYS } from '@podium/model'
import {
  INSTALLATION_META_KEY,
  INSTALLATION_PRIVATE_KEY,
} from '@podium/runtime/installation-identity'
import { is } from 'drizzle-orm'
import { getTableConfig, SQLiteTable } from 'drizzle-orm/sqlite-core'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import * as syncSchema from '../../../../packages/sync/src/adapters/sqlite/schema'
import { LEDGER_IMPORT_MARKER, RETIRED_MEMBER_MAPPING } from '../enrollment-ledger-import'
import { FINGERPRINT_IMPORT_MARKER, FINGERPRINT_SECRET_KEY } from '../fingerprint-key-import'
import { INSTALLATION_IMPORT_MARKER } from '../installation-identity-import'
import * as legacyImportSchema from '../migrations/identity-import-schema'
import * as serverSchema from '../migrations/schema'
import { SETTINGS_CONFIG_IMPORT } from '../settings-config-import'
import type { SessionStore } from '../store'
import { forceFeature } from '../test-support/features'
import { openTestStore } from '../test-support/open-test-store'
import { LEGACY_WORKTREE_MIGRATION } from './issues'
import { IDENTITY_SIGNING_SECRET_KEY } from './server-secrets'
import { CARRY_OVER_ENDS_AT_KEY } from './sign-in-carry-over'
import {
  classifyTable,
  INSTALL_META_KEYS,
  INSTALL_SECRET_KEYS,
  INSTALL_TABLE_EXPORTS,
  INSTALL_TABLES,
  type KeyPattern,
  keyIn,
  type ManifestEntry,
  TABLE_MANIFEST,
  WORKSPACE_META_KEYS,
  WORKSPACE_SECRET_KEYS,
  WORKSPACE_TABLES,
} from './workspace-manifest'

/**
 * THE MANIFEST COVERS EVERY TABLE (POD-6959 design 2.1, appendix A).
 *
 * The workspace audit and the global table type decide per table from the manifest, so a
 * table it does not list is a table nobody checked. Two sources say which tables exist: the
 * three Drizzle schemas (what the migration chain creates, plus the pre-upgrade shapes the boot
 * identity import declares) and `sqlite_master` of a freshly migrated database with search on
 * (which adds what the store and the engine create at boot).
 * Both must be fully classified, and every classified table must still exist in the source its
 * origin names.
 */

/** `legacy` is migrations/identity-import-schema.ts; the others are the current schemas. */
type SchemaSource = 'server' | 'sync' | 'identity' | 'legacy'

interface DeclaredTable {
  readonly schema: SchemaSource
  readonly exportName: string
  readonly table: SQLiteTable
}

/** Every table the schemas declare, by SQL name; the identity tables appear twice. */
function declaredTables(): Map<string, DeclaredTable> {
  const found = new Map<string, DeclaredTable>()
  const modules = [
    ['server', serverSchema],
    ['sync', syncSchema],
    ['identity', identitySchema],
    ['legacy', legacyImportSchema],
  ] as const
  for (const [schema, mod] of modules) {
    for (const [exportName, value] of Object.entries(mod)) {
      if (!is(value, SQLiteTable)) continue
      const { name } = getTableConfig(value)
      if (!found.has(name)) found.set(name, { schema, exportName, table: value })
    }
  }
  return found
}

type Classify = (name: string) => ManifestEntry | undefined

interface Gaps {
  /** Declared in a schema but not classified. */
  readonly unclassifiedDeclared: string[]
  /** In the migrated database but not classified. */
  readonly unclassifiedLive: string[]
  /** Classified as declared in a schema (current or legacy), and that schema does not declare it. */
  readonly missingDeclared: string[]
  /** Classified as created at boot or by the engine, required, and not in the database. */
  readonly missingLive: string[]
  /** Classified with the wrong origin: a declared table listed as runtime, a created planned table. */
  readonly wrongOrigin: string[]
}

/** Compare a manifest with the declared and live table names. Pure, so a plant can drive it. */
function findGaps(
  manifest: Readonly<Record<string, ManifestEntry>>,
  classify: Classify,
  declared: ReadonlyMap<string, SchemaSource>,
  live: ReadonlySet<string>,
): Gaps {
  const unclassifiedDeclared = [...declared.keys()].filter((name) => classify(name) === undefined)
  const unclassifiedLive = [...live].filter((name) => classify(name) === undefined)
  const missingDeclared: string[] = []
  const missingLive: string[] = []
  const wrongOrigin: string[] = []
  for (const [name, entry] of Object.entries(manifest)) {
    switch (entry.origin) {
      case 'schema':
      case 'legacy': {
        const source = declared.get(name)
        if (source === undefined) missingDeclared.push(name)
        else if ((source === 'legacy') !== (entry.origin === 'legacy')) wrongOrigin.push(name)
        break
      }
      case 'runtime':
      case 'engine':
        if (declared.has(name)) wrongOrigin.push(name)
        else if (entry.mayBeAbsent === undefined && !live.has(name)) missingLive.push(name)
        break
      case 'planned':
        // The task that creates it switches it to 'schema'.
        if (declared.has(name) || live.has(name)) wrongOrigin.push(name)
        break
    }
  }
  return {
    unclassifiedDeclared: unclassifiedDeclared.sort(),
    unclassifiedLive: unclassifiedLive.sort(),
    missingDeclared: missingDeclared.sort(),
    missingLive: missingLive.sort(),
    wrongOrigin: wrongOrigin.sort(),
  }
}

const NO_GAPS: Gaps = {
  unclassifiedDeclared: [],
  unclassifiedLive: [],
  missingDeclared: [],
  missingLive: [],
  wrongOrigin: [],
}

interface RawDb {
  prepare(sql: string): { all(...params: unknown[]): unknown[]; run(...params: unknown[]): unknown }
}
const rawDb = (store: SessionStore): RawDb => (store as unknown as { db: RawDb }).db

const liveTables = (db: RawDb): Set<string> =>
  new Set(
    (
      db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]
    ).map((row) => row.name),
  )

const manifest = TABLE_MANIFEST as Readonly<Record<string, ManifestEntry>>

describe('workspace table manifest', () => {
  let store: SessionStore
  let db: RawDb
  const declared = declaredTables()
  const declaredSources = new Map([...declared].map(([name, table]) => [name, table.schema]))
  const plus = (name: string, source: SchemaSource) => new Map([...declaredSources, [name, source]])

  beforeAll(async () => {
    // Search is a boot-time switch; on, the store also builds the FTS tables (PDM-25).
    forceFeature('command-palette', true)
    store = await openTestStore()
    db = rawDb(store)
  })
  afterAll(async () => {
    await store.close()
  })

  it('reads all three schemas and the legacy import shapes', () => {
    const bySchema = (schema: string) =>
      [...declared.values()].filter((table) => table.schema === schema).length
    expect(bySchema('server')).toBeGreaterThan(90)
    expect(bySchema('sync')).toBeGreaterThan(0)
    // The identity tables are re-exported by the server schema, so the server finds them first.
    expect(declared.get('identity_user')?.schema).toBe('server')
    expect(declared.has('changes')).toBe(true)
    expect(declared.get('user_credentials')?.schema).toBe('legacy')
  })

  it('classifies every declared table and every table of a migrated database, and lists none that is gone', () => {
    const live = liveTables(db)
    expect(live.has('conversations_fts')).toBe(true)
    expect(findGaps(manifest, classifyTable, declaredSources, live)).toEqual(NO_GAPS)
  })

  it('fails on a planted unclassified table, declared or live', () => {
    db.prepare('CREATE TABLE planted_unclassified (id TEXT PRIMARY KEY)').run()
    try {
      const live = liveTables(db)
      const gaps = findGaps(manifest, classifyTable, plus('planted_declared', 'server'), live)
      expect(gaps.unclassifiedDeclared).toEqual(['planted_declared'])
      expect(gaps.unclassifiedLive).toEqual(['planted_unclassified'])
    } finally {
      db.prepare('DROP TABLE planted_unclassified').run()
    }
  })

  it('does not treat a lookalike of an FTS shadow table as classified', () => {
    expect(classifyTable('conversations_fts_data')).toBe(TABLE_MANIFEST.conversations_fts)
    expect(classifyTable('issues_data')).toBeUndefined()
    expect(classifyTable('conversations_data')).toBeUndefined()
  })

  it('fails on a planted classified table that no longer exists', () => {
    const planted: Record<string, ManifestEntry> = {
      ...manifest,
      planted_gone_schema: {
        class: 'workspace',
        origin: 'schema',
        idgen: 'random',
        reason: 'plant',
      },
      planted_gone_runtime: {
        class: 'derived',
        origin: 'runtime',
        idgen: 'natural',
        reason: 'plant',
      },
      planted_optional: {
        class: 'transient',
        origin: 'engine',
        idgen: 'natural',
        reason: 'plant',
        mayBeAbsent: 'plant',
      },
      planted_created: { class: 'workspace', origin: 'planned', idgen: 'natural', reason: 'plant' },
      planted_not_legacy: { class: 'install', origin: 'legacy', idgen: 'natural', reason: 'plant' },
    }
    const classify: Classify = (name) => planted[name] ?? classifyTable(name)
    const gaps = findGaps(
      planted,
      classify,
      new Map([...plus('planted_created', 'server'), ['planted_not_legacy', 'server']]),
      liveTables(db),
    )
    expect(gaps).toEqual({
      ...NO_GAPS,
      missingDeclared: ['planted_gone_schema'],
      missingLive: ['planted_gone_runtime'],
      wrongOrigin: ['planted_created', 'planted_not_legacy'],
    })
  })

  it('splits the classes into the workspace and install sets', () => {
    for (const name of WORKSPACE_TABLES) expect(manifest[name]?.class).toBe('workspace')
    for (const name of INSTALL_TABLES) expect(manifest[name]?.class).toBe('install')
    expect(WORKSPACE_TABLES.has('issues')).toBe(true)
    expect(WORKSPACE_TABLES.has('workspace_meta')).toBe(true)
    expect([...INSTALL_TABLES].sort()).toEqual([
      '__drizzle_migrations',
      'feed_identity',
      'maintenance_leases',
      'member_invites',
      'meta',
      'schema_version',
      'server_secrets',
      'user_credentials',
    ])
  })

  it('names the schema export of every install table a current schema declares', () => {
    const declaredInstall = [...declared.entries()]
      .filter(([name, table]) => manifest[name]?.class === 'install' && table.schema !== 'legacy')
      .map(([name, table]) => [name, table.exportName] as const)
      .sort(([a], [b]) => a.localeCompare(b))
    const listed = Object.entries(INSTALL_TABLE_EXPORTS).sort(([a], [b]) => a.localeCompare(b))
    expect(listed).toEqual(declaredInstall)
  })

  const liveWorkspaceColumn = (name: string): { not_null: number; pk: number } | undefined =>
    (
      db
        .prepare(
          `SELECT "notnull" AS not_null, pk FROM pragma_table_info(?) WHERE name = 'workspace_id'`,
        )
        .all(name) as { not_null: number; pk: number }[]
    )[0]

  /**
   * `sync_feed.workspace_id` is its text PRIMARY KEY, renamed in place from
   * `tenant_id` (POD-7012), and was declared without NOT NULL. SQLite's legacy
   * rule lets a non-INTEGER primary key hold NULL, and adding NOT NULL takes a
   * table rebuild, which the keys migration (POD-7024) does. Until then a
   * primary key column counts as the non-null column; nothing writes a NULL
   * workspace (the provisioning insert names it).
   */
  const nonNullLive = (column: { not_null: number; pk: number } | undefined) =>
    column !== undefined && (column.not_null === 1 || column.pk > 0)

  it('keeps a pending workspace column marker only while the column is missing', () => {
    const marked = Object.entries(manifest).filter(([, entry]) => entry.workspaceColumnPending)
    expect(marked.map(([name]) => name)).toEqual(['transcript_fts_keys'])
    for (const [name, entry] of marked) {
      expect(entry.class).toBe('workspace')
      // The task that adds the column removes the marker; this fails until it does.
      expect(liveWorkspaceColumn(name)).toBeUndefined()
    }
  })

  // The column migration (POD-7012) added it to every declared workspace table.
  it('gives every workspace table a non-null workspace_id column', () => {
    const missing: string[] = []
    for (const name of WORKSPACE_TABLES) {
      const entry: ManifestEntry = manifest[name] as ManifestEntry
      if (entry.origin === 'planned' || entry.workspaceColumnPending) continue
      const table = declared.get(name)
      // A runtime table has no Drizzle declaration; only its live column is checked.
      const declaredOk =
        table === undefined
          ? entry.origin === 'runtime'
          : getTableConfig(table.table).columns.find((c) => c.name === 'workspace_id')?.notNull ===
            true
      if (!declaredOk || !nonNullLive(liveWorkspaceColumn(name))) missing.push(name)
    }
    expect(missing).toEqual([])
  })

  // ---- the install halves of meta and server_secrets (POD-7013) ----

  const keysIn = (table: 'meta' | 'server_secrets'): string[] =>
    (db.prepare(`SELECT key FROM ${table} ORDER BY key`).all() as { key: string }[]).map(
      (row) => row.key,
    )

  /** The keys of `table` that its install list does not name. */
  const strayKeys = (table: 'meta' | 'server_secrets', install: readonly KeyPattern[]) =>
    keysIn(table).filter((key) => !keyIn(install, key))

  it('holds only install keys in meta and server_secrets of a migrated, booted database', () => {
    // Non-vacuous: the boot wrote install keys, and the workspace's went to the new tables.
    expect(keysIn('meta')).toContain(INSTALLATION_META_KEY)
    expect(keysIn('server_secrets')).toContain(INSTALLATION_PRIVATE_KEY)
    const workspaceKeys = (
      db.prepare('SELECT key FROM workspace_meta').all() as { key: string }[]
    ).map((row) => row.key)
    expect(workspaceKeys).toContain('settings')
    expect(strayKeys('meta', INSTALL_META_KEYS)).toEqual([])
    expect(strayKeys('server_secrets', INSTALL_SECRET_KEYS)).toEqual([])
  })

  it('fails on a planted workspace key in meta or server_secrets', () => {
    db.prepare("INSERT INTO meta (key, value) VALUES ('model_catalog:planted', '{}')").run()
    db.prepare(
      "INSERT INTO server_secrets (key, value, updated_at) VALUES ('notifications.telegramBotToken', 'planted', 'now')",
    ).run()
    try {
      expect(strayKeys('meta', INSTALL_META_KEYS)).toEqual(['model_catalog:planted'])
      expect(strayKeys('server_secrets', INSTALL_SECRET_KEYS)).toEqual([
        'notifications.telegramBotToken',
      ])
    } finally {
      db.prepare("DELETE FROM meta WHERE key = 'model_catalog:planted'").run()
      db.prepare("DELETE FROM server_secrets WHERE key = 'notifications.telegramBotToken'").run()
    }
  })

  it("lists the code's keys in the right list, and no key in both", () => {
    const installMeta = [
      INSTALLATION_META_KEY,
      INSTALLATION_IMPORT_MARKER,
      SETTINGS_CONFIG_IMPORT,
      FINGERPRINT_IMPORT_MARKER,
      LEDGER_IMPORT_MARKER,
      LEGACY_WORKTREE_MIGRATION,
    ]
    for (const key of installMeta) expect(keyIn(INSTALL_META_KEYS, key), key).toBe(true)
    for (const key of [RETIRED_MEMBER_MAPPING, CARRY_OVER_ENDS_AT_KEY, 'settings'])
      expect(keyIn(WORKSPACE_META_KEYS, key), key).toBe(true)
    for (const key of [INSTALLATION_PRIVATE_KEY, IDENTITY_SIGNING_SECRET_KEY])
      expect(keyIn(INSTALL_SECRET_KEYS, key), key).toBe(true)
    for (const key of [...SERVER_SECRET_KEYS, FINGERPRINT_SECRET_KEY])
      expect(keyIn(WORKSPACE_SECRET_KEYS, key), key).toBe(true)
    const named = (patterns: readonly KeyPattern[]) =>
      patterns.map((p) => ('key' in p ? p.key : `${p.prefix}x`))
    for (const key of named(INSTALL_META_KEYS))
      expect(keyIn(WORKSPACE_META_KEYS, key), key).toBe(false)
    for (const key of named(WORKSPACE_META_KEYS))
      expect(keyIn(INSTALL_META_KEYS, key), key).toBe(false)
    for (const key of named(INSTALL_SECRET_KEYS))
      expect(keyIn(WORKSPACE_SECRET_KEYS, key), key).toBe(false)
    for (const key of named(WORKSPACE_SECRET_KEYS))
      expect(keyIn(INSTALL_SECRET_KEYS, key), key).toBe(false)
  })
})
