/**
 * THE LIVE UPGRADE — a REAL pre-migration `podium.db`, upgraded in place.
 *
 * POD-305's acceptance criterion asks for two things a schema-convergence test
 * cannot give: that an EXISTING database with EXISTING rows survives the
 * provenance migration, and that **seq continuity holds across it**.
 *
 * ---------------------------------------------------------------------------
 * WHY SEQ CONTINUITY IS THE ASSERTION, AND WHY IT NEEDS ITS OWN TEST
 * ---------------------------------------------------------------------------
 *
 * `changes.seq` is the ONE global sequence (ADR 2 D2). Every replica's cursor is
 * a position in it. If a migration restarted it — which is exactly what a
 * table-rebuild migration does, and SQLite's usual answer to "add a column with
 * a constraint" IS a table rebuild — then:
 *
 *   - every existing replica's cursor would sit ABOVE the new head;
 *   - `changesSince(cursor)` would return nothing, so the client would look
 *     up-to-date while receiving no further changes at all;
 *   - and it would never heal, because a future cursor is not a gap — nothing in
 *     the ladder fires on "you are ahead of me".
 *
 * That failure is silent on both sides. Nothing errors, no log line appears, and
 * the symptom is "the UI stopped updating" hours later on one machine.
 *
 * THE TEST MUST FAIL IF SEQ RESTARTS, NOT MERELY IF THE MIGRATION ERRORS. So it
 * does not assert that the upgrade succeeded; it asserts on the NEXT ASSIGNED
 * SEQ after the upgrade, which is the number a restart would change. The
 * counterfactual is pinned below by asserting the pre-upgrade head is high enough
 * that a restart would be unambiguous (a restart to 1 cannot be confused with a
 * legitimate continuation from 3).
 */

import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDatabase, type SqlDatabase } from '@podium/runtime/sqlite'
import { describe, expect, it } from 'vitest'
import { SessionStore } from '../store'
import { appliedDrizzleNames } from './index'

function tmpDbFile(name: string): string {
  return join(mkdtempSync(join(tmpdir(), 'podium-provenance-')), name)
}

/** The migration under test — the ONE name this fixture rewinds past. */
const MIGRATION = '20260730162954_change-provenance-envelope'

/**
 * A REAL database rewound to the state immediately BEFORE the provenance
 * migration, carrying real change rows.
 *
 * Built by running the actual boot path to HEAD and then rewinding one
 * migration — dropping the three columns and deleting that migration's ledger
 * row — rather than by hand-writing a `CREATE TABLE`.
 *
 * The first attempt DID hand-write it, and it was wrong in a way worth
 * recording: a hand-built `changes` table with no drizzle ledger is not an old
 * database, it is a database drizzle has never seen. The migrator correctly
 * treated it as fresh, replayed the BASELINE, and failed with "table changes
 * already exists" — so the test was exercising first-boot, not upgrade.
 *
 * The rewind's own risk is the mirror image: `ALTER TABLE … DROP COLUMN` could
 * leave the table's rowid allocation somewhere a genuinely old database never
 * was, and that allocation is the thing under test. So the fixture ASSERTS its
 * own pre-state — `sqlite_sequence` must still read the true high-water mark
 * before the upgrade runs — and the seq test below fails on the fixture rather
 * than on the migration if it does not.
 */
function seedPreMigrationDatabase(file: string, rowCount: number): void {
  // 1. A real database at HEAD, through the real boot path.
  new SessionStore(file).close()

  const db = openDatabase(file)
  const insert = db.prepare(
    'INSERT INTO changes (entity, entity_id, op, payload, event_time) VALUES (?, ?, ?, ?, ?)',
  )
  for (let i = 1; i <= rowCount; i += 1) {
    insert.run('session', `s${i}`, 'upsert', JSON.stringify({ n: i }), 1_700_000_000_000 + i)
  }

  // 2. Rewind exactly one migration. Both halves are required: dropping the
  //    columns without clearing the ledger row leaves drizzle believing the
  //    migration has run, so the reboot would be a no-op and the test would pass
  //    against an upgrade that never happened.
  db.exec('ALTER TABLE changes DROP COLUMN origin_id')
  db.exec('ALTER TABLE changes DROP COLUMN causation_id')
  db.exec('ALTER TABLE changes DROP COLUMN mutation_id')
  db.prepare('DELETE FROM __drizzle_migrations WHERE name = ?').run(MIGRATION)

  // 3. Prove the rewind produced the state it claims. Without this the whole
  //    suite could be measuring a database that was already upgraded.
  const columns = db.prepare('PRAGMA table_info(changes)').all() as { name: string }[]
  const names = new Set(columns.map((c) => c.name))
  for (const gone of ['origin_id', 'causation_id', 'mutation_id']) {
    if (names.has(gone)) throw new Error(`fixture: ${gone} survived the rewind`)
  }
  if (appliedDrizzleNames(db).has(MIGRATION)) {
    throw new Error('fixture: the migration is still recorded as applied — the reboot would no-op')
  }
  db.close()
}

const maxSeq = (db: SqlDatabase): number =>
  (db.prepare('SELECT COALESCE(MAX(seq), 0) AS seq FROM changes').get() as { seq: number }).seq

/** What `SyncRepository.maxChangeSeq()` reads: the highest seq EVER assigned,
 *  which survives head-pruning and is the number a table rebuild resets. */
