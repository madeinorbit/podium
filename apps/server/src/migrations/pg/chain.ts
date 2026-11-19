/**
 * THE POSTGRES CHAIN'S SHAPE: ITS BASELINE AND ITS PARITY WITH THE SQLITE CHAIN
 * [POD-6981, POD-6958 design 2.7].
 *
 * Authoring-time code. It loads drizzle-kit, so only the baseline script
 * (`scripts/generate-pg-baseline.ts`), `migration:new` and `chain-parity.test.ts`
 * import it; the runner (`./index.ts`) never does.
 *
 * THE BASELINE. `migrations/pg/drizzle/<ts>_baseline/` holds the whole Postgres schema
 * (`./schema.ts`, with the sync package's twin and the identity package's tables) as
 * one migration. {@link renderPgBaseline} writes it from the twin with drizzle-kit's
 * own generator, so its `migration.sql` and `snapshot.json` are byte for byte what
 * `drizzle-kit generate` writes for an empty chain, plus what Drizzle cannot declare
 * ({@link PG_DDL_PATCHES}) and a fixed snapshot id. Nobody edits it by hand: the
 * command is `bun run migration:pg-baseline`, and `chain-parity.test.ts` fails when
 * the committed files differ from what the twin renders.
 *
 * Its `<ts>` is the timestamp of the newest SQLite migration the twin covers. The
 * SQLite migrations up to there are not replayed or translated: the
 * baseline already holds what they built, `workspace_id` included (contract C2, C10).
 *
 * TWO PHASES, switched by {@link PG_BASELINE_FROZEN}.
 *
 * - UNTIL THE FIRST HOSTED DATABASE EXISTS (now): the chain is exactly the baseline,
 *   and a schema change regenerates it in place. `bun run migration:new <name>` writes
 *   the SQLite migration and then the new baseline, renamed to the new SQLite
 *   timestamp. A database migrated from an older baseline is refused by the downgrade
 *   guard (its ledger names a baseline this build no longer carries); there are only
 *   test and development databases in this phase, and they are rebuilt.
 * - ONCE A HOSTED DATABASE HAS APPLIED THE BASELINE, it is frozen: set
 *   {@link PG_BASELINE_FROZEN} to `true` in the same commit as that deploy, and never
 *   regenerate or rename it again. From then on every schema change is a migration in
 *   both chains under the same folder name, written by `migration:new` in one commit
 *   (contract C10), and {@link pgChainProblems} fails when one chain has a change the
 *   other lacks.
 */

import { createHash } from 'node:crypto'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { generateDrizzleJson, generateMigration } from 'drizzle-kit/api-postgres'
import * as pgSync from '../../../../../packages/sync/src/adapters/pg/schema'
import { CLEARED_ON_DELETE } from '../schema'
import * as pgServer from './schema'

/**
 * False until the first hosted database applies the baseline; see the header. Flipping
 * it is a one-line change that also stops `migration:pg-baseline` from running.
 */
export const PG_BASELINE_FROZEN = false

/**
 * What every baseline failure says. The baseline is named after the newest SQLite
 * migration, so EVERY SQLite migration needs it regenerated until the freeze, a data-only
 * one included. `migration:new` does that; a hand-run `drizzle-kit generate` (`--custom`
 * included) does not.
 */
export const REGENERATE_BASELINE =
  'Run `bun run migration:pg-baseline` and commit the regenerated baseline. Every new ' +
  'SQLite migration needs this until the baseline is frozen: `bun run migration:new` does ' +
  'it for you, a hand-run `drizzle-kit generate` (--custom included) does not.'

const HERE = dirname(fileURLToPath(import.meta.url))
/** The SQLite chain's folders. */
export const SQLITE_DRIZZLE_DIR = join(HERE, '..', 'drizzle')
/** The Postgres chain's folders: `drizzle.config.pg.ts`'s `out`. */
export const PG_DRIZZLE_DIR = join(HERE, 'drizzle')

/** drizzle-kit's separator between the statements of one `migration.sql`. */
export const STATEMENT_BREAKPOINT = '--> statement-breakpoint'

/** The folder-name suffix of a chain's baseline. */
export const BASELINE_SUFFIX = '_baseline'

/** The 14-digit `YYYYMMDDHHMMSS` prefix of a migration folder name. */
export function folderTimestamp(name: string): string {
  const prefix = name.slice(0, 14)
  if (!/^\d{14}$/.test(prefix)) throw new Error(`not a migration folder name: ${name}`)
  return prefix
}

/** The migration folders under `dir`, in name order (chronological). */
export function migrationFolders(dir: string): string[] {
  return readdirSync(dir)
    .filter((name) => statSync(join(dir, name)).isDirectory())
    .sort((a, b) => a.localeCompare(b))
}

