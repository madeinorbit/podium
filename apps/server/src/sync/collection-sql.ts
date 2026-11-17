/**
 * COLLECTION RULES OVER THE SERVER'S TABLES (POD-7084, POD-7085, design POD-7059).
 *
 * A collection rule reads a record's saved fields. Here each such field of
 * every record type that has a rule is mapped to the SQL that reads the value
 * the record CARRIES, as its builder (`record-builders.ts`) computes it, not
 * merely the column of the same name:
 *
 *  - a session's `offer` is its `offers` row, dropped when the session's saved
 *    last input is newer than the offer (the boot install's staleness rule,
 *    `SessionRecords.fromRows`);
 *  - a session's `agentState` is its runtime turn state when one is recorded,
 *    else its observation checkpoint's turn state, else the row's
 *    `agent_state_json` (the order `SessionRecords.fromRows` applies them);
 *  - a session's `lastActiveAt` is the published activity time, which the
 *    synced record carries;
 *  - a deleted session has no record.
 *
 * Those three-table reads serve no index, so a rule that asks whether a
 * session waits for the user reads one saved column instead:
 * `sessions.asks_user` holds exactly the "asking" clauses above, and the
 * triggers of migration `20261117220206_session-asks-user` write it whenever
 * an input changes (POD-7104). Every clause set a column answers is replaced
 * by one test of that column (see {@link DerivedColumn}).
 *
 * The rules compile with `@podium/sync/collections`. `collection-sql.test.ts`
 * holds the SQL to the builder: on rows written through the store, every
 * declared rule answers in SQL exactly what it answers in JavaScript over the
 * built records.
 *
 * WHAT THE SQL MAY GET WRONG, AND WHY THE ANSWER IS STILL EXACT. The SQL reads
 * a JSON object field as present when it is an object; the builder drops an
 * object that fails its schema. So for a positive test on such a field the
 * SQL can select a record the rule does not hold for. The fetch
 * (`collection-fetch.ts`) therefore checks every selected record against the
 * rule in JavaScript, over the record as built, and keeps only those that
 * match: the SQL selects a superset, the answer is the rule's. That holds
 * while no rule NEGATES a test on a JSON field, where a dropped object would
 * make the SQL leave out a record the rule holds for; no declared rule does,
 * and `collection-fetch.test.ts` fails on the first one that would.
 *
 * The fetch runs these through `CollectionsRepository`
 * (`apps/server/src/store/collections.ts`), one prepared query per shape.
 */

import {
  type Clause,
  clausesOf,
  issueDepId,
  issueUserStateRowId,
  type PageSpec,
  type RuleArgs,
  type Scalar,
  sessionUserStateRowId,
  type Where,
} from '@podium/model'
import {
  type FieldSql,
  jsonObjectMemberSql,
  jsonObjectSql,
  jsonTextPath,
  type RuleSql,
  type RuleSqlTarget,
  ruleSql,
  type SqlValue,
} from '@podium/sync/collections'
import { getTableName } from 'drizzle-orm'
import {
  automationRuns,
  conversations,
  issueDeps,
  issueGitStates,
  issuePanelArtifacts,
  issuePanelDeferred,
  issuePanelStates,
  issuePanelTodos,
  issues,
  issueUserState,
  offers,
  runtimeEventCheckpoints,
  sessionObservationCheckpoints,
  sessions,
  sessionUserState,
  snoozes,
  workflowRuns,
} from '../migrations/schema'

const ROW = 'r'
const col = (column: { name: string }) => `${ROW}.${column.name}`

/** A session's agent state as its record carries it: JSON text, or NULL. */
function sessionAgentState(): string {
  const runtime = `(SELECT ${jsonObjectSql(`rt.${runtimeEventCheckpoints.turnStateJson.name}`)} FROM ${getTableName(runtimeEventCheckpoints)} AS rt WHERE rt.${runtimeEventCheckpoints.sessionId.name} = ${col(sessions.id)})`
  const checkpoint = `(SELECT ${jsonObjectMemberSql(`oc.${sessionObservationCheckpoints.checkpointJson.name}`, 'turnState')} FROM ${getTableName(sessionObservationCheckpoints)} AS oc WHERE oc.${sessionObservationCheckpoints.sessionId.name} = ${col(sessions.id)})`
  return `coalesce(${runtime}, ${checkpoint}, ${jsonObjectSql(col(sessions.agentStateJson))})`
}

