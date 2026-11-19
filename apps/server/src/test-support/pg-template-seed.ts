/**
 * THE POSTGRES TEMPLATE STARTS FROM THE ROWS A FRESH SQLITE STORE HOLDS [POD-6994].
 *
 * The SQLite migration chain writes rows on a FRESH database, not only on an upgrade: the
 * first admin and its membership, `meta`, `sync_kind`, labels, server secrets and so on.
 * Every SQLite test store is a clone of that chain-head image, so a test may lean on them
 * (about forty files name the first admin at module scope). The Postgres baseline is schema
 * only. So the Postgres leg's template takes the same rows, DERIVED from the SQLite image by
 * one generic step: every table of the image that holds rows is copied into its Postgres
 * twin, column by column, whatever a later SQLite migration seeds. `pg-template-seed.test.ts`
 * compares the two table by table.
 *
 * This is the TEST template only. A hosted database's first rows come from provisioning
 * (POD-6964, POD-6965), never from this copy.
 *
 * THE CONVERSION is the Postgres column's: a SQLite 0/1 becomes a boolean, the two
 * timestamp sentinels (`''` and `'￿'`) become `-infinity` and `infinity`, and every other
 * value is bound as it is (ISO text into `timestamptz`, JSON text into `json`, integers into
 * `bigint`). Foreign keys are not checked while the rows go in (the copy is a snapshot of a
 * consistent database, in no particular order), and each identity column's sequence is moved
 * past the copied ids afterwards, so the next insert does not collide.
 */

import { openDatabaseFromImage, type SqlDatabase } from '@podium/runtime/sqlite'
import type { Sql, TransactionSql } from 'postgres'

/**
 * Tables of the SQLite image that have no Postgres twin by design, each with why.
 * Search: FTS5's own tables (Postgres searches a generated `tsvector` column).
 */
const SQLITE_ONLY_TABLE =
  /^(conversations_fts|transcript_fts)(_.*)?$|^__drizzle_migrations$|^sqlite_/

/** A SQLite table with rows, and the rows. */
export interface SeedTable {
  readonly name: string
  readonly rows: readonly Record<string, unknown>[]
}

/** Every table of the SQLite database `db` that holds rows, ordered by name. */
export function sqliteSeedTables(db: SqlDatabase): SeedTable[] {
  const tables = db
    .prepare("SELECT name, sql FROM sqlite_master WHERE type = 'table' ORDER BY name")
    .all() as { name: string; sql: string | null }[]
  const out: SeedTable[] = []
  for (const { name, sql } of tables) {
    if (SQLITE_ONLY_TABLE.test(name)) continue
    // A virtual table (and the shadow tables FTS5 keeps beside it) is SQLite's own.
    if (sql?.toUpperCase().startsWith('CREATE VIRTUAL')) continue
    const rows = db.prepare(`SELECT * FROM "${name.replaceAll('"', '""')}"`).all() as Record<
      string,
      unknown
    >[]
    if (rows.length > 0) out.push({ name, rows })
  }
  return out
}

/** The rows of a fresh SQLite chain-head image. */
export function sqliteImageSeedTables(image: Uint8Array): SeedTable[] {
  const db = openDatabaseFromImage(new Uint8Array(image))
  try {
    return sqliteSeedTables(db)
  } finally {
    db.close()
  }
}

interface PgColumn {
  readonly column_name: string
  readonly data_type: string
  readonly is_identity: string
}

const quote = (name: string): string => `"${name.replaceAll('"', '""')}"`

/** A SQLite value as the Postgres column of `type` takes it. */
function pgValue(value: unknown, type: string): unknown {
  if (value === null || value === undefined) return null
  if (type === 'boolean') return value === 1 || value === 1n || value === true || value === '1'
  if (type.startsWith('timestamp')) {
    if (value === '') return '-infinity'
    if (value === '￿') return 'infinity'
  }
  if (typeof value === 'bigint') return value.toString()
  return value
}

/**
 * Copy `tables` into the Postgres database `sql` is connected to, in one transaction.
 * A table or column the Postgres schema lacks is refused: the twin's parity check says it
 * cannot happen, and a silent skip would let the two engines start apart.
 */
export async function copySeedTables(sql: Sql, tables: readonly SeedTable[]): Promise<void> {
  await sql.begin(async (tx: TransactionSql) => {
    // Foreign keys are triggers on Postgres; the replica role skips them for the copy.
    await tx.unsafe('SET LOCAL session_replication_role = replica')
    for (const table of tables) {
      const columns = (await tx.unsafe(
        "SELECT column_name, data_type, is_identity FROM information_schema.columns WHERE table_schema = 'public' AND table_name = $1",
        [table.name],
      )) as unknown as PgColumn[]
      if (columns.length === 0) {
        throw new Error(`pg template seed: SQLite seeds ${table.name}, which Postgres lacks`)
      }
      const types = new Map(columns.map((column) => [column.column_name, column.data_type]))
      const names = Object.keys(table.rows[0] ?? {})
      for (const name of names) {
        if (!types.has(name)) {
          throw new Error(`pg template seed: ${table.name}.${name} has no Postgres column`)
        }
      }
      for (const row of table.rows) {
        const values = names.map((name) => pgValue(row[name], types.get(name) ?? 'text'))
        // JSON goes in as its text: a string bound to a json parameter would be encoded
        // again (a JSON string holding the document).
        const placeholders = names.map((name, i) =>
          /^jsonb?$/.test(types.get(name) ?? '') ? `$${i + 1}::text::json` : `$${i + 1}`,
        )
        await tx.unsafe(
          `INSERT INTO ${quote(table.name)} (${names.map(quote).join(', ')}) OVERRIDING SYSTEM VALUE VALUES (${placeholders.join(', ')})`,
          values as never[],
        )
      }
      for (const column of columns) {
        if (column.is_identity !== 'YES' || !names.includes(column.column_name)) continue
        await tx.unsafe(
          `SELECT setval(pg_get_serial_sequence($1, $2), (SELECT max(${quote(column.column_name)}) FROM ${quote(table.name)}))`,
          [quote(table.name), column.column_name],
        )
      }
    }
  })
}

/** The earliest active admin, the rule `@podium/runtime/earliest-admin` states, on Postgres. */
export const PG_EARLIEST_ADMIN_SQL =
  "SELECT id FROM users WHERE role = 'admin' AND disabled_at IS NULL ORDER BY created_at ASC, id ASC LIMIT 1"

/**
 * The environment variable naming the template's first admin, which the lane's
 * globalSetup reads once and every fork primes before a test file is imported
 * (`pre-migrated-store.ts`), as a SQLite fork primes from its image.
 */
export const PG_TEST_FIRST_ADMIN_ENV = 'PODIUM_TEST_PG_FIRST_ADMIN'
