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

function seedUser(db: SqlDatabase, id: string, opts: { disabledAt?: string } = {}): void {
  db.prepare(
    "INSERT OR IGNORE INTO users (id, display_name, role, created_at, disabled_at) VALUES (?, ?, 'member', 't', ?)",
  ).run(id, id, opts.disabledAt ?? null)
}

let seq = 0
function seedIssue(
  db: SqlDatabase,
  opts: {
    id: string
    owner: string
    assignee: string | null
    revision?: number
    /** Who FILED it. Defaults to the owner, which is the shape most rows have; a
     *  conflict case passes a third party so "the creator did not move" is an
     *  assertion about a distinct value rather than a restatement of the owner. */
    createdBy?: string
    createdOnBehalfOf?: string | null
  },
): void {
  seq += 1
  db.prepare(
    `INSERT INTO issues
       (id, owner_user_id, visibility, created_by_actor, created_by_on_behalf_of, repo_path, seq,
        title, stage, default_agent, created_at, updated_at, revision, assignee)
     VALUES (?, ?, 'personal', ?, ?, '/r', ?, 'T', 'backlog', 'claude-code', 't', 't', ?, ?)`,
  ).run(
    opts.id,
    opts.owner,
    opts.createdBy ?? opts.owner,
    opts.createdOnBehalfOf ?? null,
    seq,
    opts.revision ?? 7,
    opts.assignee,
  )
}

/** THE WHOLE ROW, deliberately. Selecting a subset here is how the adoption case
 *  used to pass while the record it read named the winner twice: a projection that
 *  omits `prior_owner` cannot notice that the loser is missing from it. */
const dispositionOf = (db: SqlDatabase, id: string) =>
  db
    .prepare(
      'SELECT disposition, prior_owner, resolved_owner, retired_assignee FROM ownership_migration_dispositions WHERE entity_id = ?',
    )
    .get(id) as
    | {
        disposition: string
        prior_owner: string | null
        resolved_owner: string | null
        retired_assignee: string | null
      }
    | undefined

const ownerOf = (db: SqlDatabase, id: string): string =>
  (db.prepare('SELECT owner_user_id AS o FROM issues WHERE id = ?').get(id) as { o: string }).o

/** Creator attribution, both halves. A2 made `owner_user_id` mutable and left
 *  `created_by_*` alone on purpose: an owner moves, a fact about who filed the
 *  task does not. */
const creatorOf = (db: SqlDatabase, id: string) =>
  db
    .prepare(
      'SELECT created_by_actor AS actor, created_by_on_behalf_of AS onBehalfOf FROM issues WHERE id = ?',
    )
    .get(id) as { actor: string; onBehalfOf: string | null }