/** A session's offer as its record carries it: the offer's time, or NULL. */
const sessionOffer = (): string =>
  `(SELECT o.${offers.createdAt.name} FROM ${getTableName(offers)} AS o WHERE o.${offers.sessionId.name} = ${col(sessions.id)} AND (${col(sessions.lastInputAt)} IS NULL OR NOT (${col(sessions.lastInputAt)} > o.${offers.createdAt.name})))`

/** A field as a rule reads it; `notNull` when the column never holds NULL. */
type ColumnSql = FieldSql & { readonly notNull?: boolean }

type Fields = Readonly<Record<string, () => ColumnSql>>

const plain =
  (column: { name: string; notNull?: boolean }, type: FieldSql['type'] = 'text') =>
  (): ColumnSql => ({ sql: col(column), type, notNull: column.notNull === true })

const SESSION_FIELDS: Fields = {
  sessionId: plain(sessions.id),
  status: plain(sessions.status),
  archived: plain(sessions.archived, 'boolean'),
  issueId: plain(sessions.issueId),
  agentKind: plain(sessions.agentKind),
  headless: plain(sessions.headless, 'boolean'),
  lastActiveAt: plain(sessions.publishedLastActiveAt),
  offer: () => ({ sql: sessionOffer(), type: 'text' }),
  agentState: () => ({ sql: sessionAgentState(), type: 'json' }),
}

/**
 * A saved column that holds whether a record matches any of `clauses`, kept
 * by the store as the record's builder would read them (POD-7104). Wherever
 * a rule holds every one of these clauses, each with the same further tests,
 * those clauses compile to one arm: `sql` and the further tests. `sql` keeps
 * its literal, so the column's partial index proves it and is sought.
 */
interface DerivedColumn {
  readonly clauses: readonly Clause[]
  readonly sql: string
}

/**
 * "Asking" as `sessions.asks_user` holds it, frozen as the migration that
 * writes the column computes it (its view `session_asks_user`), not read from
 * `ASKING_WHERE`: when the declared rule changes, its clauses stop matching
 * these and read the satellites again until a migration rewrites the column.
 * `session-asks-user.test.ts` holds the two equal.
 */
export const ASKS_USER_CLAUSES: readonly Clause[] = [
  { archived: false, offer: { not: { empty: true } } },
  { archived: false, 'agentState.phase': { in: ['needs_user', 'errored'] } },
  {
    archived: false,
    'agentState.phase': 'idle',
    'agentState.idle.kind': { in: ['question', 'approval'] },
  },
]

const ISSUE_FIELDS: Fields = {
  id: plain(issues.id),
  repoId: plain(issues.repoId),
  seq: plain(issues.seq, 'number'),
  parentId: plain(issues.parentId),
  stage: plain(issues.stage),
  closedReason: plain(issues.closedReason),
  archived: plain(issues.archived, 'boolean'),
  deletedAt: plain(issues.deletedAt),
  isDraftVessel: plain(issues.draft, 'boolean'),
  audience: plain(issues.audience),
  updatedAt: plain(issues.updatedAt),
}

/**
 * The rows of one record type, as a rule reads them: the FROM (aliased `r`),
 * the columns that name the record, and how they become its id.
 */
interface CollectionTable {
  /** The FROM expression, aliased {@link ROW}. */
  readonly from: string
  /** The table `descendantsOf` walks, for a type with a parent link. */
  readonly table: string
  readonly keys: readonly { name: string }[]
  /** The record id of a row's key values; `null` for a row with no record. */
  readonly idOf: (keys: readonly unknown[]) => string | null
  readonly fields: Fields
  readonly parent?: { name: string }
  /** What every record of the type satisfies, whatever the rule. */
  readonly base?: string
  /** A saved column that answers a set of clauses. */
  readonly derived?: DerivedColumn
}

const str = (value: unknown): string | null =>
  value === null || value === undefined ? null : String(value)

