/**
 * THE OUT-OF-ORDER REBUILD TEST (POD-1621).
 *
 * The hazard, observed live on 2026-08-03 minutes after main became the rewrite:
 * two migration lineages, a ledger keyed by NAME, and a migration that REBUILDS
 * a table.
 *
 *   - `20260802111446_label-client-sessions` is MAIN-lineage. A main-tracking
 *     database applied it on Aug 2 and gained `client_sessions.label`.
 *   - `20260730173834_user-accounts-first-admin` is REWRITE-lineage. Despite its
 *     EARLIER name it arrived only with the landing, so the runner saw it as
 *     unapplied and ran it — and it rebuilds `client_sessions` from a column
 *     list that predates `label`. The column was dropped. No error.
 *
 * The ledger then reads 51/51 applied while the schema is wrong, and the server
 * throws `no such column: label` on every auth query. `name NOT IN (applied)`
 * cannot see this: the migration DID run; an out-of-order one undid it.
 *
 * ---------------------------------------------------------------------------
 * WHY THE FIXTURE IS BUILT THE HARD WAY
 * ---------------------------------------------------------------------------
 * A hand-made table missing a column would prove nothing — it would test that
 * `ALTER TABLE ADD` adds a column. So the damaged database here is produced by
 * REPLAYING THE REAL MANIFEST in the live box's ledger order: everything up to
 * and including the label migration EXCEPT the rewrite-only rebuild, then the
 * rebuild. The damage is asserted before anything is repaired; if the column
 * were still there the test would be measuring nothing.
 *
 * Both deliverables are then held to the standing rule that an instrument which
 * cannot say NO is not evidence: the guard must FIRE on the damaged order and
 * stay SILENT on a normal in-order install, and the repair must FIX the damaged
 * database and be a NO-OP on the healthy one.
 */

import { openDatabase } from '@podium/runtime/sqlite'
import { describe, expect, it, vi } from 'vitest'
import { DRIZZLE_MIGRATIONS } from './drizzle-manifest.generated'
import { applySchemaRepairs, outOfOrderPending, runDrizzleMigrations } from './index'

/** The rewrite-only migration that rebuilds `client_sessions`. */
const REBUILD = '20260730173834_user-accounts-first-admin'
/** The main-lineage migration that added the column the rebuild drops. */
const LABEL = '20260802111446_label-client-sessions'

type Db = ReturnType<typeof openDatabase>

const ordered = [...DRIZZLE_MIGRATIONS].sort((a, b) => a.name.localeCompare(b.name))

const columns = (db: Db, table: string) =>
  (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((c) => c.name)

/** Every table's column list, keyed by table — the schema, comparably. */
function tableColumns(db: Db): [string, string][] {
  const tables = db
    .prepare(
      `SELECT name FROM sqlite_master
         WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name != '__drizzle_migrations'
         ORDER BY name`,
    )
    .all() as { name: string }[]
  return tables.map((t) => [t.name, columns(db, t.name).join(',')])
}

/**
 * The main-tracking database as it stood before the landing: every migration up
 * to and including the label migration, MINUS the rewrite-only ones that had not
 * reached it yet. `client_sessions.label` is present, exactly as it was live.
 */
function mainTrackingDb(): Db {
  const db = openDatabase(':memory:')
  db.exec('PRAGMA foreign_keys = OFF')
  const before = ordered.filter((m) => m.name.localeCompare(LABEL) <= 0 && m.name !== REBUILD)
  runDrizzleMigrations(db, before)
  expect(columns(db, 'client_sessions')).toContain('label')
  return db
}

/** …and then the landing arrives, and the out-of-order rebuild runs. */
function damagedDb(): Db {
  const db = mainTrackingDb()
  runDrizzleMigrations(db, ordered, { skipSchemaRepair: true })
  return db
}

describe('the out-of-order rebuild hazard', () => {
  it('is named against migrations this build actually defines', () => {
    // Rename either folder and every test below would quietly stop reproducing
    // anything; this is the assertion that refuses to let that be silent.
    expect(ordered.map((m) => m.name)).toEqual(expect.arrayContaining([REBUILD, LABEL]))
    expect(REBUILD.localeCompare(LABEL)).toBeLessThan(0)
  })

  it('reproduces the live damage: the column is gone and the ledger looks complete', () => {
    const db = damagedDb()

    expect(columns(db, 'client_sessions')).not.toContain('label')
    // The ledger is the reason this was invisible: nothing is missing from it.
    const applied = db.prepare(`SELECT count(*) AS n FROM __drizzle_migrations`).get() as {
      n: number
    }
    expect(applied.n).toBe(ordered.length)
    db.close()
  })

  it('the guard fires on the damaged order and is loud about it', () => {
    const db = mainTrackingDb()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      runDrizzleMigrations(db, ordered, { skipSchemaRepair: true })
      const text = warn.mock.calls.map((c) => c.join(' ')).join('\n')
      expect(text).toContain('out-of-order')
      expect(text).toContain(REBUILD)
    } finally {
      warn.mockRestore()
      db.close()
    }
  })

  it('the repair restores the column on the damaged database', () => {
    const db = damagedDb()

    const repairs = applySchemaRepairs(db)

    expect(repairs).toEqual(['client_sessions.label'])
    expect(columns(db, 'client_sessions')).toContain('label')
    // The column has to be USABLE, not merely present — the live symptom was a
    // failing SELECT, so assert against a real row rather than PRAGMA alone.
    db.exec(
      `INSERT INTO client_sessions (token_hash, user_id, created_at, expires_at)
         VALUES ('hash1', 'user:sole', '2026-08-03T00:00:00Z', '2026-09-03T00:00:00Z')`,
    )
    const row = db
      .prepare(`SELECT label FROM client_sessions WHERE token_hash = 'hash1'`)
      .get() as {
      label: string
    }
    expect(row.label).toBe('login')
    db.close()
  })

  it('a boot of the damaged database repairs itself with no caller involvement', () => {
    const db = damagedDb()

    // Nothing is pending any more — 51/51 applied. The repair must still run.
    expect(runDrizzleMigrations(db, ordered)).toEqual([])
    expect(columns(db, 'client_sessions')).toContain('label')
    db.close()
  })
})

