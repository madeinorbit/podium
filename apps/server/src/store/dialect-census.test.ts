/**
 * EVERY STORE QUERY, BUILT ON THE POSTGRES TABLES [POD-6978, POD-6958 design 2.1 step 2, 2.3].
 *
 * The store's query definitions are written once, against the SQLite types, and a
 * Postgres store hands them the Postgres twins through the binding's one cast
 * (`executor/binding.ts`). This census is the part of what makes that cast safe that
 * needs no database: it reaches every registered definition the way the query-plan and
 * workspace-scope audits do (`test-support/definition-census.ts`), builds each one, at
 * each family shape, on a Postgres drizzle instance bound to the generated tables
 * (`migrations/pg/schema.ts` and the sync tables' twins) whose client refuses to run
 * anything, and reads the SQL it renders. A two-form definition (`dialectPrepared`)
 * builds its Postgres form there.
 *
 * A definition NEEDS A POSTGRES FORM when, on Postgres:
 *
 *  - it does not build (a SQLite-only builder method, a table bound outside `t`);
 *  - its SQL uses a SQLite-only construct (`json_extract`, `json_each`, `INDEXED BY`,
 *    `rowid`, `julianday`, `COLLATE NOCASE`, `GLOB`, two-argument `MAX`, a `?` written into
 *    raw SQL, … : {@link SQLITE_ONLY});
 *  - it compares or orders a computed text (`->>`, `||`, `lower()`, `upper()`) without
 *    `COLLATE "C"`: Postgres gives such a value the database's default collation, not
 *    SQLite's byte order (design 2.3, rule 13);
 *  - it compares a `json` column without `CAST(col AS TEXT)`: `json` has no equality, and
 *    SQLite compares the text (rule 7);
 *  - it compares a boolean column with an integer (`= 1`), which Postgres refuses;
 *  - it orders by a nullable column without NULLS FIRST / NULLS LAST: SQLite sorts NULL
 *    first ascending and Postgres last, so the rows come back in another order.
 *
 * Each such definition is on {@link NEEDS_PG_FORM} with what it needs, and the task that
 * adds its Postgres form is the one that owns its file ({@link TASK_OF_FILE}, from design
 * section 5). The list must equal what the census finds: a new definition with a finding
 * fails until it gets a Postgres form or an entry, and an entry whose definition is clean
 * now fails until it is removed, so the list only shrinks as the binding tasks land.
 *
 * The census prints the count of definitions that build on Postgres unchanged and the
 * list, by task. It opens a SQLite store in memory only to reach the definitions made
 * inside methods; nothing connects to Postgres.
 */

import { readdirSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import type { SqlDatabase } from '@podium/runtime/sqlite'
import { pgSyncTables } from '@podium/sync/adapters/pg/schema'
import { is } from 'drizzle-orm'
import { getTableConfig, PgTable } from 'drizzle-orm/pg-core'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import * as pgSchema from '../migrations/pg/schema'
import type { SessionStore } from '../store'
import {
  FAMILY_SHAPES,
  isFragment,
  type KeyedDefinition,
  keyedDefinitions,
  REPO_ROOT,
  reachMethodDefinitions,
  type SourceTree,
  trackedSources,
} from '../test-support/definition-census'
import { openTestStore } from '../test-support/open-test-store'
import type { QueryClient } from './executor/driver'
import { buildPgStoreDrizzle } from './executor/pg-drizzle'

// ---------------------------------------------------------------------------
// The list: definitions that need a Postgres form, and who adds it
// ---------------------------------------------------------------------------

/**
 * The binding task that owns each definition file (design section 5), which is the task
 * that adds the file's Postgres forms. A directory ends in `/`.
 */
const TASK_OF_FILE: ReadonlyMap<string, string> = new Map([
  ['apps/server/src/store/sessions.ts', 'POD-6983'],
  ['apps/server/src/store/user-layout.ts', 'POD-6983'],
  ['apps/server/src/store/user-preferences.ts', 'POD-6983'],
  ['apps/server/src/store/user-read-position.ts', 'POD-6983'],
  ['apps/server/src/store/written-columns.ts', 'POD-6983'],
  ['apps/server/src/store/issues.ts', 'POD-6984'],
  ['apps/server/src/store/issue-listings.ts', 'POD-6984'],
  ['apps/server/src/store/issue-panel.ts', 'POD-6984'],
  ['apps/server/src/store/issue-storage.ts', 'POD-6984'],
  ['apps/server/src/store/issue-revision.ts', 'POD-6984'],
  ['apps/server/src/store/issue-git-states.ts', 'POD-6984'],
  // Not in design section 5; an issue's artifact uploads go with the issue bindings.
  ['apps/server/src/store/artifact-uploads.ts', 'POD-6984'],
  ['apps/server/src/store/messages.ts', 'POD-6985'],
  ['apps/server/src/store/messaging-', 'POD-6985'],
  ['apps/server/src/store/telegram-bindings.ts', 'POD-6985'],
  ['apps/server/src/store/notification-facts.ts', 'POD-6985'],
  ['apps/server/src/store/shipping.ts', 'POD-6986'],
  ['apps/server/src/store/guarded-move.ts', 'POD-6986'],
  ['apps/server/src/store/append-only.ts', 'POD-6986'],
  ['apps/server/src/store/machines.ts', 'POD-6987'],
  ['apps/server/src/store/machine-record-', 'POD-6987'],
  ['apps/server/src/store/repos.ts', 'POD-6987'],
  ['apps/server/src/store/checkouts.ts', 'POD-6987'],
  ['apps/server/src/store/grants.ts', 'POD-6987'],
  ['apps/server/src/store/accounts.ts', 'POD-6987'],
  ['apps/server/src/store/users.ts', 'POD-6987'],
  ['apps/server/src/store/sign-in-carry-over.ts', 'POD-6987'],
  ['apps/server/src/store/server-secrets.ts', 'POD-6987'],
  ['apps/server/src/store/settings.ts', 'POD-6987'],
  ['apps/server/src/store/settings-audit.ts', 'POD-6987'],
  ['apps/server/src/store/agent-profiles.ts', 'POD-6987'],
  ['apps/server/src/store/identity-upgrade.ts', 'POD-6987'],
  ['apps/server/src/store/events.ts', 'POD-6988'],
  ['apps/server/src/store/effects.ts', 'POD-6988'],
  ['apps/server/src/store/workflows.ts', 'POD-6988'],
  ['apps/server/src/store/automations.ts', 'POD-6988'],
  ['apps/server/src/store/interactions.ts', 'POD-6988'],
  ['apps/server/src/store/superagent.ts', 'POD-6988'],
  ['apps/server/src/store/observation-checkpoints.ts', 'POD-6988'],
  ['apps/server/src/store/transcript-costs.ts', 'POD-6988'],
  ['apps/server/src/store/maintenance.ts', 'POD-6988'],
  ['apps/server/src/store/locks.ts', 'POD-6988'],
  ['packages/sync/src/adapters/sqlite/', 'POD-6989'],
  ['apps/server/src/store/conversations/', 'POD-6990'],
])

/** The task that owns `file`'s Postgres forms, or undefined when design section 5 names none. */
function taskOfFile(file: string): string | undefined {
  const exact = TASK_OF_FILE.get(file)
  if (exact !== undefined) return exact
  for (const [prefix, task] of TASK_OF_FILE) {
    if (!prefix.endsWith('.ts') && file.startsWith(prefix)) return task
  }
  return undefined
}

/**
 * Definitions that need a Postgres form, keyed `file:name`, with the finding kinds the
 * census reports for them (sorted, comma-separated). The owning task is
 * {@link taskOfFile}. Only shrinks: a binding task removes its entries as it adds forms.
 */
const NEEDS_PG_FORM: ReadonlyMap<string, string> = new Map<string, string>([
  ['apps/server/src/store/agent-profiles.ts:profileByName', 'SQLite-only COLLATE NOCASE'],
  [
    'apps/server/src/store/artifact-uploads.ts:advanceReceived',
    'json column received_json compared without CAST(… AS TEXT)',
  ],
  ['apps/server/src/store/conversations/index.ts:createFtsDeleteTrigger', 'SQLite-only rowid'],
  ['apps/server/src/store/conversations/index.ts:createFtsInsertTrigger', 'SQLite-only rowid'],
  ['apps/server/src/store/conversations/index.ts:createFtsUpdateTrigger', 'SQLite-only rowid'],
  [
    'apps/server/src/store/conversations/index.ts:deleteMachineConversations',
    'SQLite-only json_each()',
  ],
  [
    'apps/server/src/store/conversations/index.ts:recentConversations',
    'computed text (lower()) without COLLATE "C"',
  ],
  [
    'apps/server/src/store/conversations/index.ts:searchConversations',
    'SQLite-only MATCH, SQLite-only rowid, computed text (lower()) without COLLATE "C"',
  ],
  [
    'apps/server/src/store/conversations/index.ts:upsertConversations',
    "SQLite-only a '$.path' JSON path, SQLite-only json_each()",
  ],
  [
    'apps/server/src/store/conversations/registry.ts:adoptParents',
    'SQLite-only json_each(), computed text (->>) without COLLATE "C"',
  ],
  [
    'apps/server/src/store/conversations/registry.ts:insertDiscoveredSegments',
    'SQLite-only json_each()',
  ],
  ['apps/server/src/store/conversations/registry.ts:insertIdentities', 'SQLite-only json_each()'],
  [
    'apps/server/src/store/conversations/registry.ts:refreshSegmentFiles',
    'SQLite-only json_each(), computed text (->>) without COLLATE "C"',
  ],
  [
    'apps/server/src/store/conversations/transcript-index.ts:catchUpKeys',
    'SQLite-only INSERT OR, SQLite-only REPLACE INTO, SQLite-only rowid',
  ],
  [
    'apps/server/src/store/conversations/transcript-index.ts:deleteTranscriptRows',
    'SQLite-only rowid',
  ],
  [
    'apps/server/src/store/conversations/transcript-index.ts:insertTranscriptKey',
    'SQLite-only INSERT OR, SQLite-only REPLACE INTO, SQLite-only last_insert_rowid()',
  ],
  [
    'apps/server/src/store/conversations/transcript-index.ts:searchTranscripts',
    'SQLite-only MATCH, SQLite-only rowid',
  ],
  ['apps/server/src/store/conversations/transcript-index.ts:transcriptRowsOf', 'SQLite-only rowid'],
  [
    'apps/server/src/store/issue-git-states.ts:save',
    'json column facts_json compared without CAST(… AS TEXT)',
  ],
  [
    'apps/server/src/store/issue-listings.ts:issueCountGroups',
    'SQLite-only char(), SQLite-only printf()',
  ],
  [
    'apps/server/src/store/issue-listings.ts:issueListing',
    'ORDER BY nullable column repo_id without NULLS FIRST/LAST, SQLite-only instr(), SQLite-only julianday()',
  ],
  ['apps/server/src/store/issues.ts:issuesUnderPathOutsideRepo', 'SQLite-only rowid'],
  [
    'apps/server/src/store/issues.ts:labelVocabulary',
    'computed text (lower()) without COLLATE "C"',
  ],
  ['apps/server/src/store/issues.ts:labelsNamed', 'computed text (lower()) without COLLATE "C"'],
  ['apps/server/src/store/issues.ts:liveWorktreesOnMachines', 'SQLite-only INDEXED BY'],
  [
    'apps/server/src/store/issues.ts:worktreeOwnersOf',
    'computed text (lower()) without COLLATE "C"',
  ],
  [
    'apps/server/src/store/machines.ts:recordHarnessVersionOf',
    'SQLite-only json_extract(), SQLite-only json_set(), SQLite-only two-argument MAX/MIN',
  ],
  ['apps/server/src/store/messages.ts:latestPendingOperator', 'SQLite-only rowid'],
  ['apps/server/src/store/messages.ts:openChat', 'SQLite-only INDEXED BY, SQLite-only rowid'],
  [
    'apps/server/src/store/messages.ts:pendingSendersOf',
    'ORDER BY nullable column from_issue without NULLS FIRST/LAST, ORDER BY nullable column from_session without NULLS FIRST/LAST',
  ],
  [
    'apps/server/src/store/messages.ts:pendingSummaryOf',
    'ORDER BY nullable column from_issue without NULLS FIRST/LAST, ORDER BY nullable column from_session without NULLS FIRST/LAST',
  ],
  [
    'apps/server/src/store/messages.ts:swapHarnessRef',
    'json column harness_ref_json compared without CAST(… AS TEXT)',
  ],
  ['apps/server/src/store/repos.ts:registryRows', 'SQLite-only rowid'],
  ['apps/server/src/store/shipping.ts:activeOrdersFifo', 'SQLite-only INDEXED BY'],
  ['apps/server/src/store/shipping.ts:queuedDependentsOfIds', 'SQLite-only json_each()'],
  ['apps/server/src/store/shipping.ts:resumableOrdersFifo', 'SQLite-only INDEXED BY'],
  ['apps/server/src/store/shipping.ts:shippedLeadersOfOpenTrains', 'SQLite-only INDEXED BY'],
  [
    'apps/server/src/store/users.ts:memberHoldingEmail',
    'computed text (lower()) without COLLATE "C"',
  ],
  ['apps/server/src/store/users.ts:userIdByEmail', 'computed text (lower()) without COLLATE "C"'],
])

// ---------------------------------------------------------------------------
// Reading the Postgres SQL
// ---------------------------------------------------------------------------

/** One SQL token: a word, a quoted name, a string literal, a number or a symbol. */
interface Token {
  readonly kind: 'word' | 'name' | 'string' | 'number' | 'symbol' | 'param'
  readonly text: string
}

/** The token at `i`, or an empty symbol past either end. */
const NO_TOKEN: Token = { kind: 'symbol', text: '' }
const tokenAt = (tokens: readonly Token[], i: number): Token => tokens[i] ?? NO_TOKEN

/** Split SQL into tokens; string literals and quoted names stay whole. */
function tokenize(sql: string): Token[] {
  const tokens: Token[] = []
  let i = 0
  while (i < sql.length) {
    const c = sql.charAt(i)
    if (/\s/.test(c)) {
      i += 1
      continue
    }
    if (c === "'" || c === '"' || c === '`') {
      let j = i + 1
      while (j < sql.length) {
        if (sql[j] === c) {
          if (sql[j + 1] === c) j += 2
          else break
        } else j += 1
      }
      tokens.push({ kind: c === "'" ? 'string' : 'name', text: sql.slice(i, j + 1) })
      i = j + 1
      continue
    }
    if (c === '$' && /\d/.test(sql[i + 1] ?? '')) {
      let j = i + 1
      while (/\d/.test(sql[j] ?? '')) j += 1
      tokens.push({ kind: 'param', text: sql.slice(i, j) })
      i = j
      continue
    }
    if (/[A-Za-z_]/.test(c)) {
      let j = i + 1
      while (/[A-Za-z0-9_$]/.test(sql[j] ?? '')) j += 1
      tokens.push({ kind: 'word', text: sql.slice(i, j) })
      i = j
      continue
    }
    if (/\d/.test(c)) {
      let j = i + 1
      while (/[\d.]/.test(sql[j] ?? '')) j += 1
      tokens.push({ kind: 'number', text: sql.slice(i, j) })
      i = j
      continue
    }
    const three = sql.slice(i, i + 3)
    const two = sql.slice(i, i + 2)
    if (three === '->>' || three === '#>>') {
      tokens.push({ kind: 'symbol', text: three })
      i += 3
    } else if (['<>', '!=', '<=', '>=', '||', '->', '::', '#>'].includes(two)) {
      tokens.push({ kind: 'symbol', text: two })
      i += 2
    } else {
      tokens.push({ kind: 'symbol', text: c })
      i += 1
    }
  }
  return tokens
}

const upper = (token: Token | undefined): string =>
  token?.kind === 'word' ? token.text.toUpperCase() : ''

/** SQLite-only constructs, by the finding name each reports as. */
const SQLITE_ONLY: readonly {
  readonly finding: string
  readonly at: (tokens: Token[], i: number) => boolean
}[] = [
  ...[
    'json_extract',
    'json_each',
    'json_tree',
    'json_group_array',
    'json_group_object',
    'json_set',
    'json_insert',
    'json_replace',
    'json_remove',
    'json_patch',
    'json_valid',
    'json_type',
    'json_array_length',
    'json_quote',
    'json',
    'julianday',
    'strftime',
    'datetime',
    'unixepoch',
    'ifnull',
    'iif',
    'instr',
    'group_concat',
    'printf',
    'typeof',
    'hex',
    'randomblob',
    'zeroblob',
    'total',
    'likely',
    'unlikely',
    'last_insert_rowid',
    'changes',
    'total_changes',
    'char',
  ].map((fn) => ({
    finding: `${fn}()`,
    at: (tokens: Token[], i: number) =>
      tokenAt(tokens, i).kind === 'word' &&
      tokenAt(tokens, i).text.toLowerCase() === fn &&
      tokens[i + 1]?.text === '(',
  })),
  { finding: 'INDEXED BY', at: (t, i) => upper(t[i]) === 'INDEXED' && upper(t[i + 1]) === 'BY' },
  { finding: 'NOT INDEXED', at: (t, i) => upper(t[i]) === 'NOT' && upper(t[i + 1]) === 'INDEXED' },
  {
    finding: 'rowid',
    at: (t, i) =>
      ['ROWID', '_ROWID_', 'OID'].includes(upper(t[i])) ||
      /^"(rowid|_rowid_)"$/i.test(tokenAt(t, i).text),
  },
  {
    finding: 'COLLATE NOCASE',
    at: (t, i) =>
      upper(t[i]) === 'COLLATE' && /^(NOCASE|RTRIM|BINARY)$/i.test(t[i + 1]?.text ?? ''),
  },
  { finding: 'GLOB', at: (t, i) => upper(t[i]) === 'GLOB' },
  { finding: 'MATCH', at: (t, i) => upper(t[i]) === 'MATCH' },
  { finding: 'INSERT OR', at: (t, i) => upper(t[i]) === 'INSERT' && upper(t[i + 1]) === 'OR' },
  {
    finding: 'REPLACE INTO',
    at: (t, i) => upper(t[i]) === 'REPLACE' && upper(t[i + 1]) === 'INTO',
  },
  {
    finding: 'sqlite_master',
    at: (t, i) =>
      /^"?(sqlite_master|sqlite_schema|sqlite_temp_master)"?$/i.test(tokenAt(t, i).text),
  },
  { finding: 'PRAGMA', at: (t, i) => upper(t[i]) === 'PRAGMA' },
  { finding: 'LIMIT -1', at: (t, i) => upper(t[i]) === 'LIMIT' && t[i + 1]?.text === '-' },
  { finding: 'a ? placeholder', at: (t, i) => tokenAt(t, i).text === '?' },
  { finding: 'a backquoted name', at: (t, i) => tokenAt(t, i).text.startsWith('`') },
  {
    finding: "a '$.path' JSON path",
    at: (t, i) =>
      (tokenAt(t, i).text === '->>' || tokenAt(t, i).text === '->') &&
      (t[i + 1]?.text.startsWith("'$") ?? false),
  },
  {
    finding: 'two-argument MAX/MIN',
    at: (t, i) =>
      /^(MAX|MIN)$/.test(upper(t[i])) && t[i + 1]?.text === '(' && topLevelCommas(t, i + 1) > 0,
  },
]

/** The index of the parenthesis closing the one at `open`. */
function closing(tokens: Token[], open: number): number {
  let depth = 0
  for (let i = open; i < tokens.length; i += 1) {
    if (tokenAt(tokens, i).text === '(') depth += 1
    else if (tokenAt(tokens, i).text === ')') {
      depth -= 1
      if (depth === 0) return i
    }
  }
  return tokens.length - 1
}

/** The index of the parenthesis opening the one at `close`. */
function opening(tokens: Token[], close: number): number {
  let depth = 0
  for (let i = close; i >= 0; i -= 1) {
    if (tokenAt(tokens, i).text === ')') depth += 1
    else if (tokenAt(tokens, i).text === '(') {
      depth -= 1
      if (depth === 0) return i
    }
  }
  return 0
}

function topLevelCommas(tokens: Token[], open: number): number {
  let depth = 0
  let commas = 0
  for (let i = open; i < tokens.length; i += 1) {
    const text = tokenAt(tokens, i).text
    if (text === '(') depth += 1
    else if (text === ')') {
      depth -= 1
      if (depth === 0) break
    } else if (text === ',' && depth === 1) commas += 1
  }
  return commas
}

const COMPARISON = new Set(['=', '<>', '!=', '<', '>', '<=', '>='])
const COMPARISON_WORDS = new Set(['LIKE', 'ILIKE', 'IN', 'BETWEEN', 'DISTINCT'])

/** One operand ending at `end`: a name (maybe qualified), a literal, a call or a group. */
function operandStart(tokens: Token[], end: number): number {
  let i = end
  if (tokens[i]?.text === ')') {
    i = opening(tokens, i)
    if (tokens[i - 1]?.kind === 'word') i -= 1
    return i
  }
  while (tokens[i - 1]?.text === '.' && tokens[i - 2] !== undefined) i -= 2
  return i
}

/** One operand starting at `start`. */
function operandEnd(tokens: Token[], start: number): number {
  let i = start
  if (tokens[i]?.kind === 'word' && tokens[i + 1]?.text === '(') return closing(tokens, i + 1)
  if (tokens[i]?.text === '(') return closing(tokens, i)
  while (tokens[i + 1]?.text === '.' && tokens[i + 2] !== undefined) i += 2
  return i
}

/** Words before a parenthesis that make it a grouping or a subquery, not a function call. */
const NOT_CALLS = new Set([
  'SELECT',
  'WHERE',
  'AND',
  'OR',
  'NOT',
  'ON',
  'BY',
  'WHEN',
  'THEN',
  'ELSE',
  'IN',
  'SET',
  'VALUES',
  'RETURNING',
  'FROM',
  'AS',
  'HAVING',
  'CASE',
  'IS',
  'LIKE',
  'BETWEEN',
  'EXISTS',
  'JOIN',
  'USING',
  'DISTINCT',
  'ALL',
  'ANY',
])

/** Is the parenthesis at `open` a function call's? */
const isCall = (tokens: Token[], open: number): boolean =>
  tokens[open - 1]?.kind === 'word' && !NOT_CALLS.has(upper(tokens[open - 1]))

/**
 * The clause keyword governing position `at`. A grouping parenthesis is looked through;
 * inside a function call's parentheses the clause is `CALL`.
 */
function clauseAt(tokens: Token[], at: number): string {
  let depth = 0
  for (let i = at - 1; i >= 0; i -= 1) {
    const text = tokenAt(tokens, i).text
    if (text === ')') depth += 1
    else if (text === '(') {
      if (depth > 0) depth -= 1
      else if (isCall(tokens, i)) return 'CALL'
    } else if (depth === 0) {
      const word = upper(tokens[i])
      if (word === 'END') {
        // A whole CASE expression lies before `at`: step over it to its CASE.
        let nesting = 0
        for (; i >= 0; i -= 1) {
          if (upper(tokens[i]) === 'END') nesting += 1
          else if (upper(tokens[i]) === 'CASE' && --nesting === 0) break
        }
        continue
      }
      if (word === 'BY' && /^(ORDER|GROUP|PARTITION)$/.test(upper(tokens[i - 1]))) {
        return `${upper(tokens[i - 1])} BY`
      }
      if (/^(SELECT|WHERE|ON|HAVING|SET|VALUES|RETURNING|FROM|WHEN|THEN|ELSE)$/.test(word)) {
        return word
      }
    }
  }
  return ''
}

/** Is the `=` at `eq` an assignment of an UPDATE's or an upsert's SET list? */
const isAssignment = (tokens: Token[], eq: number): boolean =>
  tokens[eq]?.text === '=' &&
  tokens[eq - 1]?.kind === 'name' &&
  (tokens[eq - 2]?.text === ',' || upper(tokens[eq - 2]) === 'SET') &&
  clauseAt(tokens, eq) === 'SET'

/**
 * Is the operand spanning `start`..`end` compared or ordered? Next to a comparison, the
 * left side of IN/LIKE/BETWEEN, or an ORDER BY, GROUP BY or PARTITION BY term.
 */
function comparedOrOrdered(tokens: Token[], start: number, end: number): boolean {
  const before = tokens[start - 1]
  const after = tokens[end + 1]
  const compares = (token: Token | undefined, at: number) =>
    token !== undefined &&
    (COMPARISON.has(token.text) || COMPARISON_WORDS.has(upper(token))) &&
    !isAssignment(tokens, at)
  if (compares(before, start - 1) || compares(after, end + 1)) return true
  if (upper(after) === 'NOT' && COMPARISON_WORDS.has(upper(tokens[end + 2]))) return true
  if (upper(before) === 'FROM' && upper(tokens[start - 2]) === 'DISTINCT') return true
  return /^(ORDER|GROUP|PARTITION) BY$/.test(clauseAt(tokens, start))
}

const followedByCollateC = (tokens: Token[], end: number): boolean =>
  upper(tokens[end + 1]) === 'COLLATE' && tokens[end + 2]?.text === '"C"'

/** Computed text compared or ordered without `COLLATE "C"`. */
function computedTextFindings(tokens: Token[]): string[] {
  const found: string[] = []
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokenAt(tokens, i)
    let start = -1
    let end = -1
    let what = ''
    if (['->>', '#>>', '||'].includes(token.text)) {
      start = operandStart(tokens, i - 1)
      end = operandEnd(tokens, i + 1)
      // A chain `a || b || c` is one value: extend over the rest of it.
      while (tokens[end + 1]?.text === '||') end = operandEnd(tokens, end + 2)
      what = token.text === '||' ? 'concatenation' : token.text
      // Skip the later operators of a chain already reported.
      if (token.text === '||' && tokens[start - 1]?.text === '||') continue
    } else if (/^(LOWER|UPPER)$/.test(upper(token)) && tokens[i + 1]?.text === '(') {
      start = i
      end = closing(tokens, i + 1)
      what = `${token.text.toLowerCase()}()`
    } else continue
    // A parenthesised value: look outside the parentheses.
    while (
      tokens[start - 1]?.text === '(' &&
      tokens[end + 1]?.text === ')' &&
      !isCall(tokens, start - 1)
    ) {
      start -= 1
      end += 1
    }
    if (followedByCollateC(tokens, end)) continue
    if (comparedOrOrdered(tokens, start, end))
      found.push(`computed text (${what}) without COLLATE "C"`)
  }
  return found
}