const ownId = (keys: readonly unknown[]) => str(keys[0])

const table = (
  of: Parameters<typeof getTableName>[0],
  keys: readonly { name: string }[],
  fields: Fields,
  more: Partial<Pick<CollectionTable, 'idOf' | 'parent' | 'base' | 'derived'>> = {},
): CollectionTable => ({
  from: `${getTableName(of)} AS ${ROW}`,
  table: getTableName(of),
  keys,
  idOf: ownId,
  fields,
  ...more,
})

/** Each panel kind: its own row, keyed by its id, under one issue. */
const panelTable = (
  of: typeof issuePanelTodos | typeof issuePanelArtifacts | typeof issuePanelDeferred,
) =>
  table(of, [of.id], {
    id: plain(of.id),
    issueId: plain(of.issueId),
  })

/** An issue body record: the issue row, keyed by the issue's id. */
const bodyTable = () => table(issues, [issues.id], { id: plain(issues.id) })

/**
 * A per-person session state exists for a read row or a snooze row. `UNION
 * ALL`, so each arm seeks its index and nothing is sorted; a pair on both
 * arms names one record, and the fetch keeps each id once.
 */
const SESSION_USER_STATE_FROM = `(SELECT ${sessionUserState.userId.name} AS user_id, ${sessionUserState.sessionId.name} AS session_id FROM ${getTableName(sessionUserState)} UNION ALL SELECT ${snoozes.userId.name}, ${snoozes.sessionId.name} FROM ${getTableName(snoozes)}) AS ${ROW}`

const TABLES = {
  session: table(sessions, [sessions.id], SESSION_FIELDS, {
    base: `${col(sessions.deletedAt)} IS NULL`,
    // `idx_sessions_asking` is partial on `asks_user = 1`.
    derived: { clauses: ASKS_USER_CLAUSES, sql: `${col(sessions.asksUser)} = 1` },
  }),
  issueProjection: table(issues, [issues.id], ISSUE_FIELDS, { parent: issues.parentId }),
  issueDep: table(
    issueDeps,
    [issueDeps.fromId, issueDeps.toId, issueDeps.type],
    { fromId: plain(issueDeps.fromId), toId: plain(issueDeps.toId) },
    {
      idOf: (keys) => {
        try {
          return issueDepId(String(keys[0]), String(keys[1]), String(keys[2]))
        } catch {
          return null
        }
      },
    },
  ),
  issueUserState: table(
    issueUserState,
    [issueUserState.userId, issueUserState.issueId],
    { entityId: plain(issueUserState.issueId), userId: plain(issueUserState.userId) },
    { idOf: (keys) => issueUserStateRowId(String(keys[0]) as never, String(keys[1]) as never) },
  ),
  sessionUserState: {
    from: SESSION_USER_STATE_FROM,
    table: getTableName(sessionUserState),
    keys: [{ name: 'user_id' }, { name: 'session_id' }],
    idOf: (keys) => sessionUserStateRowId(String(keys[0]) as never, String(keys[1]) as never),
    fields: {
      sessionId: () => ({ sql: `${ROW}.session_id`, type: 'text' }),
      userId: () => ({ sql: `${ROW}.user_id`, type: 'text' }),
    },
  },
  issueGitState: table(issueGitStates, [issueGitStates.issueId], {
    id: plain(issueGitStates.issueId),
  }),
  conversation: table(conversations, [conversations.id], {
    id: plain(conversations.id),
    // A missing time reads as the empty text, which no rule's time passes and
    // which sorts oldest; `idx_conversations_created_at` is on this expression.
    createdAt: () => ({
      sql: `coalesce(${col(conversations.createdAt)}, '')`,
      type: 'text',
      notNull: true,
    }),
  }),
  automationRun: table(
    automationRuns,
    [automationRuns.id],
    { id: plain(automationRuns.id), firedAt: plain(automationRuns.firedAt) },
    { base: `${col(automationRuns.deletedAt)} IS NULL` },
  ),
  workflowRun: table(workflowRuns, [workflowRuns.id], {
    id: plain(workflowRuns.id),
    startedAt: plain(workflowRuns.startedAt),
  }),
  issueBrief: bodyTable(),
  issueDescription: bodyTable(),
  issuePanelTodo: panelTable(issuePanelTodos),
  issuePanelArtifact: panelTable(issuePanelArtifacts),
  issuePanelDeferred: panelTable(issuePanelDeferred),
  issuePanelState: table(issuePanelStates, [issuePanelStates.id], {
    id: plain(issuePanelStates.id),
  }),
} as const satisfies Readonly<Record<string, CollectionTable>>

