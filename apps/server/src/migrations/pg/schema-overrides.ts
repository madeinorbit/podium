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

import { CLEARED_ON_DELETE } from '../schema'

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

/** One index whose key columns store NULLs first on Postgres, and why. */
export interface PgNullsFirst {
  /** The key columns, by SQL name, declared `ASC NULLS FIRST`. */
  readonly columns: readonly string[]
  readonly reason: string
}

const NULLS_FIRST_ORDER =
  'SQLite sorts NULL first in ascending order, and its btree stores it there, so an ascending ' +
  'order on this column is read off the index. The queries write that order out for Postgres as ' +
  '`ASC NULLS FIRST` (design 2.3), but a Postgres btree stores NULLs last unless told, and then ' +
  'it cannot serve the order and every read sorts. Declared NULLS FIRST, it reads in order again ' +
  '(POD-6992, the Postgres query-plan audit proves it). No query on Postgres orders the column ' +
  'ascending with NULLs last.'

/**
 * Index keys that store NULLs first on Postgres, keyed `table.index_name`: where a definition
 * orders the column `ASC NULLS FIRST`, SQLite's own order (design 2.3, "NULL order").
 */
export const PG_INDEX_NULLS_FIRST: Readonly<Record<string, PgNullsFirst>> = {
  'effects.idx_effects_status_deadline': {
    columns: ['deadline_at'],
    reason: `${NULLS_FIRST_ORDER} Read by effectsInStatus and expireDueEffects (effects.ts).`,
  },
  'issues.idx_issues_repo_id_seq': {
    columns: ['repo_id'],
    reason: `${NULLS_FIRST_ORDER} Read by the issue listing's repo-seq order (issue-listings.ts).`,
  },
  'messages.idx_messages_delivery_expiry_explicit': {
    columns: ['expires_at'],
    reason: `${NULLS_FIRST_ORDER} Read by the janitor's explicit expiry pages (janitor-reads.ts).`,
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
  'session_observation_rebinds.fk_session_observation_rebinds_session_id_session_observation_checkpoints_session_id_fk':
    { name: 'session_observation_rebinds_session_id_fk', reason: TOO_LONG },
  'session_terminal_candidates.fk_session_terminal_candidates_session_id_session_observation_checkpoints_session_id_fk':
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
const SET_NULL_COLUMN =
  'ON DELETE SET NULL of the referencing column alone (Postgres 15+). The key is composite, ' +
  '(workspace_id, x) to (workspace_id, id) (POD-7024), and a plain SET NULL would null ' +
  'workspace_id too, which NOT NULL refuses; deleting an issue (or a run) must clear the ' +
  "references to it in its workspace, as the single-column key's SET NULL did. Drizzle has no " +
  'column list for SET NULL. SQLite has none either: its key takes no action and the keys ' +
  'migration (20261117104939_workspace-keys) clears the references with a BEFORE DELETE trigger.'

export const PG_DDL_NOTES: Readonly<Record<string, string>> = {
  ...Object.fromEntries(
    CLEARED_ON_DELETE.map(({ table, key }) => [`${table}.${key}`, SET_NULL_COLUMN]),
  ),
  'sync_capture.fk_sync_capture_undrained_sync_capture_guard_id_fk':
    'DEFERRABLE INITIALLY DEFERRED, as in the SQLite migration ' +
    '20261112232648_sync-change-capture: the fail-closed capture guard refuses a commit ' +
    'that leaves undrained rows, and must not refuse the statement that writes them ' +
    '(design 2.5). Drizzle has no deferrable foreign key.',
}

// ---------------------------------------------------------------------------
// Search (POD-6990, design 2.6)
// ---------------------------------------------------------------------------

/**
 * Every ASCII punctuation character. Postgres's text search parser reads `/repo/wt` as one
 * file path token, `a.b.com` as a host and `deploy-script` as a hyphenated word as well as
 * its parts; SQLite's FTS5 `unicode61` tokenizer splits all of them into their words. Each
 * of these becomes a space before Postgres parses the text, so both engines index the same
 * words (design 2.6, "What differs": punctuation outside ASCII and non-Latin scripts still
 * may).
 */
export const SEARCH_PUNCTUATION = `!"#$%&'()*+,-./:;<=>?@[\\]^_\`{|}~`

/**
 * THE LATIN LETTERS FTS5 READS AS ANOTHER LETTER, AND WHAT IT READS EACH AS. `unicode61`
 * removes diacritics (`remove_diacritics 1`, the default) and folds case: `Café` is the
 * word `cafe`, so `cafe` finds it. Postgres's `simple` configuration only lowercases, by
 * the database's locale. So each of these letters becomes the letter FTS5 indexes before
 * Postgres parses the text: a letter of Latin-1 Supplement and Latin Extended-A and -B
 * (U+00C0 to U+024F) that decomposes into one ASCII letter and ONE combining mark becomes
 * that letter in lower case (FTS5 keeps a letter with two marks, such as `ǖ`), `ſ` becomes
 * `s`, and any other upper case letter there becomes its one lower case letter. Checked
 * letter by letter against FTS5 (SQLite 3.53) when this was written; the search contract
 * test (`store/conversations/search-contract.test.ts`) holds both engines to a corpus
 * with such words.
 */
export const SEARCH_LETTER_FOLDS: readonly (readonly [string, string])[] = (() => {
  const folds: [string, string][] = []
  for (let point = 0xc0; point <= 0x24f; point += 1) {
    const letter = String.fromCodePoint(point)
    const parts = letter.normalize('NFD')
    const lower = letter.toLowerCase()
    if (/^[A-Za-z][\u0300-\u036f]$/.test(parts)) folds.push([letter, parts[0]!.toLowerCase()])
    else if (letter === '\u017f') folds.push([letter, 's'])
    else if (lower !== letter && [...lower].length === 1 && /\p{L}/u.test(letter))
      folds.push([letter, lower])
  }
  return folds
})()

/** `translate()`'s two lists: the punctuation (to spaces) and the letters (to their folds). */
const SEARCH_FROM = SEARCH_PUNCTUATION + SEARCH_LETTER_FOLDS.map(([from]) => from).join('')
const SEARCH_TO =
  ' '.repeat(SEARCH_PUNCTUATION.length) + SEARCH_LETTER_FOLDS.map(([, to]) => to).join('')

/** A Postgres string literal. */
const literal = (text: string): string => `'${text.replaceAll("'", "''")}'`

/**
 * A text expression as the words FTS5 would index: {@link SEARCH_PUNCTUATION} as spaces
 * and {@link SEARCH_LETTER_FOLDS} folded. `translate()` is immutable and ignores
 * collation, so it may stand in an index and a generated column.
 */
export const searchTextOf = (text: string): string =>
  `translate(${text}, ${literal(SEARCH_FROM)}, ${literal(SEARCH_TO)})`

/** The `tsvector` of a text expression: the `simple` configuration over {@link searchTextOf}. */
export const searchVectorOf = (text: string): string =>
  `to_tsvector('simple', ${searchTextOf(text)})`

/**
 * THE INDEXED TEXT OF ONE TRANSCRIPT ROW ON POSTGRES, AT MOST THIS MANY CHARACTERS. A
 * `tsvector` is refused above 1 MB, and a refused row would stop its segment's indexing at
 * that row; 250,000 characters of the shortest distinct words stay well under it. The
 * row's whole content is still stored, read back and shown; only words past this point
 * are not found on Postgres (design 2.6, "What differs").
 */
export const TRANSCRIPT_SEARCH_CHARACTERS = 250_000

/**
 * The `tsvector` a conversation's search reads, over the four columns `conversations_fts`
 * indexes on SQLite, with `column` naming each (quoted, and qualified as the statement
 * needs). The GIN index {@link PG_ONLY_INDEXES} names is over this expression with bare
 * column names, and the search writes the same expression, which is what lets it use the
 * index.
 */
export const conversationSearchVector = (column: (name: string) => string): string =>
  searchVectorOf(
    ['title', 'name', 'summary', 'project_path']
      .map((name) => `coalesce(${column(name)}, '')`)
      .join(` || ' ' || `),
  )

/**
 * An index only the Postgres twin has: its method, what it is over, and why. An index over
 * plain columns names them in `columns`, so the twin declares them as columns and every
 * rule that reads an index's columns (the workspace-key rule among them) reads this one as
 * it reads any other; `sql` is for an index over an expression.
 */
export type PgOnlyIndex = {
  readonly using: 'gin' | 'btree'
  /** A partial index's condition, written as Postgres reads it. */
  readonly where?: string
  readonly reason: string
} & (
  | {
      /** The indexed columns by SQL name, in key order. */
      readonly columns: readonly string[]
    }
  | {
      /** The indexed expression, written as Postgres reads it, names quoted. */
      readonly sql: string
    }
)

/** Indexes only the Postgres twin has, keyed `table.index_name`. */
export const PG_ONLY_INDEXES: Readonly<Record<string, PgOnlyIndex>> = {
  'conversations.idx_conversations_search': {
    using: 'gin',
    sql: conversationSearchVector((name) => `"${name}"`),
    reason:
      'SQLite searches conversations through the FTS5 table conversations_fts and its three ' +
      'triggers, made at boot. Postgres searches the same four columns through this GIN ' +
      'index over their tsvector, which Postgres keeps current itself (design 2.6). An ' +
      'expression index rather than a generated column, so the twin keeps the SQLite ' +
      'column set and the synced record.',
  },
  'messages.idx_messages_recipient_no_id': {
    using: 'btree',
    columns: ['workspace_id', 'to_kind', 'created_at', 'id'],
    where: '"to_id" IS NULL',
    reason:
      "The messages to a recipient with no id (the operator's), oldest first " +
      '(messagesAddressedTo, listMessagesFor). SQLite reads them in order from ' +
      'idx_messages_recipient_time, taking `to_id IS NULL` as an equality on its key. Postgres ' +
      'does not: after `to_id IS NULL` the index gives it no order, and it sorts every such ' +
      'message for each page. This partial index holds those rows in the order the page reads ' +
      'them (POD-6992, the plan before and after is in ' +
      'docs/measurements/pod-6958-hosted-round-trips.md).',
  },
}

/**
 * Tables only the Postgres schema has, keyed by export name, each defined in
 * `pg-only-tables.ts` and re-exported by the generated twin, with why.
 */
export const PG_ONLY_TABLES: Readonly<Record<string, string>> = {
  transcriptText:
    'SQLite keeps transcript search rows in the FTS5 table transcript_fts and their workspace ' +
    'and segment in transcript_fts_keys, both made at boot. Postgres keeps them in this one ' +
    'plain table with a stored tsvector and a GIN index; its key columns are ordinary ' +
    'indexed columns, so it needs no key table (design 2.6).',
}