/** The tables a statement names after FROM, JOIN, INTO or UPDATE. */
function tablesNamed(tokens: Token[]): Set<string> {
  const tables = new Set<string>()
  for (let i = 0; i < tokens.length - 1; i += 1) {
    if (
      /^(FROM|JOIN|INTO|UPDATE)$/.test(upper(tokens[i])) &&
      tokenAt(tokens, i + 1).kind === 'name'
    ) {
      tables.add(tokenAt(tokens, i + 1).text.slice(1, -1))
    }
  }
  return tables
}

/** Per column name, the tables in which it is a column of the given SQL type. */
function columnsOfType(type: (sqlType: string) => boolean): Map<string, Set<string>> {
  return columnsWhere((column) => type(column.getSQLType()))
}

/** Per column name, the tables in which a column of that name satisfies `test`. */
function columnsWhere(
  test: (column: ReturnType<typeof getTableConfig>['columns'][number]) => boolean,
): Map<string, Set<string>> {
  const byName = new Map<string, Set<string>>()
  for (const value of Object.values(PG_TABLES)) {
    if (!is(value, PgTable)) continue
    const config = getTableConfig(value)
    for (const column of config.columns) {
      if (!test(column)) continue
      byName.set(column.name, (byName.get(column.name) ?? new Set()).add(config.name))
    }
  }
  return byName
}

