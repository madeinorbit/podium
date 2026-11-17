/**
 * THE SHIPPING TABLES' IMMUTABILITY, AS POSTGRES ENFORCES IT (POD-6986, POD-6958 design
 * 2.5).
 *
 * On SQLite, 32 triggers (`RAISE(ABORT, …)`) guard the 13 shipping and receipt tables:
 * append-only tables, rows a terminal state freezes, columns frozen at creation, and
 * insert guards that check other tables. Postgres gets no triggers (a trigger needs
 * PL/pgSQL, and the same Postgres SQL must later run on an engine without it), so the
 * same rules live in the write path, each declared here once, with the trigger's text
 * ({@link GUARD_TEXT}):
 *
 *  - {@link APPEND_ONLY}: a table, or one operation on it, that no write may touch.
 *  - {@link UPDATE_RULES}: an update's frozen columns, and its fence (the rows the rule
 *    freezes: a terminal order, a finished attempt, a resolved hold, a released manifest).
 *  - {@link DELETE_RULES}: a delete allowed only on some rows (an active claim, once its
 *    manifest is released).
 *  - {@link INSERT_RULES}: an insert's guards. `store/shipping.ts` writes the order, train
 *    member and claim inserts as `INSERT … SELECT … FROM (VALUES (1)) WHERE <refusal>`, and
 *    the census refuses an insert into one of those tables without its refusals.
 *
 * ONE DECLARATION, TWO REFUSALS. {@link writeGuard} turns a write's declarations into
 * its Postgres form: an UPDATE or DELETE of an append-only table (or an upsert that
 * would update one) is refused when the statement is built, and a conditional rule
 * becomes an in-statement refusal ({@link refusalTerm}) over the rows the write
 * touches. `captureWrite` (`sync/capture-pg.ts`) applies it to every write it is handed,
 * and every Postgres write on a source table must go through `captureWrite` (the write
 * census refuses any other), so a write that bypassed the guard there would already fail
 * that census. The guarded tables that are not source tables are written only by
 * `store/shipping.ts`, whose train inserts, claim release and manifest release carry the
 * same refusals in their own statements; the immutability census
 * (`immutability-census.test.ts`) renders every Postgres definition and refuses an
 * UPDATE or DELETE of an append-only table, a frozen column assigned, a guarded update or
 * delete with neither its fence nor its refusal, or a guarded insert without its refusal.
 *
 * ONE ERROR ON BOTH ENGINES. An in-statement refusal fails with SQLSTATE 22P02 carrying
 * the trigger's text; the Postgres driver (`executor/pg-types.ts`, `translatePgError`)
 * turns exactly that into {@link ShippingGuardError}, which has the name, message, code
 * and errno of the error SQLite's trigger raises. A refusal adds no statement.
 *
 * Every lookup a guard makes is held to the written row's workspace, as the SQLite
 * triggers match `workspace_id = NEW.workspace_id` (POD-7024).
 *
 * SQLite keeps its triggers; nothing here changes a SQLite statement. Nor is any of it a
 * NOT NULL or CHECK on Postgres: orders written before lane custody existed hold NULL
 * custody, and the hosted import copies them, which is also why SQLite uses a trigger.
 */

import { type SQL, sql } from 'drizzle-orm'

