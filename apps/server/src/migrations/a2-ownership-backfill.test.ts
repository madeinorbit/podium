/**
 * THE LIVE-UPGRADE TEST for A2's ownership retirement.
 *
 * Three migrations land together and the order between them is the design:
 * `a2-ownership-schema` adds the tables and columns, `a2-ownership-backfill`
 * READS every legacy `issues.assignee` and adjudicates it, and
 * `a2-retire-issue-assignee` drops the column. The split exists so there is a
 * state in which the evidence and the source value both exist; a single migration
 * doing both would lose the thing the evidence is about if it failed between the
 * halves.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS TEST IS FOR, GIVEN THAT THE MIGRATION IS ONE-SHOT AND IRREVERSIBLE
 * ---------------------------------------------------------------------------
 *
 * The bar is not "it does not error". It is that each of the four legacy shapes
 * an instance can actually be holding resolves the way the spec says, and that the
 * two the acceptance criteria name explicitly — an agent LABEL and an id that
 * resolves to no account — are observed NOT to become owners. A migration that got
 * those wrong would look completely successful.
 *
 * THE FIXTURE TRAP, avoided the same way `retire-the-solo-user.test.ts` avoids it:
 * a database with no `__drizzle_migrations` ledger is not an old database, it is
 * one drizzle has never seen, so the migrator replays the baseline and the test
 * silently exercises FIRST BOOT. Every case here rewinds a real database by
 * applying the manifest up to but not including the backfill, and asserts the
 * pre-state — `issues.assignee` still present, dispositions empty — before
 * touching anything.
 */

import { openDatabase, type SqlDatabase } from '@podium/runtime/sqlite'
import { describe, expect, it } from 'vitest'
import { DRIZZLE_MIGRATIONS } from './drizzle-manifest.generated'
import { runDrizzleMigrations } from './index'

const BACKFILL = 'a2-ownership-backfill'
const DROP = 'a2-retire-issue-assignee'

const indexOf = (name: string): number => {
  const i = DRIZZLE_MIGRATIONS.findIndex((m) => m.name.includes(name))
  expect(i, `${name} missing from the manifest`).toBeGreaterThan(0)
  return i
}