/** The record types whose collections the server answers in SQL. */
export type CollectionKind = keyof typeof TABLES

export const COLLECTION_KINDS = Object.keys(TABLES) as readonly CollectionKind[]

export const isCollectionKind = (kind: string): kind is CollectionKind => kind in TABLES

/** The fields of `kind` a rule may read in SQL. */
export const collectionFields = (kind: CollectionKind): readonly string[] =>
  Object.keys(TABLES[kind].fields)

/** The record id of a selected row's key columns, in their selected order. */
export const recordIdOf = (kind: CollectionKind, keys: readonly unknown[]): string | null =>
  (TABLES[kind] as CollectionTable).idOf(keys)

/** How many key columns a statement over `kind` selects. */
export const keyCount = (kind: CollectionKind): number => TABLES[kind].keys.length

/** How a rule over `kind` reads the server's tables. */
export function collectionTarget(kind: CollectionKind): RuleSqlTarget {
  const { table: name, keys, fields, parent } = TABLES[kind] as CollectionTable
  return {
    table: name,
    idColumn: keys[0]!.name,
    rowId: col(keys[0]!),
    ...(parent === undefined ? {} : { parentColumn: parent.name }),
    field(path) {
      const fieldName = Object.keys(fields).find(
        (field) => path === field || path.startsWith(`${field}.`),
      )
      if (fieldName === undefined) return undefined
      const field = fields[fieldName]!()
      if (fieldName === path) return field
      return {
        sql: jsonTextPath(field.sql, path.slice(fieldName.length + 1).split('.')),
        type: 'text',
      }
    },
  }
}

/** A rule's value, or a clause's, as one comparable text: keys sorted, arrays in order. */
function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`)
    .join(',')}}`
}

/** What `clause` tests beyond `part`, when it tests everything `part` tests; else undefined. */
function beyond(clause: Clause, part: Clause): Clause | undefined {
  for (const [path, test] of Object.entries(part)) {
    if (!(path in clause) || canonical(clause[path]) !== canonical(test)) return undefined
  }
  return Object.fromEntries(Object.entries(clause).filter(([path]) => !(path in part)))
}

/** One arm of a rule as it compiles: a declared clause, or a derived column with further tests. */
type Arm = { readonly clause: Clause } | { readonly derived: string; readonly also: Clause }

/**
 * The rule's clauses with every complete set a derived column answers folded
 * into one arm, at the place of the set's first clause. A set is complete
 * when, for one choice of further tests, the rule holds each of the column's
 * clauses with exactly those tests added.
 */
function armsOf(clauses: readonly Clause[], derived: DerivedColumn | undefined): Arm[] {
  if (derived === undefined) return clauses.map((clause) => ({ clause }))
  const sets = new Map<string, { also: Clause; members: Map<number, number> }>()
  clauses.forEach((clause, at) => {
    for (const [which, part] of derived.clauses.entries()) {
      const also = beyond(clause, part)
      if (also === undefined) continue
      const key = canonical(also)
      const set = sets.get(key) ?? { also, members: new Map<number, number>() }
      if (!set.members.has(which)) set.members.set(which, at)
      sets.set(key, set)
      break
    }
  })
  const folded = new Map<number, Clause>()
  const consumed = new Set<number>()
  for (const { also, members } of sets.values()) {
    if (members.size !== derived.clauses.length) continue
    const at = [...members.values()]
    folded.set(Math.min(...at), also)
    for (const index of at) consumed.add(index)
  }
  const arms: Arm[] = []
  clauses.forEach((clause, at) => {
    const also = folded.get(at)
    if (also !== undefined) arms.push({ derived: derived.sql, also })
    else if (!consumed.has(at)) arms.push({ clause })
  })
  return arms
}

