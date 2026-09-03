/**
 * The tables this proof needs, restated as a STANDALONE slice [POD-3250].
 *
 * WHY A COPY RATHER THAN AN IMPORT. `packages/sync`'s schema is the authority
 * for these tables and this file is not competing with it: the proof runs
 * against a database it creates itself on a Turso backend, with no migration
 * chain and no server, so it needs the DDL as a thing it can execute rather
 * than as a journal it can apply. Copying the two change-log tables keeps the
 * proof runnable against a bare `turso dev` in one command; importing them
 * would drag the migration runner, the server's schema and the composition root
 * across a boundary this slice exists to stay outside of.
 *
 * WHAT IS COPIED IS ONLY WHAT THE APPEND PATH TOUCHES. The columns, the
 * AUTOINCREMENT on `changes.seq`, the `change_latest` primary key and the two
 * indexes are reproduced exactly, because those are the things the contract
 * under test depends on. `feed_identity`, `applied_mutations` and the rest of
 * the sync schema are absent: the proof does not append through them.
 *
 * `locks` is here for the CONTRAST CASE. The append is a blind write and can be
 * one atomic batch; a lock acquisition is a read-decide-write and cannot. The
 * proof measures both because they cost different numbers of round trips and
 * the second is the one that has to hold an interactive transaction open across
 * a network wait.
 */

import { sql } from 'drizzle-orm'
import { check, index, integer, primaryKey, sqliteTable, text } from 'drizzle-orm/sqlite-core'

/**
 * THE CHANGE LOG — the one global sequence.
 *
 * `INTEGER PRIMARY KEY AUTOINCREMENT`, and the keyword is the whole point of
 * this proof: without it SQLite reuses the rowids of deleted rows, and the log
 * is head-pruned from the tail. `sqlite_sequence` is where the highest seq ever
 * assigned is read, which is how a cursor survives pruning — so the proof has
 * to confirm that the remote engine keeps that row, keeps it transactional, and
 * keeps it per-database rather than per-connection.
 */
export const changes = sqliteTable(
  'changes',
  {
    seq: integer().primaryKey({ autoIncrement: true }),
    entity: text().notNull(),
    entityId: text('entity_id').notNull(),
    op: text().notNull(),
    payload: text(),
    eventTime: integer('event_time').notNull(),
    originId: text('origin_id'),
    causationId: text('causation_id'),
    mutationId: text('mutation_id'),
  },
  (table) => [
    index('changes_entity').on(table.entity, table.entityId, table.seq),
    index('changes_event_time').on(table.eventTime),
  ],
)

/** THE INSTALLED WORLD — the latest upsert per (entity, id), written inside the append. */
export const changeLatest = sqliteTable(
  'change_latest',
  {
    entity: text().notNull(),
    entityId: text('entity_id').notNull(),
    seq: integer().notNull(),
    payload: text().notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.entity, table.entityId] }),
    index('change_latest_seq').on(table.seq),
  ],
)

/** Advisory named lease locks — the read-decide-write contrast case. */
export const locks = sqliteTable(
  'locks',
  {
    repoId: text('repo_id').notNull(),
    name: text().notNull(),
    holderSessionId: text('holder_session_id'),
    holderIssueId: text('holder_issue_id'),
    holderLabel: text('holder_label').notNull(),
    note: text(),
    acquiredAt: text('acquired_at').notNull(),
    expiresAt: text('expires_at').notNull(),
  },
  (table) => [primaryKey({ columns: [table.repoId, table.name] })],
)

/** One row, pinned by a constant key — carried so the bootstrap read has its identity. */
export const feedIdentity = sqliteTable(
  'feed_identity',
  {
    singleton: integer().primaryKey(),
    feedId: text('feed_id').notNull(),
    epoch: text().notNull(),
    mintedAt: integer('minted_at').notNull(),
  },
  (table) => [check('feed_identity_singleton', sql`${table.singleton} = 1`)],
)

/**
 * The DDL, as statements to execute rather than a migration to apply.
 *
 * Hand-written rather than derived from the objects above because drizzle-kit
 * generates into a journal and this slice has no journal — and because the
 * AUTOINCREMENT keyword is the thing under test, so it is spelled out here
 * where a reader can check it rather than inferred from a builder flag.
 */
export const SCHEMA_DDL: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS changes (
     seq INTEGER PRIMARY KEY AUTOINCREMENT,
     entity TEXT NOT NULL,
     entity_id TEXT NOT NULL,
     op TEXT NOT NULL,
     payload TEXT,
     event_time INTEGER NOT NULL,
     origin_id TEXT,
     causation_id TEXT,
     mutation_id TEXT
   )`,
  'CREATE INDEX IF NOT EXISTS changes_entity ON changes (entity, entity_id, seq)',
  'CREATE INDEX IF NOT EXISTS changes_event_time ON changes (event_time)',
  `CREATE TABLE IF NOT EXISTS change_latest (
     entity TEXT NOT NULL,
     entity_id TEXT NOT NULL,
     seq INTEGER NOT NULL,
     payload TEXT NOT NULL,
     PRIMARY KEY (entity, entity_id)
   )`,
  'CREATE INDEX IF NOT EXISTS change_latest_seq ON change_latest (seq)',
  `CREATE TABLE IF NOT EXISTS locks (
     repo_id TEXT NOT NULL,
     name TEXT NOT NULL,
     holder_session_id TEXT,
     holder_issue_id TEXT,
     holder_label TEXT NOT NULL,
     note TEXT,
     acquired_at TEXT NOT NULL,
     expires_at TEXT NOT NULL,
     PRIMARY KEY (repo_id, name)
   )`,
  `CREATE TABLE IF NOT EXISTS feed_identity (
     singleton INTEGER PRIMARY KEY,
     feed_id TEXT NOT NULL,
     epoch TEXT NOT NULL,
     minted_at INTEGER NOT NULL,
     CONSTRAINT feed_identity_singleton CHECK (singleton = 1)
   )`,
]

/** Drop everything this slice creates, so a run starts from a known empty database. */
export const RESET_DDL: readonly string[] = [
  'DROP TABLE IF EXISTS changes',
  'DROP TABLE IF EXISTS change_latest',
  'DROP TABLE IF EXISTS locks',
  'DROP TABLE IF EXISTS feed_identity',
]
