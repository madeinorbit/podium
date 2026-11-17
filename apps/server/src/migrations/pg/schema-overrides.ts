/**
 * WHERE THE POSTGRES TWIN DIFFERS FROM THE SQLITE SCHEMA ON PURPOSE [POD-6978, POD-6958
 * design 2.2].
 *
 * The generator (`scripts/generate-pg-schema.ts`) writes the Postgres schema from the
 * SQLite one by the type mapping of design 2.3. What that mapping cannot carry over is
 * listed here, each entry with its reason, and the generator writes the entry's form in
 * place of the SQLite one. The parity test (`schema-parity.test.ts`) accepts exactly
 * these differences: a Postgres check, index condition or default that differs from its
 * SQLite twin without an entry here fails it, and so does an entry with nothing left to
 * override. The pattern is the query-plan audit's exception lists.
 *
 * Keys are `table.name`: the SQL table name, then the check, index or column name.
 * The SQL is written as Postgres reads it, with column names quoted as the generator
 * renders the SQLite forms.
 *
 * REAL DATA: TIMESTAMP COLUMNS (design 2.3, rule 1). Counted 2026-11-17 on the
 * operator's newest pre-update backup (schema at migration 189), opened read-only in
 * place (`mode=ro&immutable=1`, never copied), with
 * `strftime('%Y-%m-%dT%H:%M:%fZ', col) IS NOT col` as the test for a value that is not
 * exact `toISOString()` form:
 *
 * | what                                        | count   |
 * |---------------------------------------------|---------|
 * | timestamp columns (`text('…_at')`)           | 153     |
 * | of them holding no value yet                | 37      |
 * | non-null values checked                     | 641,926 |
 * | values not in exact `toISOString()` form     | 0       |
 * | `''` (the "before every row" sentinel)       | 0       |
 * | `'￿'` (the "after every row" sentinel)  | 0       |
 *
 * `workspace_secrets.updated_at` (POD-7013) was added after that backup; its migration
 * fills it from `server_secrets.updated_at`, one of the 153 counted.
 *
 * So no timestamp column stays text ({@link PG_TIMESTAMP_COLUMNS_KEPT_AS_TEXT} is
 * empty), and every one is `timestamptz(3)`. The hosted import (POD-6964) still
 * normalises what it copies, and the two-engine suite's strict timestamp mode finds a
 * writer that would start producing other forms.
 */

/** One deliberate difference: the Postgres form and why it differs. */
export interface PgOverride {
  /** The Postgres SQL that replaces the SQLite form. */
  readonly sql: string
  readonly reason: string
}

const GLOB =
  'SQLite checks the digest with GLOB, which Postgres lacks. translate() deletes every ' +
  'lowercase hex digit, so an empty result means the value had no other character: the ' +
  'same rule without a regular expression (design 1.1, "GLOB checks").'

/** Check constraints, keyed `table.check_name`. */
export const PG_CHECK_OVERRIDES: Readonly<Record<string, PgOverride>> = {
  'ship_evidence.ship_evidence_custody_digest_check': {
    sql: "length(custody_digest) = 64 AND translate(custody_digest, '0123456789abcdef', '') = ''",
    reason: GLOB,
  },
  'ship_evidence.ship_evidence_content_digest_check': {
    sql: "length(content_digest) = 64 AND translate(content_digest, '0123456789abcdef', '') = ''",
    reason: GLOB,
  },
  'ship_repair_candidates.ship_repair_candidates_context_check': {
    sql: "length(context_digest) = 64 AND translate(context_digest, '0123456789abcdef', '') = ''",
    reason: GLOB,
  },
}

const BOOLEAN_CONDITION =
  'The column is an integer 0/1 on SQLite and a boolean on Postgres, where `= 1` does not ' +
  'type-check; `= true` selects the same rows.'

/** Partial-index conditions, keyed `table.index_name`. */
export const PG_INDEX_WHERE_OVERRIDES: Readonly<Record<string, PgOverride>> = {
  'sessions.idx_sessions_headless': { sql: '"headless" = true', reason: BOOLEAN_CONDITION },
  'grants.grants_machine_custodian': {
    sql: `"resource_kind" = 'machine' AND "custody" = true`,
    reason: BOOLEAN_CONDITION,
  },
}

/** Column defaults, keyed `table.column`. */
export const PG_DEFAULT_OVERRIDES: Readonly<Record<string, PgOverride>> = {
  'sessions.published_last_active_at': {
    sql: "'-infinity'",
    reason:
      "SQLite's default is '', the \"before every row\" sentinel, which a timestamptz refuses. " +
      "'-infinity' sorts where '' does, and the driver reads it back as '' (design 2.3, rule 4), " +
      'so `published_last_active_at < last_active_at` keeps its meaning.',
  },
}

/** A constraint's Postgres name, where the SQLite one cannot be kept. */
export interface PgRename {
  readonly name: string
  readonly reason: string
}

const TOO_LONG =
  'The name drizzle gives this foreign key is longer than the 63 bytes Postgres keeps of an ' +
  'identifier, so Postgres would truncate it and the schema would no longer name the ' +
  'constraint the database holds. Drizzle-kit names a column-level reference itself; the ' +
  'Postgres name keeps the table and column.'

/** Foreign key names, keyed `table.sqlite_name`. */
export const PG_FOREIGN_KEY_RENAMES: Readonly<Record<string, PgRename>> = {
  'session_observation_rebinds.session_observation_rebinds_session_id_session_observation_checkpoints_session_id_fk':
    { name: 'session_observation_rebinds_session_id_fk', reason: TOO_LONG },
  'session_terminal_candidates.session_terminal_candidates_session_id_session_observation_checkpoints_session_id_fk':
    { name: 'session_terminal_candidates_session_id_fk', reason: TOO_LONG },
}

/**
 * Timestamp columns kept as `text COLLATE "C"` because real data holds values that are
 * not exact `toISOString()` form, keyed `table.column`, each with the counts. None: see
 * the header.
 */
export const PG_TIMESTAMP_COLUMNS_KEPT_AS_TEXT: Readonly<Record<string, string>> = {}

/**
 * What the Postgres DDL must carry that Drizzle cannot declare on either engine, keyed
 * `table.constraint_name`. The SQLite migration SQL writes these by hand; the Postgres
 * baseline (POD-6981) must write the same. The parity test checks each named constraint
 * still exists.
 */
export const PG_DDL_NOTES: Readonly<Record<string, string>> = {
  'sync_capture.fk_sync_capture_undrained_sync_capture_guard_id_fk':
    'DEFERRABLE INITIALLY DEFERRED, as in the SQLite migration ' +
    '20261112232648_sync-change-capture: the fail-closed capture guard refuses a commit ' +
    'that leaves undrained rows, and must not refuse the statement that writes them ' +
    '(design 2.5). Drizzle has no deferrable foreign key.',
}
