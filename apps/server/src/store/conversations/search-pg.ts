/**
 * THE SEARCH INDEX ON POSTGRES [POD-6990, POD-6958 design 2.6].
 *
 * SQLite searches through FTS5: `conversations_fts` (fed by three triggers) and
 * `transcript_fts` (with its key table `transcript_fts_keys`), all made at boot when
 * search is on. Postgres searches through what its baseline made and Postgres keeps
 * current itself: a GIN index over the `tsvector` of a conversation's four searched
 * columns (`idx_conversations_search`) and the plain table `transcript_text` with a
 * generated `tsvector` column and its own `workspace_id` (`migrations/pg/pg-only-tables.ts`).
 * Both are built from `searchVectorOf` (`migrations/pg/schema-overrides.ts`): the `simple`
 * configuration over the text with ASCII punctuation as spaces and Latin diacritics
 * folded, which is what FTS5's `unicode61` tokenizer indexes.
 *
 * ONE INTERFACE. The repositories take the user's term, never engine syntax, and each
 * engine turns it into its own query: FTS5 `MATCH` with each whitespace-separated token
 * quoted and a prefix star, Postgres a `tsquery` built here ({@link tsqueryOf}). What
 * must agree is the set of matching rows for whole-word and prefix terms;
 * `search-contract.test.ts` pins it over a fixed corpus on both engines. Rank order and
 * snippet text may differ (operator decision OD4).
 *
 * This module imports no Postgres module, so a SQLite store that loads the repositories
 * never loads drizzle's Postgres code.
 */

import { type SQL, sql } from 'drizzle-orm'
import {
  conversationSearchVector,
  SEARCH_LETTER_FOLDS,
  SEARCH_PUNCTUATION,
  TRANSCRIPT_SEARCH_CHARACTERS,
} from '../../migrations/pg/schema-overrides'
import { dialectOf } from '../executor/dialect-prepared'
import type { StoreDrizzle } from '../executor/sync-drizzle'

/** Each character the search text translates: punctuation to a space, a letter to its fold. */
const TRANSLATED: ReadonlyMap<string, string> = new Map([
  ...[...SEARCH_PUNCTUATION].map((mark): [string, string] => [mark, ' ']),
  ...SEARCH_LETTER_FOLDS,
])

/**
 * The words one token of a term is, as Postgres indexes them: the token through the same
 * translation as the indexed text (`searchTextOf`), split at the spaces that leaves.
 * Lower case is left to `to_tsquery`, which folds a word as `to_tsvector` folds the text.
 */
function wordsOf(token: string): string[] {
  let text = ''
  for (const character of token) text += TRANSLATED.get(character) ?? character
  return text.split(/\s+/).filter(Boolean)
}

/** One word as a `tsquery` operand: quoted, so nothing in it is read as an operator. */
const operand = (word: string): string => `'${word.replaceAll('\\', '\\\\').replaceAll("'", "''")}'`

/**
 * THE USER'S TERM AS A POSTGRES `tsquery`, the counterpart of the FTS5 query the SQLite
 * arms build (`"token"*` per whitespace-separated token, all of them required).
 *
 *   - Each token is a phrase of its words, the last one a prefix: FTS5 reads `"deploy-sc"*`
 *     as the phrase `deploy` then a word starting `sc`, so here it is
 *     `'deploy' <-> 'sc':*`. A one-word token is that word as a prefix.
 *   - All tokens are required (`&`), as FTS5's implicit AND requires them.
 *   - A token with no word (`-`, `"`) is dropped, as FTS5 drops an empty phrase from an AND;
 *     a term with no word at all is `undefined`, which matches nothing, as on FTS5.
 */
export function tsqueryOf(term: string): string | undefined {
  const phrases = term
    .trim()
    .split(/\s+/)
    .map(wordsOf)
    .filter((words) => words.length > 0)
    .map((words) =>
      words.map((word, i) => `${operand(word)}${i === words.length - 1 ? ':*' : ''}`).join(' <-> '),
    )
  if (phrases.length === 0) return undefined
  return phrases.map((phrase) => `(${phrase})`).join(' & ')
}

/**
 * `c` matches the bound `tsquery` text `fts`: the expression of `idx_conversations_search`,
 * written over the alias `c`, so the planner reads it through the index.
 */
export const conversationMatches = (): SQL =>
  sql`${sql.raw(conversationSearchVector((name) => `c."${name}"`))} @@ to_tsquery('simple', ${sql.placeholder('fts')})`

/**
 * `ts_headline`'s options: the matched words between `**`, as FTS5's
 * `snippet(…, '**', '**', '…', 12)` marks them, in one fragment of at most 12 words.
 */
const HEADLINE_OPTIONS =
  'StartSel=**, StopSel=**, MaxWords=12, MinWords=6, ShortWord=0, MaxFragments=1, FragmentDelimiter=…'

/**
 * The snippet of a transcript row `f` around the matches of the `tsquery` `q`, over the
 * characters its search vector covers. Postgres parses the stored text, not the
 * translated one, so a word joined to another by punctuation (`/repo/wt`) can match
 * without being marked; a snippet is display, and may differ from SQLite's (OD4).
 */
export const transcriptHeadline = (): SQL =>
  sql`ts_headline('simple', left(f.content, ${sql.raw(String(TRANSCRIPT_SEARCH_CHARACTERS))}), q, ${sql.raw(`'${HEADLINE_OPTIONS}'`)})`

/**
 * THE POSTGRES ARM OF A SQLITE-ONLY SEARCH STATEMENT: the statement on SQLite, the check below on Postgres. SQLite's search is made at boot and
 * kept by hand: the FTS5 tables, the triggers that feed `conversations_fts`, the key table
 * `transcript_fts_keys`, its catch-up and its rows. Postgres's is in the baseline and kept
 * by Postgres (see the module comment), so these statements have no counterpart there,
 * and the repositories run only the first of each set there: the one that makes the
 * search relation on SQLite. Every definition still builds on both engines (the dialect
 * census builds each one on Postgres), so on Postgres each is the check that the relation
 * it stands for is there: `regclass` refuses a name that does not exist, which is what
 * turns search off on that engine, as a build without FTS5 turns it off on SQLite.
 */
export function onSqliteOnly(db: StoreDrizzle, relation: string, statement: SQL): SQL {
  return dialectOf(db) === 'pg' ? sql.raw(`SELECT '${relation}'::regclass`) : statement
}