/**
 * Each reference to a column of the given kind: `"table"."column"`, `excluded."column"`
 * or a bare `"column"` of one of the statement's tables. Yields the span of the reference.
 */
function* columnReferences(tokens: Token[], byName: ReadonlyMap<string, ReadonlySet<string>>) {
  const tables = tablesNamed(tokens)
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokenAt(tokens, i)
    if (token.kind !== 'name') continue
    const column = token.text.slice(1, -1)
    const owners = byName.get(column)
    if (owners === undefined) continue
    const qualified = tokens[i - 1]?.text === '.'
    if (qualified) {
      const qualifier = tokenAt(tokens, i - 2)
      const table = qualifier.kind === 'name' ? qualifier.text.slice(1, -1) : qualifier.text
      if (table.toLowerCase() !== 'excluded' && !owners.has(table)) continue
      if (table.toLowerCase() === 'excluded' && ![...tables].some((t) => owners.has(t))) continue
      yield { start: i - 2, end: i, column }
    } else {
      // A bare name right after FROM/INTO/UPDATE is a table, not a column.
      if (/^(FROM|JOIN|INTO|UPDATE)$/.test(upper(tokens[i - 1]))) continue
      if (tokens[i + 1]?.text === '.') continue
      if (![...tables].some((t) => owners.has(t))) continue
      yield { start: i, end: i, column }
    }
  }
}