/** A rule over `kind` as a WHERE fragment, reading a derived column wherever one answers. */
function kindRuleSql(kind: CollectionKind, where: Where, args: RuleArgs, now: number): RuleSql {
  const target = collectionTarget(kind)
  const arms = armsOf(clausesOf(where), (TABLES[kind] as CollectionTable).derived)
  if (arms.every((arm) => 'clause' in arm)) return ruleSql(where, target, args, now)
  const params: SqlValue[] = []
  const parts = arms.map((arm) => {
    if ('clause' in arm) {
      const compiled = ruleSql(arm.clause, target, args, now)
      params.push(...compiled.params)
      return compiled.sql
    }
    if (Object.keys(arm.also).length === 0) return `(${arm.derived})`
    const also = ruleSql(arm.also, target, args, now)
    params.push(...also.params)
    return `(${arm.derived} AND ${also.sql})`
  })
  return { sql: parts.length === 1 ? parts[0]! : `(${parts.join(' OR ')})`, params }
}

/** The ids of the records of `kind` the rule selects, as one statement (session and issue). */
export function collectionQuery(
  kind: CollectionKind,
  where: Where,
  args: RuleArgs,
  now: number,
): RuleSql {
  const { from, keys, base } = TABLES[kind] as CollectionTable
  const rule = kindRuleSql(kind, where, args, now)
  return {
    sql: `SELECT ${col(keys[0]!)} AS id FROM ${from} WHERE ${base === undefined ? '' : `${base} AND `}${rule.sql}`,
    params: rule.params,
  }
}

// ---------------------------------------------------------------------------
// The fetch's statements
// ---------------------------------------------------------------------------

/** What a fetch statement selects beyond the rule. */
export type StatementMode =
  /** Every selected record's key columns. */
  | { readonly kind: 'ids' }
  /**
   * A paged collection in its sort order: key columns, then each sort field's
   * value; `after` continues below a position, `limit` bounds the rows.
   */
  | {
      readonly kind: 'page'
      readonly sort: PageSpec['sort']
      readonly after: boolean
      readonly limit: boolean
    }

export interface CollectionStatement {
  /** The selected expressions: the key columns, then the sort values. */
  readonly select: readonly string[]
  /** The FROM expression; it may hold parameters (the ancestor walk). */
  readonly from: string
  readonly where: string
  readonly orderBy?: string
  /** A trailing `LIMIT` parameter, the last of {@link params}. */
  readonly limit: boolean
  /** Every parameter, in the order the parts above hold them. */
  readonly params: readonly SqlValue[]
  /** The whole statement, with positional parameters. */
  readonly sql: string
}

function assemble(parts: Omit<CollectionStatement, 'sql'>): CollectionStatement {
  const tail =
    (parts.orderBy === undefined ? '' : ` ORDER BY ${parts.orderBy}`) +
    (parts.limit ? ' LIMIT ?' : '')
  return {
    ...parts,
    sql: `SELECT ${parts.select.map((expr, at) => `${expr} AS c${at}`).join(', ')} FROM ${parts.from} WHERE ${parts.where}${tail}`,
  }
}

/**
 * A sort field's value. A column that may hold NULL reads NULL as the empty
 * text, so the order and the position compare alike; a NOT NULL column is
 * read as it is, so an index on it serves the order.
 */
function sortSql(kind: CollectionKind, field: string): string {
  const sql = collectionTarget(kind).field(field) as ColumnSql | undefined
  if (sql === undefined) throw new Error(`no column for sort field ${field} of ${kind}`)
  return sql.type === 'text' && sql.notNull !== true ? `coalesce(${sql.sql}, '')` : sql.sql
}

/**
 * The rows strictly after `after` in the sort order: one arm per sort field,
 * behind a bound on the first field alone (`<=` descending, `>=` ascending).
 * The bound adds no condition the arms lack, but it is the range an index on
 * the first field seeks; the OR of the arms alone plans as a scan.
 */
