/**
 * THE WRITE CENSUS: EVERY POSTGRES WRITE ON A SOURCE TABLE IS A CAPTURE FORM (POD-6982,
 * POD-6958 design 2.5).
 *
 * A trigger catches every write; a capture form only the writes that use it. So every
 * registered query definition (the store's, the sync adapter's, and those of any other
 * server file that defines one) is built, at each family shape, on a Postgres drizzle
 * instance over the Postgres tables (as the dialect census builds them), and its SQL is
 * read for INSERT, UPDATE and DELETE statements on source tables (and on tables whose
 * deletion cascades to one) that are not capture forms (`sync/capture-pg.ts`,
 * `uncapturedWrites`). An update that assigns only columns no source reads is not one:
 * it captures nothing.
 *
 * Until the binding tasks land, their files make plain writes; each file's count is
 * listed with the task that converts it ({@link PENDING_CAPTURE}). The counts must equal
 * what the census finds, so they only fall, and a plain write in any other file fails at
 * once. A planted plain UPDATE of a source table fails the census; the same write
 * through `captureWrite` passes it.
 *
 * Database-free: it opens a SQLite store in memory only to reach the definitions made
 * inside methods. Raw statements outside the query definitions (driver, migrator,
 * backup, repair, the test seeds) are SQLite-only paths and are not read here.
 */

import { readdirSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { SqlDatabase } from '@podium/runtime/sqlite'
import { pgSyncTables } from '@podium/sync/adapters/pg/schema'
import { eq, sql } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import * as pgSchema from '../migrations/pg/schema'
import type { SessionStore } from '../store'
import type { bindingFor } from '../store/executor/binding'
import type { QueryClient } from '../store/executor/driver'
import { buildPgStoreDrizzle } from '../store/executor/pg-drizzle'
import type { StoreDrizzle } from '../store/executor/sync-drizzle'
import {
  FAMILY_SHAPES,
  isFragment,
  type KeyedDefinition,
  keyedDefinitions,
  REPO_ROOT,
  reachMethodDefinitions,
  type SourceTree,
  trackedSources,
} from '../test-support/definition-census'
import { openTestStore } from '../test-support/open-test-store'
import { queryDefinitionSites } from '../test-support/prepared-census'
import { captureWrite, uncapturedWrites } from './capture-pg'

const PG_TABLES = Object.freeze({ ...pgSchema, ...pgSyncTables })
type Tables = ReturnType<typeof bindingFor>

/** A Postgres drizzle instance over the twins whose client refuses to run anything. */
function pgRecordingDrizzle(): StoreDrizzle {
  const refuse = (): never => {
    throw new Error('the write census builds queries; it never runs them')
  }
  const client: QueryClient = {
    run: refuse,
    get: refuse,
    all: refuse,
    writeGet: refuse,
    writeAll: refuse,
    batch: refuse,
  }
  return buildPgStoreDrizzle(client, PG_TABLES)
}

/** The SQL of every statement in what a definition built (a prepared query, a raw one, or a bundle). */
function sqlOf(built: unknown, depth = 0): string[] {
  if (built === null || typeof built !== 'object') return []
  const query = built as { getQuery?: () => { sql: string }; toSQL?: () => { sql: string } }
  if (typeof query.getQuery === 'function') return [query.getQuery().sql]
  if (typeof query.toSQL === 'function' && !isFragment(built)) return [query.toSQL().sql]
  if (depth < 2) return Object.values(built).flatMap((value) => sqlOf(value, depth + 1))
  return []
}

// ---------------------------------------------------------------------------
// The write census
// ---------------------------------------------------------------------------

/**
 * The plain Postgres writes on source tables each binding file still makes, counted by
 * the census, and the task that turns them into capture forms (design section 5). The
 * count must equal what the census finds: a file's count only falls as its task lands,
 * and a write in a file not listed fails at once.
 */
const PENDING_CAPTURE: ReadonlyMap<string, { readonly task: string; readonly writes: number }> =
  new Map([
    ['apps/server/src/store/sessions.ts', { task: 'POD-6983', writes: 29 }],
    ['apps/server/src/store/user-layout.ts', { task: 'POD-6983', writes: 2 }],
    ['apps/server/src/store/user-preferences.ts', { task: 'POD-6983', writes: 2 }],
    ['apps/server/src/store/user-read-position.ts', { task: 'POD-6983', writes: 1 }],
    ['apps/server/src/store/issue-git-states.ts', { task: 'POD-6984', writes: 1 }],
    ['apps/server/src/store/issue-panel.ts', { task: 'POD-6984', writes: 9 }],
    ['apps/server/src/store/issues.ts', { task: 'POD-6984', writes: 16 }],
    ['apps/server/src/store/messages.ts', { task: 'POD-6985', writes: 9 }],
    ['apps/server/src/store/shipping.ts', { task: 'POD-6986', writes: 12 }],
    ['apps/server/src/store/agent-profiles.ts', { task: 'POD-6987', writes: 3 }],
    ['apps/server/src/store/checkouts.ts', { task: 'POD-6987', writes: 3 }],
    ['apps/server/src/store/grants.ts', { task: 'POD-6987', writes: 4 }],
    ['apps/server/src/store/machine-record-context.ts', { task: 'POD-6987', writes: 1 }],
    ['apps/server/src/store/machines.ts', { task: 'POD-6987', writes: 15 }],
    ['apps/server/src/store/repos.ts', { task: 'POD-6987', writes: 7 }],
    ['apps/server/src/store/settings.ts', { task: 'POD-6987', writes: 2 }],
    ['apps/server/src/store/sign-in-carry-over.ts', { task: 'POD-6987', writes: 1 }],
    ['apps/server/src/store/users.ts', { task: 'POD-6987', writes: 2 }],
    // The fleet update checkpoint, an install key of `meta` beside the update-channel context.
    ['apps/server/src/modules/updates/recovery-store.ts', { task: 'POD-6987', writes: 1 }],
    ['apps/server/src/store/automations.ts', { task: 'POD-6988', writes: 6 }],
    ['apps/server/src/store/effects.ts', { task: 'POD-6988', writes: 12 }],
    ['apps/server/src/store/events.ts', { task: 'POD-6988', writes: 6 }],
    ['apps/server/src/store/interactions.ts', { task: 'POD-6988', writes: 9 }],
    ['apps/server/src/store/observation-checkpoints.ts', { task: 'POD-6988', writes: 4 }],
    ['apps/server/src/store/superagent.ts', { task: 'POD-6988', writes: 7 }],
    ['apps/server/src/store/workflows.ts', { task: 'POD-6988', writes: 11 }],
    ['apps/server/src/store/conversations/index.ts', { task: 'POD-6990', writes: 4 }],
    ['apps/server/src/store/conversations/registry.ts', { task: 'POD-6990', writes: 3 }],
  ])

/** One definition's plain writes on source tables, as the census reports them. */
function uncapturedOf(
  keyed: readonly Pick<KeyedDefinition, 'key' | 'definition'>[],
): Map<string, string[]> {
  const db = pgRecordingDrizzle()
  const out = new Map<string, string[]>()
  for (const { key, definition } of keyed) {
    const shapes: readonly (string | number | undefined)[] =
      definition.kind === 'family' ? (FAMILY_SHAPES.get(key) ?? []) : [undefined]
    for (const shape of shapes) {
      let built: unknown
      try {
        built = (definition.build as (db: unknown, key: unknown) => unknown)(db, shape)
      } catch {
        continue // the dialect census reports a definition that does not build on Postgres
      }
      for (const text of sqlOf(built)) {
        for (const write of uncapturedWrites(text)) {
          const line = `${write.op === 'i' ? 'insert into' : write.op === 'u' ? 'update' : 'delete from'} ${write.table}`
          out.set(key, [...new Set([...(out.get(key) ?? []), line])])
        }
      }
    }
  }
  return out
}

const fileOf = (key: string): string => key.slice(0, key.indexOf(':'))

const SOURCE: SourceTree = {
  list: (dir) =>
    readdirSync(join(REPO_ROOT, dir), { recursive: true }).map((entry) =>
      relative(REPO_ROOT, join(REPO_ROOT, dir, String(entry)))
        .split('\\')
        .join('/'),
    ),
  read: (file) => readFileSync(join(REPO_ROOT, file), 'utf8'),
}

/**
 * The files the write census reads: the shared definition census's, and every other
 * production file of the server that defines a query (`modules/operations/store.ts`,
 * `modules/updates/recovery-store.ts`). A write on a source table is a write wherever
 * its definition lives.
 */
function writeCensusSources(tree: SourceTree): string[] {
  const shared = trackedSources(tree)
  const elsewhere = tree
    .list('apps/server/src')
    .filter(
      (path) =>
        path.endsWith('.ts') &&
        !path.startsWith('apps/server/src/store/') &&
        !path.startsWith('apps/server/src/test-support/') &&
        !path.includes('.test.') &&
        !path.includes('.type-test.') &&
        queryDefinitionSites(path, tree.read(path)).length > 0,
    )
  return [...shared, ...elsewhere]
}

describe('the write census (design 2.5)', () => {
  let store: SessionStore
  let keyed: KeyedDefinition[]
  let outside: string[]
  beforeAll(async () => {
    store = await openTestStore(':memory:')
    await reachMethodDefinitions(store, (store as unknown as { db: SqlDatabase }).db)
    const sources = writeCensusSources(SOURCE)
    const shared = new Set(trackedSources(SOURCE))
    outside = sources.filter((path) => !shared.has(path))
    // A module outside the store registers its definitions when it is imported.
    for (const file of outside) await import(pathToFileURL(join(REPO_ROOT, file)).href)
    keyed = keyedDefinitions(sources, SOURCE).keyed
  }, 60_000)
  afterAll(async () => {
    await store?.close()
  })

  it('finds a capture form for every Postgres write on a source table, less the pending ones', () => {
    const found = uncapturedOf(keyed)
    const byFile = new Map<string, number>()
    for (const [key, lines] of found)
      byFile.set(fileOf(key), (byFile.get(fileOf(key)) ?? 0) + lines.length)
    const report = [...byFile]
      .sort(([a], [b]) => (a < b ? -1 : 1))
      .map(([file, writes]) => `${file}: ${writes}`)
    const detail = [...found]
      .sort(([a], [b]) => (a < b ? -1 : 1))
      .map(([key, lines]) => `${key}: ${lines.join(', ')}`)
    console.log(
      `write census: ${[...found.values()].flat().length} plain writes on source tables\n  ${report.join('\n  ')}\n${detail.join('\n')}`,
    )
    expect(Object.fromEntries(byFile)).toEqual(
      Object.fromEntries([...PENDING_CAPTURE].map(([file, { writes }]) => [file, writes])),
    )
  })

  it('reads the definitions of every server file that defines a query', () => {
    expect(outside).toContain('apps/server/src/modules/operations/store.ts')
    const keyedFiles = new Set(keyed.map(({ key }) => fileOf(key)))
    expect(outside.filter((file) => !keyedFiles.has(file))).toEqual([])
  })

  it('fails on a planted plain UPDATE of a source table, and passes it wrapped', () => {
    const planted = (wrap: boolean): Pick<KeyedDefinition, 'key' | 'definition'> => ({
      key: 'apps/server/src/planted.ts:setTitle',
      definition: {
        kind: 'prepared',
        scope: 'workspace',
        site: new Error(),
        build: ((db: StoreDrizzle) => {
          const t = PG_TABLES as unknown as Tables
          const write = db
            .update(t.issues)
            .set({ title: sql.placeholder('title') as never })
            .where(eq(t.issues.id, sql.placeholder('id') as never))
          return (wrap ? captureWrite(write) : write).prepare()
        }) as never,
      },
    })
    expect([...uncapturedOf([planted(false)])]).toEqual([
      ['apps/server/src/planted.ts:setTitle', ['update issues']],
    ])
    expect([...uncapturedOf([planted(true)])]).toEqual([])
  })
})
