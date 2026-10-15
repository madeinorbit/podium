/**
 * THE QUERY-PLAN INDEXES (POD-6148).
 *
 * The migration adds the indexes the query-plan audit
 * (`store/query-plan-audit.test.ts`) found missing and replaces six with an
 * ordered form. These tests show the same result on a fresh database and on
 * one created at the previous schema and holding rows: every index exists
 * with its columns (and, for a partial one, its condition), every replaced
 * index is gone, the rows survive, and a second run changes nothing. The
 * audit shows each index serving its queries; one plan per key here shows the
 * index is usable on the upgraded database too.
 */

import { openDatabase, type SqlDatabase } from '@podium/runtime/sqlite'
import { describe, expect, it } from 'vitest'
import { runDrizzleMigrations } from '.'
import { DRIZZLE_MIGRATIONS } from './drizzle-manifest.generated'

const THIS = DRIZZLE_MIGRATIONS.findIndex((m) => m.name.endsWith('_query-plan-indexes'))
const BEFORE = DRIZZLE_MIGRATIONS.slice(0, THIS)

/** Every index the migration creates: table, columns, and the partial condition if any. */
const ADDED: Record<string, { table: string; columns: string[]; where?: string }> = {
  idx_client_sessions_user: { table: 'client_sessions', columns: ['user_id'] },
  idx_client_sessions_expires: { table: 'client_sessions', columns: ['expires_at'] },
  idx_client_sessions_label: { table: 'client_sessions', columns: ['label'] },
  idx_grants_grantee: { table: 'grants', columns: ['grantee'] },
  idx_issue_comments_issue_time: {
    table: 'issue_comments',
    columns: ['issue_id', 'created_at', 'id'],
  },
  idx_issue_deps_to_from: { table: 'issue_deps', columns: ['to_id', 'from_id', 'type'] },
  idx_issue_messages_issue_time: {
    table: 'issue_messages',
    columns: ['issue_id', 'created_at', 'id'],
  },
  idx_issue_user_state_issue: { table: 'issue_user_state', columns: ['issue_id'] },
  idx_issues_worktree: {
    table: 'issues',
    columns: ['worktree_path'],
    where: '"issues"."worktree_path" IS NOT NULL AND "issues"."deleted_at" IS NULL',
  },
  idx_issues_superseded_by: {
    table: 'issues',
    columns: ['superseded_by'],
    where: '"issues"."superseded_by" IS NOT NULL',
  },
  idx_issues_duplicate_of: {
    table: 'issues',
    columns: ['duplicate_of'],
    where: '"issues"."duplicate_of" IS NOT NULL',
  },
  idx_issues_agent_profile: {
    table: 'issues',
    columns: ['agent_profile_id'],
    where: '"issues"."agent_profile_id" IS NOT NULL',
  },
  idx_messages_delivered_to_time: {
    table: 'messages',
    columns: ['delivered_to', 'created_at', 'id'],
  },
  idx_messages_from_session_time: {
    table: 'messages',
    columns: ['from_session', 'created_at', 'id'],
  },
  idx_messages_from_issue: {
    table: 'messages',
    columns: ['from_issue', 'created_at', 'id'],
    where: '"messages"."from_issue" IS NOT NULL',
  },
  idx_messages_recipient_time: {
    table: 'messages',
    columns: ['to_kind', 'to_id', 'created_at', 'id'],
  },
  idx_messages_reply: {
    table: 'messages',
    columns: ['in_reply_to', 'kind'],
    where: '"messages"."in_reply_to" IS NOT NULL',
  },
  idx_pending_interactions_session_time: {
    table: 'pending_interactions',
    columns: ['session_id', 'asked_at', 'id'],
  },
  idx_pins_target: { table: 'pins', columns: ['kind', 'id'] },
  idx_session_user_state_session: { table: 'session_user_state', columns: ['session_id'] },
  idx_sessions_issue: { table: 'sessions', columns: ['issue_id'] },
  idx_sessions_ref_issue: {
    table: 'sessions',
    columns: ['ref_issue_id'],
    where: '"sessions"."ref_issue_id" IS NOT NULL',
  },
  idx_sessions_machine: { table: 'sessions', columns: ['machine_id'] },
  idx_ship_evidence_source: { table: 'ship_evidence', columns: ['custody_digest', 'source_ref'] },
  idx_ship_repair_candidates_order: { table: 'ship_repair_candidates', columns: ['order_id'] },
  idx_ship_train_manifests_open_lane: {
    table: 'ship_train_manifests',
    columns: ['lane_key', 'created_at', 'id'],
    where: '"ship_train_manifests"."released_at" IS NULL',
  },
  idx_ship_train_members_issue_ref: { table: 'ship_train_members', columns: ['issue_id'] },
  idx_snoozes_session: { table: 'snoozes', columns: ['session_id'] },
  idx_superagent_messages_thread: { table: 'superagent_messages', columns: ['thread_id', 'id'] },
  idx_superagent_threads_owner: {
    table: 'superagent_threads',
    columns: ['owner_user_id', 'archived', 'updated_at'],
  },
  workflow_runs_status: { table: 'workflow_runs', columns: ['status', 'started_at'] },
  workflow_runs_subject: {
    table: 'workflow_runs',
    columns: ['subject_kind', 'subject_id', 'started_at'],
  },
}