function keysetSql(
  sorts: readonly string[],
  sort: PageSpec['sort'],
  after: readonly Scalar[],
  params: SqlValue[],
): string {
  const mark = (value: Scalar) => {
    params.push(value)
    return '?'
  }
  const bound = `${sorts[0]} ${sort[0]!.direction === 'desc' ? '<=' : '>='} ${mark(after[0] ?? '')}`
  const arms: string[] = []
  for (let at = 0; at < sort.length; at++) {
    const tests: string[] = []
    for (let before = 0; before < at; before++)
      tests.push(`${sorts[before]} = ${mark(after[before] ?? '')}`)
    tests.push(
      `${sorts[at]} ${sort[at]!.direction === 'desc' ? '<' : '>'} ${mark(after[at] ?? '')}`,
    )
    arms.push(`(${tests.join(' AND ')})`)
  }
  return `(${bound} AND (${arms.join(' OR ')}))`
}

/**
 * One statement of the fetch: the records of `kind` the rule selects, under
 * the record type's base condition. A paged mode orders by the declared sort
 * (the id last, so the order is total) and continues strictly below `after`.
 */
export function collectionStatement(
  kind: CollectionKind,
  where: Where | undefined,
  args: RuleArgs,
  now: number,
  mode: StatementMode,
  after: readonly Scalar[] = [],
  limit = 0,
): CollectionStatement {
  const { from, keys, base } = TABLES[kind] as CollectionTable
  const rule =
    where === undefined
      ? { sql: '(1 = 1)', params: [] as readonly SqlValue[] }
      : kindRuleSql(kind, where, args, now)
  const params: SqlValue[] = [...rule.params]
  const select = keys.map((key) => col(key))
  const conditions = [...(base === undefined ? [] : [base]), rule.sql]
  let orderBy: string | undefined
  let limited = false
  if (mode.kind === 'page') {
    const sorts = mode.sort.map((s) => sortSql(kind, s.field))
    select.push(...sorts)
    if (mode.after) conditions.push(keysetSql(sorts, mode.sort, after, params))
    orderBy = sorts
      .map((sql, at) => `${sql} ${mode.sort[at]!.direction === 'desc' ? 'DESC' : 'ASC'}`)
      .join(', ')
    if (mode.limit) {
      params.push(limit)
      limited = true
    }
  }
  return assemble({
    select,
    from,
    where: conditions.join(' AND '),
    ...(orderBy === undefined ? {} : { orderBy }),
    limit: limited,
    params,
  })
}

/**
 * Every ancestor of the given issues, as one walk up the parent column: what
 * "an issue comes with its parent" reaches, transitively, in one statement.
 * The given issues themselves are not in the answer unless one is another's
 * ancestor.
 */
export function ancestorsStatement(ids: readonly string[]): CollectionStatement {
  const marks = ids.map(() => '?')
  const name = getTableName(issues)
  const id = issues.id.name
  const parent = issues.parentId.name
  return assemble({
    select: ['up.id'],
    from:
      `(WITH RECURSIVE walk(id) AS (` +
      `SELECT start.${parent} FROM ${name} AS start WHERE start.${id} IN (${marks.join(', ')}) AND start.${parent} IS NOT NULL ` +
      `UNION SELECT next.${parent} FROM ${name} AS next JOIN walk ON next.${id} = walk.id WHERE next.${parent} IS NOT NULL` +
      `) SELECT id FROM walk) AS up`,
    where: '1 = 1',
    limit: false,
    params: [...ids],
  })
}

/**
 * The rule with the keyed collection's one argument read as a list: the
 * records of every holder's instance at once ("the sessions of these
 * issues"). `param` is the instance's argument; its `eq` becomes `in`.
 */
export function keyedWhere(where: Where, param: string): Where {
  const keyed = (clause: Clause): Clause =>
    Object.fromEntries(
      Object.entries(clause).map(([path, test]) => {
        if (
          test !== null &&
          typeof test === 'object' &&
          'eq' in test &&
          typeof test.eq === 'object' &&
          test.eq !== null &&
          'param' in test.eq &&
          test.eq.param === param
        ) {
          return [path, { in: test.eq }]
        }
        return [path, test]
      }),
    )
  const clauses = clausesOf(where).map(keyed)
  return clauses.length === 1 ? clauses[0]! : clauses
}