/** A JSON column compared without `CAST(col AS TEXT)`. */
function jsonComparisonFindings(tokens: Token[]): string[] {
  const found: string[] = []
  for (const { start, end, column } of columnReferences(tokens, JSON_COLUMNS)) {
    const cast =
      upper(tokens[start - 2]) === 'CAST' &&
      tokens[start - 1]?.text === '(' &&
      upper(tokens[end + 1]) === 'AS' &&
      upper(tokens[end + 2]) === 'TEXT'
    if (cast) continue
    // `col IS NULL` / `col IS NOT NULL` compare nothing.
    if (
      upper(tokens[end + 1]) === 'IS' &&
      /^(NULL|NOT)$/.test(upper(tokens[end + 2])) &&
      upper(tokens[end + 3]) !== 'DISTINCT'
    )
      continue
    if (
      comparedOrOrdered(tokens, start, end) ||
      (upper(tokens[end + 1]) === 'IS' && upper(tokens[end + 2]) === 'DISTINCT')
    ) {
      found.push(`json column ${column} compared without CAST(… AS TEXT)`)
    }
  }
  return found
}

/** A boolean column compared with the integers 0 or 1. */
function booleanComparisonFindings(tokens: Token[]): string[] {
  const found: string[] = []
  const integer = (token: Token | undefined) =>
    token?.kind === 'number' && /^[01]$/.test(token.text)
  for (const { start, end, column } of columnReferences(tokens, BOOLEAN_COLUMNS)) {
    const after = tokens[end + 1]
    const before = tokens[start - 1]
    if (
      (after && COMPARISON.has(after.text) && integer(tokens[end + 2])) ||
      (before && COMPARISON.has(before.text) && integer(tokens[start - 2]))
    ) {
      found.push(`boolean column ${column} compared with an integer`)
    }
    if (upper(after) === 'IN' && tokens[end + 2]?.text === '(' && integer(tokens[end + 3])) {
      found.push(`boolean column ${column} compared with an integer`)
    }
  }
  return found
}

