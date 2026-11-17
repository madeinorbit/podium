/**
 * THE SHIPPING TABLES' IMMUTABILITY, AS POSTGRES ENFORCES IT (POD-6986, POD-6958 design
 * 2.5).
 *
 * On SQLite, 32 triggers (`RAISE(ABORT, …)`) guard the 13 shipping and receipt tables:
 * append-only tables, rows a terminal state freezes, columns frozen at creation, and
 * insert guards that check other tables. Postgres gets no triggers (a trigger needs
 * PL/pgSQL, and the store uses no stored procedures), so the same rules live in the
 * write path, declared here once:
 *
 *  - {@link APPEND_ONLY}: a table, or one operation on it, that no write may touch. The
 *    immutability census (`immutability-census.test.ts`) renders every Postgres
 *    definition and refuses any UPDATE or DELETE of one.
 *  - {@link UPDATE_RULES}: the conditional rules of an update. Its frozen columns may not
 *    be assigned, and its fence (the WHERE term that keeps the update off the rows the
 *    rule freezes: a terminal order, a finished attempt, a resolved hold, a released
 *    manifest) must be in the statement. The census checks both on every update.
 *  - {@link DELETE_RULES}: a delete allowed only on rows a fence admits (an active
 *    claim, once its manifest is released).
 *  - Insert guards: the repository's insert is `INSERT … SELECT … WHERE <guard>` on
 *    Postgres ({@link insertWhere}), and when it inserts nothing the repository raises
 *    the trigger's text.
 *
 * Each rule carries the SQLite trigger's own text ({@link GUARD_TEXT}), and a refusal
 * on Postgres raises that same text, so a caller (and a test) sees one refusal on
 * either engine. Every lookup a guard makes is held to the written row's workspace, as
 * the SQLite triggers match `workspace_id = NEW.workspace_id` (POD-7024).
 *
 * SQLite keeps its triggers; nothing here changes a SQLite statement.
 */

import { type Column, getTableColumns, type SQL, sql, type Table } from 'drizzle-orm'
import { param } from './executor/sync-drizzle'

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
}

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
    },
  ],
])

/** One write in rendered SQL, as the census reads it. */
export interface GuardedWrite {
  readonly op: 'i' | 'u' | 'd'
  readonly table: string
  /** For an update: the columns its SET assigns. */
  readonly setColumns?: readonly string[]
}

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
      if (rule.fence !== undefined && !rule.fence.holds(statement)) {
        out.push(`update ${write.table} without its fence: ${rule.fence.text}`)
      }
    } else if (write.op === 'd') {
      if (appendOnly?.delete !== undefined) {
        out.push(`delete from ${write.table}: ${appendOnly.delete}`)
        continue
      }
      const fence = DELETE_RULES.get(write.table)
      if (fence !== undefined && !fence.holds(statement)) {
        out.push(`delete from ${write.table} without its fence: ${fence.text}`)
      }
    }
  }
  return out
}

/** Every table a rule of this module guards. */
export const GUARDED_TABLES: ReadonlySet<string> = new Set([
  ...APPEND_ONLY.keys(),
  ...UPDATE_RULES.keys(),
  ...DELETE_RULES.keys(),
])

// ---------------------------------------------------------------------------
// The write forms
// ---------------------------------------------------------------------------

/**
 * The row of `INSERT INTO table (…) SELECT <row> FROM … WHERE <guard>`: each named
 * column's placeholder, bound to the column's encoder and cast to its Postgres type. A
 * parameter in a select list has no type of its own (Postgres reads it as text, which
 * does not assign to an integer or a timestamp), so the cast gives it the column's.
 * `names` maps a column's key to its placeholder name; by default the key itself.
 */
export function insertedRow(
  table: Table,
  keys: readonly string[],
  names: Readonly<Record<string, string>> = {},
): Record<string, SQL.Aliased> {
  const columns = getTableColumns(table) as Record<string, Column>
  return Object.fromEntries(
    keys.map((key) => {
      const target = columns[key]
      if (target === undefined) throw new Error(`insertedRow: no column ${key}`)
      return [
        key,
        sql`CAST(${param(target, names[key] ?? key)} AS ${sql.raw(castType(target))})`.as(
          target.name,
        ),
      ]
    }),
  )
}

/**
 * A column's Postgres type as a CAST names it: its SQL type without the collation the
 * twin gives a text column (`text COLLATE "C"`), which a type name in a CAST cannot carry
 * and an inserted value does not need.
 */
const castType = (column: Column): string => column.getSQLType().replace(/\s+COLLATE\s+.*$/i, '')

/**
 * Raise `text` when a guarded write changed nothing: the Postgres half of an insert
 * guard or a fenced update, whose WHERE refused the row the SQLite trigger refuses.
 */
export function refuseUnlessWritten(changes: number, text: string): void {
  if (changes === 0) throw new GuardRefusal(text)
}

/** A write-path guard's refusal, carrying the SQLite trigger's text as its message. */
export class GuardRefusal extends Error {
  override readonly name = 'GuardRefusal'
}