/** The text each SQLite trigger raises, by trigger name. */
export const GUARD_TEXT = {
  delivery_receipts_immutable: 'delivery receipt is immutable',
  root_integration_receipts_immutable: 'root integration receipt is immutable',
  ship_attempts_delete_immutable: 'ship attempt history is immutable',
  ship_attempts_terminal_immutable: 'terminal ship attempt is immutable',
  ship_effect_envelopes_immutable: 'ship effect envelope is immutable',
  ship_evidence_immutable: 'ship evidence is immutable',
  ship_holds_delete_immutable: 'ship hold history is immutable',
  ship_holds_resolved_immutable: 'resolved ship hold is immutable',
  ship_order_stack_edges_immutable: 'ship order stack edge is immutable',
  ship_orders_delete_immutable: 'ship order history is immutable',
  ship_orders_frozen_fields: 'ship order approval is immutable',
  ship_orders_lane_custody_immutable: 'ship order lane custody is immutable',
  ship_orders_lane_custody_insert: 'new ship order requires frozen lane custody',
  ship_orders_terminal_immutable: 'terminal ship order is immutable',
  ship_repair_candidates_delete_immutable: 'ship repair candidate history is immutable',
  ship_repair_candidates_update_immutable: 'ship repair candidate is immutable',
  ship_steps_immutable: 'ship steps are append-only',
  ship_train_active_claims_insert_guard:
    'active train claim requires complete normalized leader authority',
  ship_train_active_claims_release_guard: 'active train claims release manifest-wide only',
  ship_train_active_claims_update_immutable: 'active train claim is immutable',
  ship_train_manifests_delete_immutable: 'ship train manifest history is immutable',
  ship_train_manifests_release_only: 'ship train manifest is immutable except for one release',
  ship_train_members_delete_immutable: 'ship train member history is immutable',
  ship_train_members_final_leader: 'ship train final member must be its leader',
  ship_train_members_ordinal: 'ship train member ordinal exceeds immutable member count',
  ship_train_members_sealed: 'ship train members are sealed after active claim',
  ship_train_members_update_immutable: 'ship train member is immutable',
} as const

/** What an append-only table refuses: each operation's trigger text, when it refuses it. */
export interface AppendOnly {
  readonly update?: string
  readonly delete?: string
}

/**
 * The tables, by SQL name, whose UPDATE or DELETE no write may make. An operation not
 * listed is either free or conditional ({@link UPDATE_RULES}, {@link DELETE_RULES}).
 */
export const APPEND_ONLY: ReadonlyMap<string, AppendOnly> = new Map<string, AppendOnly>([
  [
    'delivery_receipts',
    {
      update: GUARD_TEXT.delivery_receipts_immutable,
      delete: GUARD_TEXT.delivery_receipts_immutable,
    },
  ],
  [
    'root_integration_receipts',
    {
      update: GUARD_TEXT.root_integration_receipts_immutable,
      delete: GUARD_TEXT.root_integration_receipts_immutable,
    },
  ],
  ['ship_attempts', { delete: GUARD_TEXT.ship_attempts_delete_immutable }],
  [
    'ship_effect_envelopes',
    {
      update: GUARD_TEXT.ship_effect_envelopes_immutable,
      delete: GUARD_TEXT.ship_effect_envelopes_immutable,
    },
  ],
  [
    'ship_evidence',
    { update: GUARD_TEXT.ship_evidence_immutable, delete: GUARD_TEXT.ship_evidence_immutable },
  ],
  ['ship_holds', { delete: GUARD_TEXT.ship_holds_delete_immutable }],
  [
    'ship_order_stack_edges',
    {
      update: GUARD_TEXT.ship_order_stack_edges_immutable,
      delete: GUARD_TEXT.ship_order_stack_edges_immutable,
    },
  ],
  ['ship_orders', { delete: GUARD_TEXT.ship_orders_delete_immutable }],
  [
    'ship_repair_candidates',
    {
      update: GUARD_TEXT.ship_repair_candidates_update_immutable,
      delete: GUARD_TEXT.ship_repair_candidates_delete_immutable,
    },
  ],
  [
    'ship_steps',
    { update: GUARD_TEXT.ship_steps_immutable, delete: GUARD_TEXT.ship_steps_immutable },
  ],
  ['ship_train_active_claims', { update: GUARD_TEXT.ship_train_active_claims_update_immutable }],
  ['ship_train_manifests', { delete: GUARD_TEXT.ship_train_manifests_delete_immutable }],
  [
    'ship_train_members',
    {
      update: GUARD_TEXT.ship_train_members_update_immutable,
      delete: GUARD_TEXT.ship_train_members_delete_immutable,
    },
  ],
])

/**
 * A fence: a term of the rendered Postgres statement that keeps a write off the rows a
 * rule freezes, with the rule's text. Matched against the statement as `captureWrite`
 * and drizzle render it (lower-case keywords, quoted names).
 */
export interface Fence {
  readonly text: string
  /** Whether the rendered statement carries the fence. */
  readonly holds: (statement: string) => boolean
  /**
   * When the rule refuses, as SQL over the written row's current values (`row(c)` names
   * its column `c`): the condition of the SQLite trigger's WHEN, which the in-statement
   * refusal ({@link writeGuard}) raises on.
   */
  readonly refuses: (row: RowRef) => string
}