/** Words that end an ORDER BY list at its own depth. */
const ORDER_BY_END = new Set([
  'LIMIT',
  'OFFSET',
  'FETCH',
  'FOR',
  'UNION',
  'EXCEPT',
  'INTERSECT',
  'RETURNING',
])

/**
 * An ORDER BY term that is a nullable column with no NULLS FIRST / NULLS LAST. SQLite
 * sorts NULL first ascending and Postgres last, so such an order differs between the
 * engines (design 2.3, "NULL order"). Window orders (`OVER (ORDER BY …)`) count too.
 * Only a bare column reference is judged: an expression's nullability is not known here.
 */
function nullOrderFindings(tokens: Token[]): string[] {
  const found: string[] = []
  const tables = tablesNamed(tokens)
  const judge = (start: number, end: number) => {
    let last = end
    for (let k = start; k <= end; k += 1) if (upper(tokenAt(tokens, k)) === 'NULLS') return
    if (/^(ASC|DESC)$/.test(upper(tokenAt(tokens, last)))) last -= 1
    let column: string | undefined
    let qualifier: string | undefined
    const at = (k: number) => tokenAt(tokens, k)
    if (last === start && at(start).kind === 'name') column = at(start).text.slice(1, -1)
    else if (last === start + 2 && at(start + 1).text === '.' && at(last).kind === 'name') {
      column = at(last).text.slice(1, -1)
      qualifier = at(start).kind === 'name' ? at(start).text.slice(1, -1) : at(start).text
    }
    if (column === undefined) return
    const owners = NULLABLE_COLUMNS.get(column)
    if (owners === undefined) return
    const nullable =
      qualifier !== undefined && owners.has(qualifier)
        ? true
        : qualifier !== undefined && tables.has(qualifier)
          ? false
          : [...tables].some((table) => owners.has(table))
    if (nullable) found.push(`ORDER BY nullable column ${column} without NULLS FIRST/LAST`)
  }
  for (let i = 0; i < tokens.length - 1; i += 1) {
    if (upper(tokenAt(tokens, i)) !== 'ORDER' || upper(tokenAt(tokens, i + 1)) !== 'BY') continue
    let depth = 0
    let start = i + 2
    let j = start
    for (; j < tokens.length; j += 1) {
      const token = tokenAt(tokens, j)
      if (token.text === '(') depth += 1
      else if (token.text === ')') {
        if (depth === 0) break
        depth -= 1
      } else if (depth === 0 && (token.text === ',' || ORDER_BY_END.has(upper(token)))) {
        judge(start, j - 1)
        if (token.text !== ',') break
        start = j + 1
      }
    }
    if (j >= tokens.length || tokenAt(tokens, j).text === ')') judge(start, j - 1)
  }
  return found
}