describe('A2 ownership backfill — the legacy shapes, and who they displace', () => {
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
    // `prior_owner` is the assertion that used to be missing. Without it this
    // expectation named `mem_real` twice and passed whether or not the record
    // still knew who the owner had BEEN — which is the one thing an operator
    // reading a disposition needs it to say.
    expect(dispositionOf(db, 'iss_adopt')).toEqual({
      disposition: 'adopted-assignee-as-owner',
      prior_owner: 'mem_installer',
      resolved_owner: 'mem_real',
      retired_assignee: 'mem_real',
    })
  })

  it('names BOTH humans when a conflict moves the task between two people', () => {
    // THE CASE THE DISPOSITION TABLE EXISTS FOR, and the one the adoption case
    // above cannot stand in for. Here the losing party is not the installer — it
    // is a person who was accountable for this task and is about to stop being,
    // and who is DEACTIVATED, so the instance cannot simply go and ask them. If
    // the record does not name them, nothing does.
    //
    // Every value in the fixture is distinct, so each field of the expectation
    // below is pinned by exactly one of them and no two can be confused:
    //
    //   mem_departed  the owner before the migration, now disabled  -> prior_owner
    //   mem_taker     the assignee a human chose, and the winner    -> resolved_owner
    //                                                                  retired_assignee
    //   mem_founder   who filed it, which does not move at all      -> created_by_*
    const db = preBackfillDb()
    seedUser(db, 'mem_departed', { disabledAt: '2026-08-01T00:00:00.000Z' })
    seedUser(db, 'mem_taker')
    seedUser(db, 'mem_founder')
    seedIssue(db, {
      id: 'iss_conflict',
      owner: 'mem_departed',
      assignee: 'mem_taker',
      createdBy: 'mem_founder',
      createdOnBehalfOf: 'mem_founder',
    })

    applyBackfill(db)

    expect(ownerOf(db, 'iss_conflict')).toBe('mem_taker')
    expect(dispositionOf(db, 'iss_conflict')).toEqual({
      disposition: 'adopted-assignee-as-owner',
      prior_owner: 'mem_departed',
      resolved_owner: 'mem_taker',
      retired_assignee: 'mem_taker',
    })

    // A2 made exactly ONE of the two accountable fields mutable. The owner moved;
    // the fact about who filed the task is not a thing this migration may touch.
    expect(creatorOf(db, 'iss_conflict')).toEqual({
      actor: 'mem_founder',
      onBehalfOf: 'mem_founder',
    })
  })

  it('adopts a DEACTIVATED assignee, and the record still names the active owner it displaced', () => {
    // Recorded rather than assumed. `assignee IN (SELECT id FROM users)` is a
    // membership test, not an activity test, so a disabled account IS adopted
    // today — the reverse of the case above, and the one where the person who can
    // still act on the task is the one being displaced.
    //
    // Whether adoption should require an ACTIVE account is a live question and not
    // this issue's to settle — it needs a fourth disposition value and a change to
    // an adjudication rule, so it is filed as PDM-256 rather than decided here.
    // What this case fixes in place is that the answer is observable either way,
    // and that the displaced owner is on the record while it is being decided.
    const db = preBackfillDb()
    seedUser(db, 'mem_active_owner')
    seedUser(db, 'mem_retired_person', { disabledAt: '2026-08-02T00:00:00.000Z' })
    seedIssue(db, {
      id: 'iss_inactive_taker',
      owner: 'mem_active_owner',
      assignee: 'mem_retired_person',
    })

    applyBackfill(db)

    expect(ownerOf(db, 'iss_inactive_taker')).toBe('mem_retired_person')
    expect(dispositionOf(db, 'iss_inactive_taker')).toEqual({
      disposition: 'adopted-assignee-as-owner',
      prior_owner: 'mem_active_owner',
      resolved_owner: 'mem_retired_person',
      retired_assignee: 'mem_retired_person',
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
      prior_owner: 'mem_installer',
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
      prior_owner: 'mem_installer',
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

describe('A2 ownership dispositions — a record that loses the loser is not writable', () => {
  // The table's own guard, asserted against the table rather than through a
  // migration, because it is there for the migration that has not been written
  // yet. The backfill is one-shot; the next ownership migration to write into
  // this table gets no review from this test file, and `resolved_owner` holding
  // the same id as `retired_assignee` is a shape that reads as complete.

  const insertDisposition = (
    db: SqlDatabase,
    row: {
      entityId: string
      prior: string
      resolved: string
      retired: string
      disposition: string
    },
  ): void => {
    db.prepare(
      `INSERT INTO ownership_migration_dispositions
         (migration, entity_kind, entity_id, prior_owner, resolved_owner, retired_assignee,
          disposition, decided_at)
       VALUES ('a-later-ownership-migration', 'issue', ?, ?, ?, ?, ?, 't')`,
    ).run(row.entityId, row.prior, row.resolved, row.retired, row.disposition)
  }

  it('accepts a well-formed adoption — the control for the two refusals below', () => {
    // Without this, both refusals could be passing on any error at all: a typo in
    // a column name, a NOT NULL, a check on `disposition` itself.
    const db = preBackfillDb()

    insertDisposition(db, {
      entityId: 'iss_ok',
      prior: 'mem_departed',
      resolved: 'mem_taker',
      retired: 'mem_taker',
      disposition: 'adopted-assignee-as-owner',
    })

    expect(dispositionOf(db, 'iss_ok')?.prior_owner).toBe('mem_departed')
  })

  it('REFUSES an adoption whose two owner columns agree', () => {
    // The defect, as a write the database will not accept: an ownership change in
    // which the prior owner is the winner records no change at all.
    const db = preBackfillDb()

    expect(() =>
      insertDisposition(db, {
        entityId: 'iss_bad_adopt',
        prior: 'mem_taker',
        resolved: 'mem_taker',
        retired: 'mem_taker',
        disposition: 'adopted-assignee-as-owner',
      }),
    ).toThrow(/CHECK constraint failed/)
  })

  it('REFUSES a kept-owner disposition whose two owner columns disagree', () => {
    // The other direction, and not symmetry for its own sake: a row claiming the
    // owner was KEPT while naming a different resulting owner describes an
    // ownership move nothing performed.
    const db = preBackfillDb()

    expect(() =>
      insertDisposition(db, {
        entityId: 'iss_bad_keep',
        prior: 'mem_installer',
        resolved: 'mem_someone_else',
        retired: 'agent:claude-code',
        disposition: 'kept-owner-assignee-was-agent-label',
      }),
    ).toThrow(/CHECK constraint failed/)
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