/** The indexes the ordered forms above replace. */
const REPLACED = [
  'idx_issue_comments_issue',
  'idx_issue_deps_to',
  'idx_issue_messages_issue',
  'idx_messages_delivered_to',
  'idx_messages_from_session',
  'idx_pending_interactions_session',
]

function indexShape(
  db: SqlDatabase,
  name: string,
): { table: string; columns: string[]; where?: string } | undefined {
  const row = db
    .prepare(
      "SELECT tbl_name AS tableName, sql FROM sqlite_master WHERE type = 'index' AND name = ?",
    )
    .get(name) as { tableName: string; sql: string } | undefined
  if (row === undefined) return undefined
  const columns = (
    db.prepare(`PRAGMA index_info(${JSON.stringify(name)})`).all() as { name: string }[]
  ).map((column) => column.name)
  const where = / WHERE (.*)$/s.exec(row.sql)?.[1]
  return { table: row.tableName, columns, ...(where === undefined ? {} : { where }) }
}

function expectMigrated(db: SqlDatabase): void {
  for (const [name, expected] of Object.entries(ADDED))
    expect(indexShape(db, name), name).toEqual(expected)
  for (const name of REPLACED) expect(indexShape(db, name), name).toBeUndefined()
}

function planOf(db: SqlDatabase, sql: string): string {
  return (db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all() as { detail: string }[])
    .map((r) => r.detail)
    .join(' | ')
}

/** Rows in the tables whose indexes this migration changes and whose shape is plain enough to write here. */
function plantRows(db: SqlDatabase): void {
  const now = '2026-10-15T00:00:00.000Z'
  for (let i = 0; i < 20; i++) {
    db.prepare('INSERT INTO pins (user_id, kind, id, pinned_at) VALUES (?, ?, ?, ?)').run(
      `user:${i % 3}`,
      'session',
      `s${i}`,
      now,
    )
    db.prepare(
      'INSERT INTO snoozes (user_id, session_id, snoozed_until, created_at) VALUES (?, ?, ?, ?)',
    ).run(`user:${i % 3}`, `s${i}`, now, now)
    db.prepare(
      'INSERT INTO session_user_state (user_id, session_id, read_at) VALUES (?, ?, ?)',
    ).run(`user:${i % 3}`, `s${i}`, now)
    db.prepare('INSERT INTO issue_user_state (user_id, issue_id, read_at) VALUES (?, ?, ?)').run(
      `user:${i % 3}`,
      `i${i}`,
      now,
    )
    db.prepare(
      'INSERT INTO client_sessions (token_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)',
    ).run(`t${i}`, `user:${i % 3}`, now, now)
  }
}

const COUNTED = ['pins', 'snoozes', 'session_user_state', 'issue_user_state', 'client_sessions']

function counts(db: SqlDatabase): Record<string, number> {
  return Object.fromEntries(
    COUNTED.map((table) => [
      table,
      (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n,
    ]),
  )
}

describe('POD-6148 — the query-plan indexes migration', () => {
  it('is the newest migration in the chain', () => {
    expect(THIS).toBe(DRIZZLE_MIGRATIONS.length - 1)
  })

  it('creates every index on a fresh database', () => {
    const db = openDatabase(':memory:')
    runDrizzleMigrations(db, DRIZZLE_MIGRATIONS)
    expectMigrated(db)
    db.close()
  })

  it('upgrades a database at the previous schema, keeping its rows, and a second run changes nothing', () => {
    const db = openDatabase(':memory:')
    runDrizzleMigrations(db, BEFORE)
    // The previous schema: the replaced indexes exist and the new ones do not.
    for (const name of REPLACED) expect(indexShape(db, name), name).toBeDefined()
    for (const name of Object.keys(ADDED)) expect(indexShape(db, name), name).toBeUndefined()
    plantRows(db)
    const before = counts(db)

    expect(runDrizzleMigrations(db, DRIZZLE_MIGRATIONS)).toEqual([DRIZZLE_MIGRATIONS[THIS]!.name])
    expectMigrated(db)
    expect(counts(db)).toEqual(before)
    expect(db.prepare('PRAGMA integrity_check').get()).toEqual({ integrity_check: 'ok' })
    // Usable on the upgraded rows: the lookups the audit found scanning now search.
    expect(planOf(db, "SELECT * FROM snoozes WHERE session_id = 's1'")).toContain(
      'idx_snoozes_session',
    )
    expect(planOf(db, "SELECT * FROM issue_user_state WHERE issue_id = 'i1'")).toContain(
      'idx_issue_user_state_issue',
    )
    expect(planOf(db, "DELETE FROM pins WHERE kind = 'session' AND id = 's1'")).toContain(
      'idx_pins_target',
    )
    expect(planOf(db, "SELECT * FROM sessions WHERE issue_id IN ('a', 'b')")).toContain(
      'idx_sessions_issue',
    )
    expect(planOf(db, "SELECT * FROM sessions WHERE machine_id = 'm'")).toContain(
      'idx_sessions_machine',
    )
    expect(
      planOf(db, "SELECT * FROM issues WHERE worktree_path = '/w' AND deleted_at IS NULL"),
    ).toContain('idx_issues_worktree')
    expect(
      planOf(db, "SELECT seq FROM issues WHERE agent_profile_id = 'p' AND deleted_at IS NULL"),
    ).toContain('idx_issues_agent_profile')

    expect(runDrizzleMigrations(db, DRIZZLE_MIGRATIONS)).toEqual([])
    expectMigrated(db)
    expect(counts(db)).toEqual(before)
    db.close()
  })
})