/**
 * WHAT THE POSTGRES DDL MUST CARRY THAT DRIZZLE CANNOT DECLARE, as edits to the
 * generated baseline. Each one answers an entry of `PG_DDL_NOTES`
 * (`./schema-overrides.ts`), under the same key; `chain-parity.test.ts` fails when a
 * note has no patch or a patch no note. A patch must match exactly one generated
 * statement, or rendering refuses.
 */
export interface PgDdlPatch {
  /** The statement the patch edits. */
  readonly matches: (statement: string) => boolean
  readonly apply: (statement: string) => string
}

/** A composite reference that clears only its own column (`PG_DDL_NOTES`, SET_NULL_COLUMN). */
function setNullColumn(table: string, constraint: string, column: string): PgDdlPatch {
  const head = `ALTER TABLE "${table}" ADD CONSTRAINT "${constraint}" FOREIGN KEY`
  return {
    matches: (statement) => statement.startsWith(head),
    apply: (statement) => {
      if (/ON DELETE/i.test(statement)) throw new Error(`${constraint} already has a delete action`)
      return `${statement.replace(/;\s*$/, '')} ON DELETE SET NULL ("${column}");`
    },
  }
}

export const PG_DDL_PATCHES: Readonly<Record<string, PgDdlPatch>> = {
  ...Object.fromEntries(
    CLEARED_ON_DELETE.map(({ table, key, column }) => [
      `${table}.${key}`,
      setNullColumn(table, key, column),
    ]),
  ),
  'sync_capture.fk_sync_capture_undrained_sync_capture_guard_id_fk': {
    matches: (statement) =>
      statement.startsWith(
        'ALTER TABLE "sync_capture" ADD CONSTRAINT "fk_sync_capture_undrained_sync_capture_guard_id_fk" FOREIGN KEY',
      ),
    apply: (statement) => `${statement.replace(/;\s*$/, '')} DEFERRABLE INITIALLY DEFERRED;`,
  },
}

/** The generated DDL statements with every patch applied once. */
function patched(statements: readonly string[]): string[] {
  const out = [...statements]
  for (const [key, patch] of Object.entries(PG_DDL_PATCHES)) {
    const at = out.flatMap((statement, index) => (patch.matches(statement) ? [index] : []))
    if (at.length !== 1) {
      throw new Error(`PG_DDL_PATCHES['${key}'] matches ${at.length} baseline statements, not 1`)
    }
    const index = at[0] as number
    out[index] = patch.apply(out[index] as string)
  }
  return out
}

/**
 * The twin's tables, as drizzle-kit reads `drizzle.config.pg.ts`'s two schema files,
 * in export-name order. drizzle-kit writes tables in the order it is handed them, and a
 * module namespace's key order depends on the runtime: Bun sorts it by name, as the
 * language specifies, while vitest's transform lists re-exports (the identity tables)
 * first. Sorting here makes the baseline the same text wherever it is rendered.
 */
export function pgSchemaModules(): Record<string, unknown> {
  const merged: Record<string, unknown> = { ...pgServer, ...pgSync }
  return Object.fromEntries(
    Object.keys(merged)
      .sort()
      .map((key) => [key, merged[key]]),
  )
}

/** drizzle-kit's snapshot of the twin. */
export async function pgTwinSnapshot(): Promise<Awaited<ReturnType<typeof generateDrizzleJson>>> {
  return generateDrizzleJson(pgSchemaModules())
}

/**
 * A snapshot id that is a function of the schema, in drizzle-kit's UUID shape, so a
 * regenerated baseline of an unchanged schema is byte for byte the committed one.
 * drizzle-kit only compares ids (a later snapshot's `prevIds` names this one).
 */
function snapshotId(ddl: unknown): string {
  const hex = createHash('sha256').update(JSON.stringify(ddl)).digest('hex')
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    `4${hex.slice(13, 16)}`,
    `8${hex.slice(17, 20)}`,
    hex.slice(20, 32),
  ].join('-')
}

/** The baseline folder's name and its two files. */
export interface PgBaselineFiles {
  readonly folder: string
  readonly migrationSql: string
  readonly snapshotJson: string
}

/**
 * Render the baseline from the twin. `sqliteNames` is the SQLite chain's folder list;
 * the newest one's timestamp names the baseline.
 */
export async function renderPgBaseline(sqliteNames: readonly string[]): Promise<PgBaselineFiles> {
  const newest = [...sqliteNames].sort((a, b) => a.localeCompare(b)).at(-1)
  if (newest === undefined) throw new Error('the SQLite chain has no migrations')
  const empty = await generateDrizzleJson({})
  const snapshot = await pgTwinSnapshot()
  const statements = patched(await generateMigration(empty, snapshot))
  // The key order and layout drizzle-kit's `generate` writes, so a later
  // `drizzle-kit generate --config drizzle.config.pg.ts` reads this as its own.
  const written = {
    version: snapshot.version,
    dialect: snapshot.dialect,
    id: snapshotId(snapshot.ddl),
    prevIds: snapshot.prevIds,
    ddl: snapshot.ddl,
    renames: snapshot.renames,
  }
  return {
    folder: `${folderTimestamp(newest)}${BASELINE_SUFFIX}`,
    migrationSql: statements.join(`${STATEMENT_BREAKPOINT}\n`),
    snapshotJson: JSON.stringify(written, null, 2),
  }
}