const sequenceHighWater = (db: SqlDatabase): number =>
  (
    db.prepare("SELECT seq FROM sqlite_sequence WHERE name = 'changes'").get() as
      | { seq: number }
      | undefined
  )?.seq ?? 0

describe('in-place upgrade of an existing podium.db (POD-305)', () => {
  const ROWS = 12

  it('preserves every existing change row', () => {
    const file = tmpDbFile('upgrade.db')
    seedPreMigrationDatabase(file, ROWS)

    // The real boot path: SessionStore runs the drizzle migrations in one
    // transaction. Nothing here reaches past it into the applier.
    new SessionStore(file).close()

    const db = openDatabase(file)
    const rows = db
      .prepare('SELECT seq, entity, entity_id, payload FROM changes ORDER BY seq')
      .all() as { seq: number; entity: string; entity_id: string; payload: string }[]
    expect(rows).toHaveLength(ROWS)
    expect(rows[0]).toMatchObject({ seq: 1, entity: 'session', entity_id: 's1' })
    expect(rows[ROWS - 1]).toMatchObject({ seq: ROWS, entity_id: `s${ROWS}` })
    // The payload is data, not schema: a rebuild that re-serialized it would be
    // a silent content change no column check would catch.
    expect(JSON.parse(rows[3]?.payload ?? 'null')).toEqual({ n: 4 })
    db.close()
  })

  it('adds the provenance columns as NULL on existing rows, never fabricated', () => {
    // A fabricated causationId would let a replica retire an outbox entry that
    // this change did not confirm — a user's queued write disappearing because a
    // migration invented a confirmation for it.
    const file = tmpDbFile('upgrade-null.db')
    seedPreMigrationDatabase(file, ROWS)
    new SessionStore(file).close()

    const db = openDatabase(file)
    const row = db
      .prepare('SELECT origin_id, causation_id, mutation_id FROM changes WHERE seq = 1')
      .get() as Record<string, unknown>
    expect(row).toEqual({ origin_id: null, causation_id: null, mutation_id: null })
    db.close()
  })

  it('KEEPS SEQ CONTINUOUS — the next append is head+1, not 1', () => {
    const file = tmpDbFile('upgrade-seq.db')
    seedPreMigrationDatabase(file, ROWS)

    const before = openDatabase(file)
    const headBefore = maxSeq(before)
    const highWaterBefore = sequenceHighWater(before)
    before.close()

    // The counterfactual, made explicit: a restart would go to 1, and 1 is
    // unambiguously different from 13. If ROWS were 0 this assertion could not
    // tell a continuation from a restart, and the test would be vacuous.
    expect(headBefore).toBe(ROWS)
    expect(highWaterBefore).toBe(ROWS)

    new SessionStore(file).close()

    const after = openDatabase(file)
    expect(sequenceHighWater(after)).toBe(highWaterBefore)

    // THE ASSERTION THAT WOULD FAIL ON A RESTART: what the next write is given.
    after
      .prepare(
        'INSERT INTO changes (entity, entity_id, op, payload, event_time) VALUES (?, ?, ?, ?, ?)',
      )
      .run('session', 'post-upgrade', 'upsert', '{}', 1_700_000_001_000)
    const assigned = (
      after.prepare('SELECT seq FROM changes WHERE entity_id = ?').get('post-upgrade') as {
        seq: number
      }
    ).seq
    expect(assigned).toBe(headBefore + 1)
    after.close()
  })

  it('keeps seq continuous even when the log was head-pruned before the upgrade', () => {
    // The case a naive `MAX(seq)` check would pass while the product broke.
    // Head-pruning (ADR 2 D5) deletes the OLDEST rows, so MAX(seq) is unaffected
    // — but a table rebuild would reset `sqlite_sequence` to the surviving MAX,
    // and after a prune that is LOWER than the highest seq ever assigned. Two
    // different changes would then share a position in the one global sequence.
    const file = tmpDbFile('upgrade-pruned.db')
    seedPreMigrationDatabase(file, ROWS)

    const pre = openDatabase(file)
    pre.prepare('DELETE FROM changes WHERE seq <= ?').run(ROWS - 2)
    expect(maxSeq(pre)).toBe(ROWS)
    expect(sequenceHighWater(pre)).toBe(ROWS)
    pre.close()

    new SessionStore(file).close()

    const after = openDatabase(file)
    expect(sequenceHighWater(after)).toBe(ROWS)
    after
      .prepare(
        'INSERT INTO changes (entity, entity_id, op, payload, event_time) VALUES (?, ?, ?, ?, ?)',
      )
      .run('session', 'after-prune', 'upsert', '{}', 1_700_000_002_000)
    const assigned = (
      after.prepare('SELECT seq FROM changes WHERE entity_id = ?').get('after-prune') as {
        seq: number
      }
    ).seq
    expect(assigned).toBe(ROWS + 1)
    after.close()
  })

  it('is idempotent — a second boot changes nothing', () => {
    const file = tmpDbFile('upgrade-twice.db')
    seedPreMigrationDatabase(file, ROWS)
    new SessionStore(file).close()
    new SessionStore(file).close()

    const db = openDatabase(file)
    expect(maxSeq(db)).toBe(ROWS)
    expect(sequenceHighWater(db)).toBe(ROWS)
    expect(
      (db.prepare('SELECT COUNT(*) AS n FROM changes').get() as { n: number }).n,
    ).toBe(ROWS)
    db.close()
  })
})