/** Every finding in one Postgres statement, deduplicated. */
function findingsIn(sql: string): string[] {
  const tokens = tokenize(sql)
  const found = new Set<string>()
  for (let i = 0; i < tokens.length; i += 1) {
    for (const rule of SQLITE_ONLY) if (rule.at(tokens, i)) found.add(`SQLite-only ${rule.finding}`)
  }
  for (const finding of computedTextFindings(tokens)) found.add(finding)
  for (const finding of jsonComparisonFindings(tokens)) found.add(finding)
  for (const finding of booleanComparisonFindings(tokens)) found.add(finding)
  for (const finding of nullOrderFindings(tokens)) found.add(finding)
  return [...found].sort()
}

// ---------------------------------------------------------------------------
// Building every definition on the Postgres tables
// ---------------------------------------------------------------------------

/** The Postgres table set a store binds: the server schema's twins and the sync tables'. */
const PG_TABLES = Object.freeze({ ...pgSchema, ...pgSyncTables })

const JSON_COLUMNS = columnsOfType((type) => type === 'json')
const BOOLEAN_COLUMNS = columnsOfType((type) => type === 'boolean')
const NULLABLE_COLUMNS = columnsWhere((column) => !column.notNull)

/** A Postgres drizzle instance over the twins whose client refuses to run anything. */
function pgRecordingDrizzle() {
  const refuse = (): never => {
    throw new Error('the dialect census builds queries; it never runs them')
  }
  const client: QueryClient = {
    run: refuse,
    get: refuse,
    all: refuse,
    writeGet: refuse,
    writeAll: refuse,
    batch: refuse,
  }
  return buildPgStoreDrizzle(client, PG_TABLES)
}

/** The SQL of every statement in what a definition built (a prepared query, a raw one, or a bundle). */
function sqlOf(built: unknown, depth = 0): string[] {
  if (built === null || typeof built !== 'object') return []
  const query = built as { getQuery?: () => { sql: string }; toSQL?: () => { sql: string } }
  if (typeof query.getQuery === 'function') return [query.getQuery().sql]
  if (typeof query.toSQL === 'function' && !isFragment(built)) return [query.toSQL().sql]
  if (depth < 2) return Object.values(built).flatMap((value) => sqlOf(value, depth + 1))
  return []
}

/** What the census found for one definition. */
interface Censused {
  readonly key: string
  readonly statements: number
  readonly findings: readonly string[]
}

function censusOf(keyed: readonly KeyedDefinition[]): {
  censused: Censused[]
  fragments: number
  missingShapes: string[]
} {
  const db = pgRecordingDrizzle()
  const byKey = new Map<string, { statements: Set<string>; findings: Set<string> }>()
  const missingShapes = new Set<string>()
  let fragments = 0
  for (const { key, definition } of keyed) {
    if (definition.kind === 'family' && !FAMILY_SHAPES.has(key)) missingShapes.add(key)
    const shapes: readonly (string | number | undefined)[] =
      definition.kind === 'family' ? (FAMILY_SHAPES.get(key) ?? []) : [undefined]
    const entry = byKey.get(key) ?? { statements: new Set<string>(), findings: new Set<string>() }
    byKey.set(key, entry)
    for (const shape of shapes) {
      let built: unknown
      try {
        built = (definition.build as (db: unknown, key: unknown) => unknown)(db, shape)
      } catch (error) {
        entry.findings.add(`does not build: ${(error as Error).message.split('\n')[0]}`)
        continue
      }
      const statements = sqlOf(built)
      if (statements.length === 0) {
        if (isFragment(built)) fragments += 1
        else entry.findings.add('builds no statement')
      }
      for (const sql of statements) {
        entry.statements.add(sql)
        for (const finding of findingsIn(sql)) entry.findings.add(finding)
      }
    }
  }
  const censused = [...byKey].map(([key, { statements, findings }]) => ({
    key,
    statements: statements.size,
    findings: [...findings].sort(),
  }))
  return { censused, fragments, missingShapes: [...missingShapes] }
}

// ---------------------------------------------------------------------------
// The census
// ---------------------------------------------------------------------------

/**
 * The repository as this census reads it. It reads source it does not import (every
 * definition site), so it sits in the shard keyed on the whole tree.
 */
const SOURCE: SourceTree = {
  list: (dir) =>
    readdirSync(join(REPO_ROOT, dir), { recursive: true }).map((entry) =>
      relative(REPO_ROOT, join(REPO_ROOT, dir, String(entry)))
        .split('\\')
        .join('/'),
    ),
  read: (file) => readFileSync(join(REPO_ROOT, file), 'utf8'),
}

let store: SessionStore
let census: ReturnType<typeof censusOf> & ReturnType<typeof keyedDefinitions>

beforeAll(async () => {
  store = await openTestStore(':memory:')
  const database = (store as unknown as { db: SqlDatabase }).db
  await reachMethodDefinitions(store, database)
  const keyed = keyedDefinitions(trackedSources(SOURCE), SOURCE)
  census = { ...keyed, ...censusOf(keyed.keyed) }
})