describe('the repair does not run ahead of the schema', () => {
  /**
   * A partially-migrated database — every fixture in this folder rewinds one —
   * is not damaged, it is EARLY. Repairing it would add `label` before
   * 20260802111446 runs, and that migration would then die on
   * `duplicate column name`, breaking every upgrade path through this point.
   */
  it('is inert until the migration that adds the column has been applied', () => {
    const db = openDatabase(':memory:')
    db.exec('PRAGMA foreign_keys = OFF')
    const before = ordered.filter((m) => m.name.localeCompare(LABEL) < 0)
    runDrizzleMigrations(db, before)

    expect(columns(db, 'client_sessions')).not.toContain('label')
    expect(applySchemaRepairs(db)).toEqual([])
    expect(columns(db, 'client_sessions')).not.toContain('label')

    // …and the real migration still applies cleanly on top.
    expect(runDrizzleMigrations(db, ordered)).toContain(LABEL)
    expect(columns(db, 'client_sessions')).toContain('label')
    db.close()
  })
})

describe('the blast radius', () => {
  /**
   * Re-derived here rather than taken on trust, and re-derived on every run: the
   * upgraded database and a fresh in-order install are compared column by column
   * across EVERY table. If the out-of-order rebuild costs a second column later —
   * a new lineage, a new rebuild — this test names it instead of a live server
   * discovering it. (A legacy pre-drizzle `schema_version` table exists on some
   * old installs and on no fresh one; it is not produced by any migration, so it
   * cannot appear on either side here.)
   */
  it('is exactly one column: after repair the upgraded schema equals a fresh install', () => {
    const fresh = openDatabase(':memory:')
    fresh.exec('PRAGMA foreign_keys = OFF')
    runDrizzleMigrations(fresh, ordered)

    const upgraded = damagedDb()
    const drift = tableColumns(fresh).filter(
      ([table, cols]) => cols !== columns(upgraded, table).join(','),
    )
    // The damage, stated before it is repaired — otherwise a broken comparison
    // would read as "no drift" and pass forever.
    expect(drift.map(([table]) => table)).toEqual(['client_sessions'])

    applySchemaRepairs(upgraded)

    expect(tableColumns(upgraded)).toEqual(tableColumns(fresh))
    fresh.close()
    upgraded.close()
  })
})

describe('a normal in-order install', () => {
  it('triggers neither the guard nor the repair', () => {
    const db = openDatabase(':memory:')
    db.exec('PRAGMA foreign_keys = OFF')
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      runDrizzleMigrations(db, ordered)
      expect(warn).not.toHaveBeenCalled()
      expect(columns(db, 'client_sessions')).toContain('label')
      // The repair is a no-op on a healthy schema: it reports nothing repaired.
      expect(applySchemaRepairs(db)).toEqual([])
    } finally {
      warn.mockRestore()
      db.close()
    }
  })

  it('is idempotent: a second boot repairs nothing and warns about nothing', () => {
    const db = openDatabase(':memory:')
    db.exec('PRAGMA foreign_keys = OFF')
    runDrizzleMigrations(db, ordered)
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      expect(runDrizzleMigrations(db, ordered)).toEqual([])
      expect(warn).not.toHaveBeenCalled()
    } finally {
      warn.mockRestore()
      db.close()
    }
  })
})

describe('outOfOrderPending', () => {
  it('names every pending migration sorting before the highest applied one', () => {
    expect(
      outOfOrderPending(['20260101000000_a', '20260301000000_c'], ['20260201000000_b']),
    ).toEqual(['20260201000000_b'])
  })

  it('says NO for an ordinary forward pending set', () => {
    expect(outOfOrderPending(['20260101000000_a'], ['20260301000000_c'])).toEqual([])
  })

  it('says NO on a fresh database, where nothing is applied yet', () => {
    expect(outOfOrderPending([], ['20260101000000_a', '20260301000000_c'])).toEqual([])
  })
})