/** A row's column, as SQL: `"table"."column"`. */
export type RowRef = (column: string) => string

/** The conditional rules of an update. */
export interface UpdateRule {
  /** Columns no update may assign, each with its trigger's text. */
  readonly frozen: ReadonlyMap<string, string>
  /** Columns an update may assign, when the rule allows only those; others are refused. */
  readonly only?: { readonly columns: readonly string[]; readonly text: string }
  readonly fence?: Fence
}

/** `"col" in (…)` / `"col" not in (…)` / `"col" = …`, with or without a table prefix. */
const column = (name: string): string => `(?:"[a-z_]+"\\.)?"${name}"`

/** The states an order never leaves. */
const TERMINAL_ORDER_STATES = ['shipped', 'cancelled'] as const

/**
 * The order fence: the update names its row's state, and never a terminal one. Either
 * `state NOT IN (…every terminal state…)` or `state = '<a live state>'`; a state given
 * by a parameter needs the NOT IN beside it.
 */
const orderFence: Fence = {
  text: GUARD_TEXT.ship_orders_terminal_immutable,
  refuses: (row) =>
    `${row('state')} IN (${TERMINAL_ORDER_STATES.map((state) => `'${state}'`).join(', ')})`,
  holds: (statement) => {
    const notIn = new RegExp(`${column('state')} not in \\(([^)]*)\\)`, 'g')
    for (const match of statement.matchAll(notIn)) {
      const listed = match[1] as string
      if (TERMINAL_ORDER_STATES.every((state) => listed.includes(`'${state}'`))) return true
    }
    const equal = new RegExp(`${column('state')} = '([a-z_]+)'`, 'g')
    for (const match of statement.matchAll(equal)) {
      if (!(TERMINAL_ORDER_STATES as readonly string[]).includes(match[1] as string)) return true
    }
    return false
  },
}

const isNullFence = (name: string, text: string): Fence => ({
  text,
  holds: (statement) => new RegExp(`${column(name)} is null`).test(statement),
  refuses: (row) => `${row(name)} IS NOT NULL`,
})

/** The order columns frozen when it is approved, as `ship_orders_frozen_fields` lists them. */
const APPROVAL_COLUMNS = [
  'issue_id',
  'repo_id',
  'target_branch',
  'destination',
  'approved_base_sha',
  'approved_head_sha',
  'descendant_manifest',
  'delivery_depends_on',
  'evidence_manifest_ref',
  'current_integration_receipt',
  'provider_ref',
  'requested_by_actor_kind',
  'requested_by_actor_id',
  'requested_by_on_behalf_of',
  'requested_at',
  'policy_id',
  'validation_profile',
  'validation_profile_digest',
  'close_mode',
] as const

/** The rules of an UPDATE, by table SQL name. A table not here and not append-only is free. */
export const UPDATE_RULES: ReadonlyMap<string, UpdateRule> = new Map<string, UpdateRule>([
  [
    'ship_orders',
    {
      frozen: new Map<string, string>([
        ...APPROVAL_COLUMNS.map((name) => [name, GUARD_TEXT.ship_orders_frozen_fields] as const),
        ['repo_path', GUARD_TEXT.ship_orders_lane_custody_immutable],
        ['machine_id', GUARD_TEXT.ship_orders_lane_custody_immutable],
      ]),
      fence: orderFence,
    },
  ],
  [
    'ship_attempts',
    {
      frozen: new Map(),
      fence: isNullFence('finished_at', GUARD_TEXT.ship_attempts_terminal_immutable),
    },
  ],
  [
    'ship_holds',
    {
      frozen: new Map(),
      fence: isNullFence('resolved_at', GUARD_TEXT.ship_holds_resolved_immutable),
    },
  ],
  [
    'ship_train_manifests',
    {
      frozen: new Map(),
      only: {
        columns: ['released_at', 'release_reason'],
        text: GUARD_TEXT.ship_train_manifests_release_only,
      },
      fence: isNullFence('released_at', GUARD_TEXT.ship_train_manifests_release_only),
    },
  ],
])