const columnsOf = (db: SqlDatabase, table: string): string[] =>
  (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((c) => c.name)

/** Every migration before the backfill: the schema migration HAS run, so the
 *  new tables exist and the column that is about to be adjudicated is still there. */
function preBackfillDb(): SqlDatabase {
  const db = openDatabase(':memory:')
  db.exec('PRAGMA foreign_keys = OFF')
  runDrizzleMigrations(db, DRIZZLE_MIGRATIONS.slice(0, indexOf(BACKFILL)))

  // THE PRE-STATE. If these were already true the fixture would be a migrated
  // database and every assertion below would be measuring nothing.
  expect(columnsOf(db, 'issues')).toContain('assignee')
  expect(columnsOf(db, 'issues')).toContain('assignment_revision')
  expect(
    (db.prepare('SELECT COUNT(*) AS n FROM ownership_migration_dispositions').get() as { n: number })
      .n,
  ).toBe(0)
  return db
}

const applyBackfill = (db: SqlDatabase): void => {
  runDrizzleMigrations(db, DRIZZLE_MIGRATIONS.slice(0, indexOf(BACKFILL) + 1))
}

const applyThroughDrop = (db: SqlDatabase): void => {
  runDrizzleMigrations(db, DRIZZLE_MIGRATIONS.slice(0, indexOf(DROP) + 1))
}

function seedUser(db: SqlDatabase, id: string): void {
  db.prepare(
    "INSERT OR IGNORE INTO users (id, display_name, role, created_at) VALUES (?, ?, 'member', 't')",
  ).run(id, id)
}

let seq = 0
function seedIssue(
  db: SqlDatabase,
  opts: { id: string; owner: string; assignee: string | null; revision?: number },
): void {
  seq += 1
  db.prepare(
    `INSERT INTO issues
       (id, owner_user_id, visibility, created_by_actor, repo_path, seq, title, stage,
        default_agent, created_at, updated_at, revision, assignee)
     VALUES (?, ?, 'personal', ?, '/r', ?, 'T', 'backlog', 'claude-code', 't', 't', ?, ?)`,
  ).run(opts.id, opts.owner, opts.owner, seq, opts.revision ?? 7, opts.assignee)
}

const dispositionOf = (db: SqlDatabase, id: string) =>
  db
    .prepare(
      'SELECT disposition, resolved_owner, retired_assignee FROM ownership_migration_dispositions WHERE entity_id = ?',
    )
    .get(id) as
    | { disposition: string; resolved_owner: string | null; retired_assignee: string | null }
    | undefined

const ownerOf = (db: SqlDatabase, id: string): string =>
  (db.prepare('SELECT owner_user_id AS o FROM issues WHERE id = ?').get(id) as { o: string }).o

describe('A2 ownership backfill — the four legacy shapes', () => {
  it('adopts an assignee that names a real account, and records that it did', () => {
    // WHY THE ASSIGNEE WINS HERE. It is the only one of the two columns a human
    // has ever set: `owner_user_id` is server-derived at create, and on an
    // upgraded instance it was defaulted to one id on EVERY row and then re-keyed
    // to the minted first admin. Keeping the owner would reassign the whole
    // instance to whoever installed it and call that preserving ownership.
    const db = preBackfillDb()
    seedUser(db, 'mem_installer')
    seedUser(db, 'mem_real')
    seedIssue(db, { id: 'iss_adopt', owner: 'mem_installer', assignee: 'mem_real' })

    applyBackfill(db)

    expect(ownerOf(db, 'iss_adopt')).toBe('mem_real')
    expect(dispositionOf(db, 'iss_adopt')).toEqual({
      disposition: 'adopted-assignee-as-owner',
      resolved_owner: 'mem_real',
      retired_assignee: 'mem_real',
    })
  })

  it('REFUSES an agent label, and keeps the human owner', () => {
    // The acceptance criterion, stated in the spec as "agent labels never become
    // human owners". `IssueService.start` wrote `agent:<kind>` into the assignee
    // column through a named cast; it is not a person and never was.
    const db = preBackfillDb()
    seedUser(db, 'mem_installer')
    seedIssue(db, { id: 'iss_agent', owner: 'mem_installer', assignee: 'agent:claude-code' })

    applyBackfill(db)

    expect(ownerOf(db, 'iss_agent')).toBe('mem_installer')
    expect(dispositionOf(db, 'iss_agent')).toEqual({
      disposition: 'kept-owner-assignee-was-agent-label',
      resolved_owner: 'mem_installer',
      retired_assignee: 'agent:claude-code',
    })
  })

  it('refuses an agent label EVEN IF an account with that id exists', () => {
    // The ordering of the predicates, made observable. The label test is by
    // PREFIX and runs first: a membership test alone would adopt this row as a
    // person the moment an installation minted an account whose id begins
    // `agent:`. Contrived, and the whole reason the prefix test comes first.
    const db = preBackfillDb()
    seedUser(db, 'mem_installer')
    seedUser(db, 'agent:claude-code')
    seedIssue(db, { id: 'iss_both', owner: 'mem_installer', assignee: 'agent:claude-code' })

    applyBackfill(db)

    expect(ownerOf(db, 'iss_both')).toBe('mem_installer')
    expect(dispositionOf(db, 'iss_both')?.disposition).toBe(
      'kept-owner-assignee-was-agent-label',
    )
  })

  it('refuses an id that resolves to no account', () => {
    // Default-closed (ADR 9 D4). An owner nobody can resolve still READS as a
    // valid principal, so every check refuses it — the failure mode would be "a
    // task nobody can see" rather than an error.
    const db = preBackfillDb()
    seedUser(db, 'mem_installer')
    seedIssue(db, { id: 'iss_ghost', owner: 'mem_installer', assignee: 'mem_deleted' })

    applyBackfill(db)

    expect(ownerOf(db, 'iss_ghost')).toBe('mem_installer')
    expect(dispositionOf(db, 'iss_ghost')).toEqual({
      disposition: 'kept-owner-assignee-unknown-account',
      resolved_owner: 'mem_installer',
      retired_assignee: 'mem_deleted',
    })
  })

  it('writes NO disposition for a row that was never ambiguous', () => {
    // A disposition table in which the overwhelming majority of rows say "the two
    // agreed" is one nobody reads. Ambiguity is the assignee being present,
    // non-empty and different from the owner; everything else needed no decision.
    const db = preBackfillDb()
    seedUser(db, 'mem_installer')
    seedIssue(db, { id: 'iss_null', owner: 'mem_installer', assignee: null })
    seedIssue(db, { id: 'iss_blank', owner: 'mem_installer', assignee: '' })
    seedIssue(db, { id: 'iss_same', owner: 'mem_installer', assignee: 'mem_installer' })

    applyBackfill(db)

    for (const id of ['iss_null', 'iss_blank', 'iss_same']) {
      expect({ id, d: dispositionOf(db, id) }).toEqual({ id, d: undefined })
      expect(ownerOf(db, id)).toBe('mem_installer')
    }
  })
})

describe('A2 ownership backfill — watermarks and idempotence', () => {
  it('seeds both watermarks to the row’s CURRENT revision, not to 1', () => {
    // Conservative on purpose: a worker holding a revision it read before the
    // upgrade compares as STALE and re-reads, which is the safe direction.
    // Seeding 1 would fail OPEN — every pre-upgrade worker would compare as
    // current against work whose owner may have changed while it ran.
    const db = preBackfillDb()
    seedUser(db, 'mem_installer')
    seedIssue(db, { id: 'iss_rev', owner: 'mem_installer', assignee: null, revision: 42 })

    applyBackfill(db)

    expect(
      db
        .prepare(
          'SELECT assignment_revision AS a, input_revision AS i, revision AS r FROM issues WHERE id = ?',
        )
        .get('iss_rev'),
    ).toEqual({ a: 42, i: 42, r: 42 })
  })

  it('is deterministic: a second run over the same data changes nothing', () => {
    // The rule is a pure function of the two stored values and the `users` table —
    // no clock input to the DECISION, no ordering dependence. Re-running finds
    // nothing because every predicate requires the assignee to still differ from
    // the owner, which adoption has already made false.
    const db = preBackfillDb()
    seedUser(db, 'mem_installer')
    seedUser(db, 'mem_real')
    seedIssue(db, { id: 'iss_twice', owner: 'mem_installer', assignee: 'mem_real' })

    applyBackfill(db)
    const after = {
      owner: ownerOf(db, 'iss_twice'),
      rows: db.prepare('SELECT * FROM ownership_migration_dispositions').all(),
    }

    db.exec(DRIZZLE_MIGRATIONS[indexOf(BACKFILL)]!.sql.split('--> statement-breakpoint').join(';\n'))

    expect({
      owner: ownerOf(db, 'iss_twice'),
      rows: db.prepare('SELECT * FROM ownership_migration_dispositions').all(),
    }).toEqual(after)
  })
})

describe('A2 assignee retirement — the column goes, the evidence stays', () => {
  it('drops the column and keeps every disposition', () => {
    // The property the whole issue rests on: after this, "owner and assignee
    // disagree" is not a state the database can hold, because there is nowhere to
    // hold it. And the retired VALUES survive the column, which is what makes the
    // drop auditable rather than a deletion.
    const db = preBackfillDb()
    seedUser(db, 'mem_installer')
    seedIssue(db, { id: 'iss_drop', owner: 'mem_installer', assignee: 'agent:claude-code' })

    applyThroughDrop(db)

    expect(columnsOf(db, 'issues')).not.toContain('assignee')
    expect(columnsOf(db, 'issues')).toContain('owner_user_id')
    expect(dispositionOf(db, 'iss_drop')?.retired_assignee).toBe('agent:claude-code')
  })

  it('leaves exactly one owner-shaped column on the issues table', () => {
    // Read off `PRAGMA table_info` rather than from the schema module, so the
    // subject is the database an upgraded instance actually ends up with.
    const db = preBackfillDb()
    applyThroughDrop(db)
    const ownerShaped = columnsOf(db, 'issues').filter((c) =>
      /assignee|^owner|assigned_to/.test(c),
    )
    expect(ownerShaped).toEqual(['owner_user_id'])
  })
})
