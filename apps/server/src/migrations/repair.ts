/**
 * SCHEMA REPAIR — the half of migration safety a name-keyed ledger cannot do
 * [POD-1621].
 *
 * WHY THIS IS NOT A MIGRATION. The obvious shape for this fix is a new migration
 * folder holding `ALTER TABLE client_sessions ADD label ...`. It cannot be: on
 * every database that is already correct — which is every fresh install, because
 * in name order the rebuild runs BEFORE the label migration — that statement
 * fails with `duplicate column name`, taking the whole boot transaction with it.
 * SQLite has no `ADD COLUMN IF NOT EXISTS`, so the condition has to be read
 * (`PRAGMA table_info`) before the DDL is issued, and that means code.
 *
 * WHAT IT REPAIRS. Only drift of the shape POD-1621 found: a column that the
 * current schema requires, that an out-of-order table rebuild silently removed.
 * The ledger cannot detect this — the migration DID run; a later-applied,
 * earlier-NAMED one undid it — so the check is made against the live schema
 * instead of against the ledger, on every boot. On a healthy database each entry
 * costs one `PRAGMA table_info` and repairs nothing.
 *
 * This is deliberately a SHORT, NAMED list and not a general schema differ. A
 * differ that reconciles the whole database against schema.ts would be a second
 * migration system with no review and no history; this one only re-adds columns
 * a human has established were lost, with the exact DDL the original migration
 * used.
 */

import type { SqlDatabase } from '@podium/runtime/sqlite'

/**
 * One column the current schema requires, and the DDL that restores it. `ddl`
 * is copied verbatim from the migration that originally added the column, so a
 * repaired database and a normally-migrated one end up byte-identical in
 * `sqlite_master`.
 */
interface RequiredColumn {
  table: string
  column: string
  ddl: string
  /**
   * The migration that legitimately adds this column. The repair is inert until
   * that migration is in the ledger — a database that simply has not reached it
   * yet is not damaged, and patching it early makes the real migration fail with
   * `duplicate column name`. "Missing" only means missing once the migration
   * that adds it has run.
   */
  addedBy: string
  /** Why this column is at risk — the incident, for whoever reads a repair log. */
  why: string
}

const REQUIRED_COLUMNS: RequiredColumn[] = [
  {
    table: 'client_sessions',
    column: 'label',
    // 20260802111446_label-client-sessions, verbatim.
    ddl: "ALTER TABLE `client_sessions` ADD `label` text DEFAULT 'login' NOT NULL;",
    addedBy: '20260802111446_label-client-sessions',
    why:
      'POD-1621: 20260730173834_user-accounts-first-admin rebuilds client_sessions from a ' +
      'column list that predates the main-lineage label migration. A database that tracked ' +
      'main applied the label migration first, then the landing applied the earlier-NAMED ' +
      'rebuild, which dropped the column. Auth queries then throw `no such column: label`.',
  },
]

function tableExists(db: SqlDatabase, name: string): boolean {
  return (
    db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?`).get(name) !==
    undefined
  )
}

/**
 * The migration names in drizzle's ledger. Read locally rather than imported
 * from ./index, which imports this module. A database with no ledger is one
 * drizzle has never seen — nothing to repair.
 */
function appliedNames(db: SqlDatabase): Set<string> {
  if (!tableExists(db, '__drizzle_migrations')) return new Set()
  const rows = db.prepare(`SELECT name FROM __drizzle_migrations WHERE name IS NOT NULL`).all() as {
    name: string
  }[]
  return new Set(rows.map((r) => r.name))
}

function columnNames(db: SqlDatabase, table: string): Set<string> {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]
  return new Set(rows.map((r) => r.name))
}

/**
 * Restores every required column that is missing, and touches nothing else.
 * Idempotent by construction: the condition is read from the live schema, so a
 * correct database takes no action and a repaired one takes none on the next
 * boot. Returns `table.column` for each column actually restored — empty on a
 * healthy database, which is what the caller logs.
 *
 * A table that does not exist at all is skipped rather than created: that is a
 * different (and much larger) failure than the one this repairs, and inventing
 * a table here would hide it.
 */
export function applySchemaRepairs(db: SqlDatabase): string[] {
  const applied = appliedNames(db)
  const repaired: string[] = []
  for (const required of REQUIRED_COLUMNS) {
    if (!applied.has(required.addedBy)) continue
    if (!tableExists(db, required.table)) continue
    if (columnNames(db, required.table).has(required.column)) continue
    db.exec(required.ddl)
    repaired.push(`${required.table}.${required.column}`)
  }
  return repaired
}

/** The recorded reason for a repair, for the boot log. Empty when unknown. */
export function repairReason(id: string): string {
  return REQUIRED_COLUMNS.find((r) => `${r.table}.${r.column}` === id)?.why ?? ''
}