/** The rules of a DELETE allowed only on some rows, by table SQL name. */
export const DELETE_RULES: ReadonlyMap<string, Fence> = new Map<string, Fence>([
  [
    'ship_train_active_claims',
    {
      text: GUARD_TEXT.ship_train_active_claims_release_guard,
      // The claims' manifest is released: `EXISTS (SELECT … m.released_at IS NOT NULL)`.
      holds: (statement) => /exists \(select .*\breleased_at"? is not null/i.test(statement),
      // Its manifest, in the claim's own workspace, is still open.
      refuses: (row) =>
        `EXISTS (SELECT 1 FROM "ship_train_manifests" m WHERE m.workspace_id = ${row('workspace_id')} AND m.id = ${row('train_id')} AND m.released_at IS NULL)`,
    },
  ],
])

/**
 * The rules of an INSERT, by table SQL name: the insert must carry the rule's
 * in-statement refusal. `ship_orders_lane_custody_insert` reads only the inserted row's
 * values (no order without its frozen lane custody); the train inserts' guards read other
 * tables and are written by `store/shipping.ts` alone.
 */
export const INSERT_RULES: ReadonlyMap<string, readonly string[]> = new Map<
  string,
  readonly string[]
>([
  ['ship_orders', [GUARD_TEXT.ship_orders_lane_custody_insert]],
  [
    'ship_train_members',
    [
      GUARD_TEXT.ship_train_members_ordinal,
      GUARD_TEXT.ship_train_members_sealed,
      GUARD_TEXT.ship_train_members_final_leader,
    ],
  ],
  ['ship_train_active_claims', [GUARD_TEXT.ship_train_active_claims_insert_guard]],
])

/** One write in rendered SQL, as the census reads it. */
export interface GuardedWrite {
  readonly op: 'i' | 'u' | 'd'
  readonly table: string
  /** For an update: the columns its SET assigns. */
  readonly setColumns?: readonly string[]
  /** For an insert: whether it is an upsert (ON CONFLICT … DO UPDATE). */
  readonly upsert?: boolean
}

/** Whether a rendered statement carries the in-statement refusal of `text` ({@link refusalTerm}). */
const refusesInStatement = (statement: string, text: string): boolean =>
  statement.includes(`THEN '${text}'`)

/**
 * Why a rendered Postgres statement breaks a rule of this module, one line per broken
 * rule (empty when it keeps them all). `writes` are the statement's writes, as
 * `renderedWrites` (`sync/capture-pg.ts`) reads them.
 */
export function immutabilityViolations(
  statement: string,
  writes: readonly GuardedWrite[],
): string[] {
  const out: string[] = []
  for (const write of writes) {
    const appendOnly = APPEND_ONLY.get(write.table)
    if (write.op === 'u') {
      if (appendOnly?.update !== undefined) {
        out.push(`update ${write.table}: ${appendOnly.update}`)
        continue
      }
      const rule = UPDATE_RULES.get(write.table)
      if (rule === undefined) continue
      for (const name of write.setColumns ?? []) {
        const frozen = rule.frozen.get(name)
        if (frozen !== undefined) out.push(`update ${write.table} sets ${name}: ${frozen}`)
        else if (rule.only !== undefined && !rule.only.columns.includes(name)) {
          out.push(`update ${write.table} sets ${name}: ${rule.only.text}`)
        }
      }
      const fence = rule.fence
      if (
        fence !== undefined &&
        !fence.holds(statement) &&
        !refusesInStatement(statement, fence.text)
      ) {
        out.push(`update ${write.table} without its fence: ${fence.text}`)
      }
    } else if (write.op === 'd') {
      if (appendOnly?.delete !== undefined) {
        out.push(`delete from ${write.table}: ${appendOnly.delete}`)
        continue
      }
      const fence = DELETE_RULES.get(write.table)
      if (
        fence !== undefined &&
        !fence.holds(statement) &&
        !refusesInStatement(statement, fence.text)
      ) {
        out.push(`delete from ${write.table} without its fence: ${fence.text}`)
      }
    } else if (write.op === 'i') {
      if (write.upsert === true && appendOnly?.update !== undefined) {
        // ON CONFLICT … DO UPDATE updates the row it meets.
        out.push(`upsert into ${write.table}: ${appendOnly.update}`)
      }
      for (const text of INSERT_RULES.get(write.table) ?? []) {
        if (!refusesInStatement(statement, text)) {
          out.push(`insert into ${write.table} without its refusal: ${text}`)
        }
      }
    }
  }
  return out
}

/** Every table a rule of this module guards. */
export const GUARDED_TABLES: ReadonlySet<string> = new Set([
  ...APPEND_ONLY.keys(),
  ...INSERT_RULES.keys(),
  ...UPDATE_RULES.keys(),
  ...DELETE_RULES.keys(),
])

// ---------------------------------------------------------------------------
// The write forms
// ---------------------------------------------------------------------------

/**
 * A REFUSAL WRITTEN INTO THE STATEMENT. Postgres runs no trigger, and plain SQL has no
 * RAISE, so a statement refuses a row by failing on it:
 *
 * ```sql
 * CAST(CASE WHEN <the row is not written> THEN NULL
 *           WHEN <rule 1 refuses> THEN '<trigger text 1>' … END AS integer) IS NULL
 * ```
 *
 * A row no rule refuses casts NULL and passes; a row a rule refuses casts the trigger's
 * text, which is not an integer, so the statement fails with SQLSTATE 22P02 carrying that
 * text, atomically and in the one statement the write already is. The first arm keeps the
 * term off rows the write does not touch: `scope` is the write's own WHERE, and a CASE
 * evaluates its arms in order, wherever the planner places the term. The driver turns
 * that failure into {@link ShippingGuardError} ({@link guardRefusalOf}).
 *
 * Each case's condition must read the row (a column, or a lookup keyed by one), so that
 * the term is evaluated per row and never folded to a constant at planning.
 */
export function refusalTerm(
  cases: readonly { readonly when: SQL; readonly text: string }[],
  scope?: SQL,
): SQL {
  const arms = cases.map(({ when, text }) => sql` WHEN ${when} THEN ${sql.raw(literal(text))}`)
  const skip = scope === undefined ? sql`` : sql` WHEN (${scope}) IS NOT TRUE THEN NULL`
  return sql`CAST(CASE${skip}${sql.join(arms, sql``)} END AS integer) IS NULL`
}

/** A guard text as a SQL string literal. */
function literal(text: string): string {
  if (!(GUARD_TEXTS as ReadonlySet<string>).has(text)) {
    throw new Error(`refusalTerm: ${JSON.stringify(text)} is not a declared guard text`)
  }
  return `'${text.replaceAll("'", "''")}'`
}

/** Every declared guard text. */
export const GUARD_TEXTS: ReadonlySet<string> = new Set(Object.values(GUARD_TEXT))

/** What a write is, as {@link writeGuard} reads it. */
export interface WriteShape {
  readonly table: string
  readonly op: 'i' | 'u' | 'd'
  /** An update's SET columns, or an upsert's DO UPDATE columns. */
  readonly setColumns?: readonly string[]
  /** For an insert: whether it is an upsert (ON CONFLICT … DO UPDATE). */
  readonly upsert?: boolean
}

/** How a guarded write's statement changes on Postgres. */
export interface WriteGuardForm {
  /** The term to AND into the write's WHERE, given that WHERE. */
  readonly where?: (where: SQL | undefined) => SQL
  /** The term an upsert's DO UPDATE carries as its WHERE: refusing the row it would update. */
  readonly conflict?: SQL
}

/** `"table"."column"`. */
const rowOf =
  (table: string): RowRef =>
  (column) =>
    `"${table}"."${column}"`

/** The cases an update of `table` assigning `setColumns` refuses on, in SQLite's order. */
function updateCases(
  table: string,
  rule: UpdateRule,
  setColumns: readonly string[],
): { when: SQL; text: string }[] {
  const row = rowOf(table)
  const cases: { when: SQL; text: string }[] = []
  // A frozen column is refused for every row the update writes (`BEFORE UPDATE OF`), so
  // its condition is the row being there: its first primary key column is never NULL.
  const present = sql.raw(`${row('workspace_id')} IS NOT NULL`)
  if (rule.fence !== undefined)
    cases.push({ when: sql.raw(rule.fence.refuses(row)), text: rule.fence.text })
  for (const name of setColumns) {
    const frozen = rule.frozen.get(name)
    if (frozen !== undefined) cases.push({ when: present, text: frozen })
    else if (rule.only !== undefined && !rule.only.columns.includes(name)) {
      cases.push({ when: present, text: rule.only.text })
    }
  }
  return cases
}

/**
 * THE GUARD OF ONE POSTGRES WRITE (design 2.5), from the declarations above; undefined
 * for a table no rule guards. `captureWrite` applies it to every write it is handed,
 * which is every write on a source table (the write census refuses any other), so the
 * guard cannot be bypassed there; a write on a guarded table that is not a source table
 * is held by the immutability census to its fence.
 *
 *  - An UPDATE or DELETE of an append-only table, and an upsert that would update one,
 *    is refused when the statement is built: it throws {@link ShippingGuardError} with
 *    the trigger's text, so a definition that makes one fails when it is prepared.
 *  - A conditional rule becomes an in-statement refusal ({@link refusalTerm}) over the
 *    rows the write touches: their current values, as SQLite's `OLD`.
 */
export function writeGuard(shape: WriteShape): WriteGuardForm | undefined {
  if (!GUARDED_TABLES.has(shape.table)) return undefined
  const appendOnly = APPEND_ONLY.get(shape.table)
  if (shape.op === 'u' || (shape.op === 'i' && shape.upsert === true)) {
    if (appendOnly?.update !== undefined) throw new ShippingGuardError(appendOnly.update)
    const rule = UPDATE_RULES.get(shape.table)
    if (rule === undefined) return undefined
    const cases = updateCases(shape.table, rule, shape.setColumns ?? [])
    if (cases.length === 0) return undefined
    if (shape.op === 'i') return { conflict: refusalTerm(cases) }
    return {
      where: (where) =>
        where === undefined ? refusalTerm(cases) : sql`(${where}) and ${refusalTerm(cases, where)}`,
    }
  }
  if (shape.op === 'd') {
    if (appendOnly?.delete !== undefined) throw new ShippingGuardError(appendOnly.delete)
    const fence = DELETE_RULES.get(shape.table)
    if (fence === undefined) return undefined
    const cases = [{ when: sql.raw(fence.refuses(rowOf(shape.table))), text: fence.text }]
    return {
      where: (where) =>
        where === undefined ? refusalTerm(cases) : sql`(${where}) and ${refusalTerm(cases, where)}`,
    }
  }
  return undefined
}

/**
 * A SHIPPING GUARD'S REFUSAL, AS SQLITE'S TRIGGER RAISES IT. On SQLite a trigger's
 * `RAISE(ABORT, '<text>')` throws bun's `SQLiteError` with that text as its message, code
 * `SQLITE_CONSTRAINT_TRIGGER` and errno 1811. bun constructs that class only itself, so
 * Postgres raises this one with the same name, message, code and errno, and a caller (or
 * a test) reading any of them sees one error on both engines.
 */
export class ShippingGuardError extends Error {
  override readonly name = 'SQLiteError'
  readonly code = 'SQLITE_CONSTRAINT_TRIGGER'
  readonly errno = 1811
  readonly byteOffset = -1
}

/** What Postgres says when an in-statement refusal casts a guard text to an integer. */
const REFUSED_CAST = /^invalid input syntax for type integer: "(.*)"$/s

/**
 * The guard refusal a Postgres failure is, or undefined: a `22P02` whose text is one of
 * the declared guard texts (and nothing else) is {@link refusalTerm}'s, and becomes a
 * {@link ShippingGuardError} with that text. Any other `22P02`, a genuine integer syntax
 * error included, is not a refusal. The raw error is not kept: callers see the refusal.
 */
export function guardRefusalOf(error: unknown): ShippingGuardError | undefined {
  const failure = error as { code?: unknown; message?: unknown } | null
  if (failure?.code !== '22P02' || typeof failure.message !== 'string') return undefined
  const text = REFUSED_CAST.exec(failure.message)?.[1]
  return text !== undefined && GUARD_TEXTS.has(text) ? new ShippingGuardError(text) : undefined
}