afterAll(async () => {
  await store?.close()
})

const fileOf = (key: string): string => key.slice(0, key.indexOf(':'))

describe('the dialect census', () => {
  it('reaches every definition', () => {
    expect(census.unmapped).toEqual([])
    expect(census.unregisteredSites).toEqual([])
    expect(census.missingShapes).toEqual([])
    expect(census.censused.length).toBeGreaterThan(500)
  })

  it('finds exactly the definitions listed as needing a Postgres form', () => {
    const found = new Map(
      census.censused
        .filter((entry) => entry.findings.length > 0)
        .map((entry) => [entry.key, entry.findings.join(', ')]),
    )
    const unchanged = census.censused.length - found.size
    const byTask = new Map<string, string[]>()
    for (const [key, needs] of found) {
      const task = taskOfFile(fileOf(key)) ?? 'no owning task'
      byTask.set(task, [...(byTask.get(task) ?? []), `  ${key}: ${needs}`])
    }
    console.log(
      `dialect census: ${census.censused.length} definitions, ${unchanged} build on Postgres unchanged, ` +
        `${found.size} need a Postgres form, ${census.fragments} fragments\n` +
        [...byTask]
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([task, lines]) => `${task} (${lines.length}):\n${lines.sort().join('\n')}`)
          .join('\n'),
    )
    const unlisted = [...found]
      .filter(([key, needs]) => NEEDS_PG_FORM.get(key) !== needs)
      .map(([key, needs]) => `${key}: ${needs} (listed: ${NEEDS_PG_FORM.get(key) ?? 'no'})`)
    const stale = [...NEEDS_PG_FORM.keys()].filter((key) => !found.has(key))
    expect(unlisted).toEqual([])
    expect(stale).toEqual([])
  })

  it('names the task for every listed definition', () => {
    expect(
      [...NEEDS_PG_FORM.keys()].filter((key) => taskOfFile(fileOf(key)) === undefined),
    ).toEqual([])
  })
})

describe('the census reads Postgres SQL', () => {
  it('finds SQLite-only constructs', () => {
    expect(
      findingsIn('select "a" from "t" indexed by "i" where json_extract("p", \'$.k\') = $1'),
    ).toEqual(['SQLite-only INDEXED BY', 'SQLite-only json_extract()'])
    expect(findingsIn('select max("a", "b") from "t" order by rowid')).toEqual([
      'SQLite-only rowid',
      'SQLite-only two-argument MAX/MIN',
    ])
    expect(findingsIn('select max("a") from "t" where "name" = \'rowid\'')).toEqual([])
  })

  it('finds computed text compared or ordered without COLLATE "C"', () => {
    expect(findingsIn('select "a" from "t" where lower("name") = lower($1)')).toEqual([
      'computed text (lower()) without COLLATE "C"',
    ])
    expect(findingsIn('select "a" from "t" order by ("payload" ->> \'k\')')).toEqual([
      'computed text (->>) without COLLATE "C"',
    ])
    expect(findingsIn('select "a" from "t" where "a" || \'/\' < $1')).toEqual([
      'computed text (concatenation) without COLLATE "C"',
    ])
    expect(findingsIn('select "a" from "t" where lower("name") COLLATE "C" = $1')).toEqual([])
    expect(findingsIn('select lower("name") from "t"')).toEqual([])
  })

  it('reads an assignment as no comparison', () => {
    expect(
      findingsIn(
        'insert into "podium_events" ("payload") values ($1) on conflict ("id") do update set "payload" = excluded."payload", "kind" = $2',
      ),
    ).toEqual([])
    expect(findingsIn('update "podium_events" set "payload" = $1 where "payload" <> $1')).toEqual([
      'json column payload compared without CAST(… AS TEXT)',
    ])
  })

  it('finds a JSON column compared without CAST(… AS TEXT)', () => {
    // `podium_events.payload` is a json column of the twin.
    expect(findingsIn('select "id" from "podium_events" where "payload" = $1')).toEqual([
      'json column payload compared without CAST(… AS TEXT)',
    ])
    expect(
      findingsIn('select "id" from "podium_events" where CAST("payload" AS TEXT) = $1'),
    ).toEqual([])
    expect(findingsIn('select "id" from "podium_events" where "payload" is null')).toEqual([])
    expect(findingsIn('select "payload" from "podium_events"')).toEqual([])
  })

  it('finds a boolean column compared with an integer', () => {
    expect(findingsIn('select "id" from "sessions" where "sessions"."archived" = 0')).toEqual([
      'boolean column archived compared with an integer',
    ])
    expect(findingsIn('select "id" from "sessions" where "sessions"."archived" = $1')).toEqual([])
  })

  it('finds an ORDER BY on a nullable column without NULLS FIRST/LAST', () => {
    // `sessions.stopped_at` is nullable, `sessions.created_at` and `sessions.id` are not.
    expect(
      findingsIn(
        'select "id" from "sessions" order by "sessions"."stopped_at" desc, "id" limit $1',
      ),
    ).toEqual(['ORDER BY nullable column stopped_at without NULLS FIRST/LAST'])
    expect(findingsIn('select max("id") over (order by "stopped_at") from "sessions"')).toEqual([
      'ORDER BY nullable column stopped_at without NULLS FIRST/LAST',
    ])
    expect(
      findingsIn('select "id" from "sessions" order by "stopped_at" asc nulls first, "created_at"'),
    ).toEqual([])
    expect(findingsIn('select "id" from "sessions" order by coalesce("stopped_at", $1)')).toEqual(
      [],
    )
  })
})