/** What differs between the committed baseline and {@link renderPgBaseline}'s output. */
export async function pgBaselineDrift(
  sqliteDir = SQLITE_DRIZZLE_DIR,
  pgDir = PG_DRIZZLE_DIR,
): Promise<string[]> {
  const rendered = await renderPgBaseline(migrationFolders(sqliteDir))
  const committed = migrationFolders(pgDir).filter((name) => name.endsWith(BASELINE_SUFFIX))
  if (committed.length !== 1 || committed[0] !== rendered.folder) {
    return [
      `the Postgres baseline folder is ${JSON.stringify(committed)}; the twin renders ` +
        `'${rendered.folder}'. ${REGENERATE_BASELINE}`,
    ]
  }
  const problems: string[] = []
  const read = (file: string): string => readFileSync(join(pgDir, rendered.folder, file), 'utf8')
  if (read('migration.sql') !== rendered.migrationSql)
    problems.push(`${rendered.folder}/migration.sql differs from what the Postgres twin renders`)
  if (read('snapshot.json') !== rendered.snapshotJson)
    problems.push(`${rendered.folder}/snapshot.json differs from what the Postgres twin renders`)
  if (problems.length > 0) problems.push(REGENERATE_BASELINE)
  return problems
}

/**
 * THE CHAIN PARITY RULE, as a function of the two chains' folder names. Empty when the
 * chains agree; otherwise one line per problem.
 *
 * Both phases: the Postgres chain starts with one baseline, and no SQLite migration
 * after the baseline's timestamp is missing from it, nor any Postgres one from SQLite.
 * Before the freeze the chain is the baseline alone and covers the newest SQLite
 * migration (a schema change regenerates it). After the freeze each later change is one
 * folder name in both chains.
 */
export function pgChainProblems(input: {
  readonly sqliteNames: readonly string[]
  readonly pgNames: readonly string[]
  readonly frozen: boolean
}): string[] {
  const pg = [...input.pgNames].sort((a, b) => a.localeCompare(b))
  const sqlite = [...input.sqliteNames].sort((a, b) => a.localeCompare(b))
  const baseline = pg[0]
  if (baseline === undefined || !baseline.endsWith(BASELINE_SUFFIX)) {
    return [
      `the Postgres chain must start with its baseline; it starts with ${baseline ?? '(nothing)'}`,
    ]
  }
  const problems: string[] = []
  const extraBaselines = pg.slice(1).filter((name) => name.endsWith(BASELINE_SUFFIX))
  if (extraBaselines.length > 0)
    problems.push(`the Postgres chain has more than one baseline: ${extraBaselines.join(', ')}`)
  const covered = folderTimestamp(baseline)
  const sqliteAfter = sqlite.filter((name) => folderTimestamp(name) > covered)
  const pgAfter = pg.slice(1)
  if (!input.frozen) {
    for (const name of pgAfter) {
      problems.push(
        `${name} is a Postgres migration after the baseline, but the baseline is not frozen ` +
          `(PG_BASELINE_FROZEN), so the change belongs in the baseline. ${REGENERATE_BASELINE}`,
      )
    }
    for (const name of sqliteAfter) {
      problems.push(
        `SQLite migration ${name} is newer than the Postgres baseline ${baseline}. ` +
          REGENERATE_BASELINE,
      )
    }
    return problems
  }
  const inPg = new Set(pgAfter)
  const inSqlite = new Set(sqliteAfter)
  for (const name of sqliteAfter) {
    if (!inPg.has(name))
      problems.push(
        `SQLite migration ${name} has no Postgres twin; write both with \`bun run migration:new\``,
      )
  }
  for (const name of pgAfter) {
    if (!inSqlite.has(name))
      problems.push(
        `Postgres migration ${name} has no SQLite twin; write both with \`bun run migration:new\``,
      )
  }
  return problems
}

/**
 * The newest Postgres snapshot against the twin: what `drizzle-kit generate` would
 * still emit. Empty when the chain's head is the twin. In both phases a schema change
 * that reached the twin but not the chain fails here.
 */
export async function pgHeadSnapshotDrift(pgDir = PG_DRIZZLE_DIR): Promise<string[]> {
  const head = migrationFolders(pgDir).at(-1)
  if (head === undefined) return ['the Postgres chain has no migrations']
  const committed = JSON.parse(readFileSync(join(pgDir, head, 'snapshot.json'), 'utf8')) as {
    readonly ddl: unknown
  }
  const twin = await pgTwinSnapshot()
  const statements = await generateMigration({ ...twin, ddl: committed.ddl } as typeof twin, twin)
  return statements.map((statement) => `${head} is behind the Postgres twin: ${statement}`)
}
