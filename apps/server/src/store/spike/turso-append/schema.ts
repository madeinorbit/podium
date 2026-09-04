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
 *
 * EVERYTHING HERE IS BUILT PER-PREFIX RATHER THAN DECLARED ONCE [POD-3358].
 * These used to be module-level constants, which meant every run of the proof
 * named the same four tables in the one shared hosted database and dropped them
 * on the way in — so two runs deleted each other's rows and reported the
 * wreckage as a result. The table objects and the DDL are now functions of a
 * namespace; see `namespace.ts` for why the prefix is shaped the way it is. The
 * INDEX names are prefixed too, and that is not decoration: index names share
 * one namespace per database in SQLite, so two runs creating `changes_entity`
 * would collide on the index even with their tables safely apart.
 */

import { sql } from 'drizzle-orm'
import { check, index, integer, primaryKey, sqliteTable, text } from 'drizzle-orm/sqlite-core'
import { prefixed, SPIKE_TABLE_BASENAMES } from './namespace'

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
function changesTable(prefix: string) {
  return sqliteTable(
    prefixed(prefix, 'changes'),
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
      index(prefixed(prefix, 'changes_entity')).on(table.entity, table.entityId, table.seq),
      index(prefixed(prefix, 'changes_event_time')).on(table.eventTime),
    ],
  )
}

/** THE INSTALLED WORLD — the latest upsert per (entity, id), written inside the append. */
function changeLatestTable(prefix: string) {
  return sqliteTable(
    prefixed(prefix, 'change_latest'),
    {
      entity: text().notNull(),
      entityId: text('entity_id').notNull(),
      seq: integer().notNull(),
      payload: text().notNull(),
    },
    (table) => [
      primaryKey({ columns: [table.entity, table.entityId] }),
      index(prefixed(prefix, 'change_latest_seq')).on(table.seq),
    ],
  )
}

/** Advisory named lease locks — the read-decide-write contrast case. */
function locksTable(prefix: string) {
  return sqliteTable(
    prefixed(prefix, 'locks'),
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
}

/** One row, pinned by a constant key — carried so the bootstrap read has its identity. */
function feedIdentityTable(prefix: string) {
  return sqliteTable(
    prefixed(prefix, 'feed_identity'),
    {
      singleton: integer().primaryKey(),
      feedId: text('feed_id').notNull(),
      epoch: text().notNull(),
      mintedAt: integer('minted_at').notNull(),
    },
    (table) => [check(prefixed(prefix, 'feed_identity_singleton'), sql`${table.singleton} = 1`)],
  )
}

/**
 * One run's four tables, built over one namespace.
 *
 * Passed explicitly to every function that builds a query rather than reached
 * for as a module import, because the whole defect being fixed was a table
 * identity that nothing had to name and therefore nothing could vary.
 */
export interface SpikeTables {
  readonly prefix: string
  readonly changes: ReturnType<typeof changesTable>
  readonly changeLatest: ReturnType<typeof changeLatestTable>
  readonly locks: ReturnType<typeof locksTable>
  readonly feedIdentity: ReturnType<typeof feedIdentityTable>
}

/** Build the slice's tables in one namespace. */
export function spikeTables(prefix: string): SpikeTables {
  return {
    prefix,
    changes: changesTable(prefix),
    changeLatest: changeLatestTable(prefix),
    locks: locksTable(prefix),
    feedIdentity: feedIdentityTable(prefix),
  }
}

/**
 * The DDL, as statements to execute rather than a migration to apply.
 *
 * Hand-written rather than derived from the objects above because drizzle-kit
 * generates into a journal and this slice has no journal — and because the
 * AUTOINCREMENT keyword is the thing under test, so it is spelled out here
 * where a reader can check it rather than inferred from a builder flag.
 */
export function schemaDdl(prefix: string): readonly string[] {
  const t = (name: string): string => prefixed(prefix, name)
  return [
    `CREATE TABLE IF NOT EXISTS ${t('changes')} (
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
    `CREATE INDEX IF NOT EXISTS ${t('changes_entity')} ON ${t('changes')} (entity, entity_id, seq)`,
    `CREATE INDEX IF NOT EXISTS ${t('changes_event_time')} ON ${t('changes')} (event_time)`,
    `CREATE TABLE IF NOT EXISTS ${t('change_latest')} (
     entity TEXT NOT NULL,
     entity_id TEXT NOT NULL,
     seq INTEGER NOT NULL,
     payload TEXT NOT NULL,
     PRIMARY KEY (entity, entity_id)
   )`,
    `CREATE INDEX IF NOT EXISTS ${t('change_latest_seq')} ON ${t('change_latest')} (seq)`,
    `CREATE TABLE IF NOT EXISTS ${t('locks')} (
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
    `CREATE TABLE IF NOT EXISTS ${t('feed_identity')} (
     singleton INTEGER PRIMARY KEY,
     feed_id TEXT NOT NULL,
     epoch TEXT NOT NULL,
     minted_at INTEGER NOT NULL,
     CONSTRAINT ${t('feed_identity_singleton')} CHECK (singleton = 1)
   )`,
  ]
}

/**
 * Drop everything this slice creates, so a run starts from a known empty
 * database.
 *
 * This is the statement that made the shared database dangerous rather than
 * merely crowded, and it is kept — a proof about seqs starting from 1 has to
 * start from an empty log. What changed is that it can now only reach the
 * caller's OWN tables.
 */
export function resetDdl(prefix: string): readonly string[] {
  return SPIKE_TABLE_BASENAMES.map((name) => `DROP TABLE IF EXISTS ${prefixed(prefix, name)}`)
}
