import {
  isTerminalOperationState,
  type Operation,
  parseOperation,
  TERMINAL_OPERATION_STATES,
} from '@podium/protocol'
import { and, desc, eq, notExists, notInArray, sql } from 'drizzle-orm'
import { operations } from '../../migrations/schema'
import type {
  StoreQueries,
  StoreDrizzle,
  TransactionRunner,
} from '../../store/executor/sync-drizzle'

/**
 * Persistence for durable operations (POD-2097) — the `operations` table and
 * nothing else. The state MACHINE lives in `engine.ts`; this file only knows
 * how a row becomes an object and back.
 *
 * WHY THE COLUMNS EXIST WHEN THE PAYLOAD ALREADY HAS THE FACTS
 * -----------------------------------------------------------
 * `state`, `exclusion_group` and the three timestamps are duplicated out of the
 * JSON deliberately. They are the facts the engine has to ask SQLite — is this
 * group busy, what belongs in history, what may be swept — and, more
 * importantly, they are the facts that must remain legible when the payload is
 * NOT. A successor server can write an operation this binary cannot parse (a
 * state it has never heard of); single-flight still has to hold across that
 * downgrade, so it is decided from the column, never from the parse.
 */

/**
 * What the engine hands the store: an operation that has already been stamped.
 * Requiring these at the type level is what keeps "persisted but unageable"
 * unrepresentable — a row with no heartbeat could never go stale, which would
 * quietly disable the liveness half of the contract (P4).
 */
export type PersistedOperation = Operation & {
  exclusionGroup: string
  createdAt: number
  updatedAt: number
}

export interface OperationRow {
  id: string
  kind: string
  exclusionGroup: string
  /** The column, which is authoritative for scheduling. */
  state: string
  createdAt: number
  updatedAt: number
  finishedAt: number | null
  /** The stored bytes, verbatim — what `operations.active` serves. */
  payload: string
  /**
   * The parsed object, or `null` when these bytes are not an operation THIS
   * binary can read. Callers that schedule must use the columns; callers that
   * render must tolerate the null, because during an update the reader is
   * routinely older than the writer.
   */
  operation: Operation | null
}

/**
 * What {@link OperationStore.claimGroup} answers: the group is yours, or here is
 * the operation that already holds it. There is no third arm — see that method
 * for why a refusal always carries its holder.
 */
export type GroupClaim = { claimed: true } | { claimed: false; heldBy: OperationRow }

/**
 * The stored row as this module's shape.
 *
 * WHAT WENT WITH THE CONVERSION [spec §6 rule 6]: the per-field casts and the
 * `Number(...)` coercions. Every one of them existed because the raw handle
 * returned `Record<string, unknown>` — the columns are TEXT and INTEGER and
 * always were, and drizzle's execution path applies the schema's declared types,
 * so the casts were re-stating what the schema already says.
 *
 * WHAT STAYED, because it is a decision and not a cast: the `finished_at`
 * normalisation and {@link parseStored}. The column is nullable and the domain
 * type is `number | null`; the parse is the downgrade tolerance this whole file
 * is built around.
 */
type StoredRow = typeof operations.$inferSelect

function toRow(r: StoredRow): OperationRow {
  return {
    id: r.id,
    kind: r.kind,
    exclusionGroup: r.exclusionGroup,
    state: r.state,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
    finishedAt: r.finishedAt ?? null,
    payload: r.payload,
    operation: parseStored(r.payload),
  }
}

function parseStored(payload: string): Operation | null {
  try {
    return parseOperation(JSON.parse(payload))
  } catch {
    // Not even JSON. The row stays visible through its columns; see above.
    return null
  }
}

/**
 * How many past operations a history read returns by default.
 *
 * QUALIFIED ON PURPOSE (POD-2219). `packages/model` already exports
 * `DEFAULT_HISTORY_LIMIT` — the draft document's revision cap — and the model
 * owns its feature names exclusively, so a second unrelated constant under that
 * name is a `feature-single-home` violation and two numbers free to drift while
 * reading as one. This history is a different thing entirely; the name says so.
 */
export const DEFAULT_OPERATION_HISTORY_LIMIT = 20
/** §9.6: twenty operations, server-side. */
export const DEFAULT_RETENTION = 20

export class OperationStore {
  private readonly rootDb: StoreDrizzle
  protected readonly createOrJoinTransaction: TransactionRunner

  constructor(queries: StoreQueries) {
    this.rootDb = queries.rootDb
    this.createOrJoinTransaction = queries.createOrJoinTransaction
  }

  /**
   * The query builder every method below reads through [spec rules 34, 34a].
   *
   * A GETTER, not a field assigned in the constructor: rule 35 makes transaction
   * routing ambient, so this has to resolve the ENCLOSING transaction on every
   * access, and a field frozen at construction never could. B1 changes this one
   * line; no call site moves.
   */
  private get db() {
    return this.rootDb
  }

  /** Unconditional seeding/restoration write. New starts must use {@link claimGroup}. */
  async insert(operation: PersistedOperation): Promise<void> {
    await this.db.insert(operations).values(rowFor(operation)).run()
  }

  /**
   * Claim the exclusion group with the insert itself (P6, POD-3524).
   *
   * The NOT EXISTS predicate is load-bearing: an awaited activeByGroup() followed
   * by insert() lets two starts pass the check before either writes (spec rule 54).
   * The conditional write lets the database refuse the loser atomically.
   *
   * The transaction keeps a refused claim and its holder lookup in one write
   * lease, so the holder cannot finish between them. It contains only database
   * work; planning, announcements and runners must stay outside this span.
   * Terminality comes from the protocol at runtime, avoiding a schema-level
   * state list that would need a migration when the protocol gains an outcome.
   */
  async claimGroup(operation: PersistedOperation): Promise<GroupClaim> {
    const values = rowFor(operation)
    // Share activeByGroup's terminal definition. Unknown states remain live,
    // including rows whose newer payload this binary cannot parse.
    const terminal = [...TERMINAL_OPERATION_STATES]
    return await this.createOrJoinTransaction(async () => {
      const claimed = await this.db
        .insert(operations)
        .select(
          this.db
            // The eight values as bound parameters, in the column order
            // {@link rowFor} states. `(SELECT 1)` is the one-row source SQLite
            // needs to hang a `WHERE` on a constant row — the predicate below is
            // the whole point of the statement.
            .select({
              id: sql`${values.id}`.as('id'),
              kind: sql`${values.kind}`.as('kind'),
              exclusionGroup: sql`${values.exclusionGroup}`.as('exclusion_group'),
              state: sql`${values.state}`.as('state'),
              createdAt: sql`${values.createdAt}`.as('created_at'),
              updatedAt: sql`${values.updatedAt}`.as('updated_at'),
              finishedAt: sql`${values.finishedAt ?? null}`.as('finished_at'),
              payload: sql`${values.payload}`.as('payload'),
            })
            .from(sql`(SELECT 1)`)
            .where(
              notExists(
                this.db
                  .select({ live: sql`1` })
                  .from(operations)
                  .where(
                    and(
                      eq(operations.exclusionGroup, operation.exclusionGroup),
                      notInArray(operations.state, terminal),
                    ),
                  ),
              ),
            ),
        )
        .returning({ id: operations.id })
      if (claimed.length === 1) return { claimed: true }
      const held = await this.activeByGroup(operation.exclusionGroup)
      if (held) return { claimed: false, heldBy: held }
      // The predicate found a live row in this same transaction. Losing it
      // means the claim/lookup invariant was broken; never return a missing id.
      throw new Error(
        `operations: the group ${operation.exclusionGroup} refused a claim but holds no live operation`,
      )
    })
  }

  /**
   * Writes the operation back WHOLE. There is no field-wise update and there
   * cannot be one: a partial write would have to enumerate the fields, and the
   * frozen contract's whole point is that no writer knows them all — a
   * successor's field would be dropped on the first progress event.
   */
  async update(operation: PersistedOperation): Promise<void> {
    // `id` is the key and is deliberately not in the SET list, exactly as the
    // statement this replaces had it: seven columns set, matched on the eighth.
    const { id, ...rest } = rowFor(operation)
    await this.db.update(operations).set(rest).where(eq(operations.id, id)).run()
  }

  /**
   * Stamp an outcome onto the COLUMNS and leave the payload exactly as found.
   *
   * The one case that needs it: a row this binary cannot parse, which is what a
   * successor server's operation looks like after a downgrade. Something has to
   * release the exclusion group, and rewriting bytes we could not read would
   * destroy the newer server's record of what actually happened. So the column
   * says the operation stopped and the payload keeps the writer's last word;
   * the columns are authoritative for scheduling, which is the same rule that
   * governs every other read here.
   */
  async markTerminal(id: string, state: string, at: number): Promise<void> {
    // THREE COLUMNS, and `payload` is not one of them — see above. A `set` names
    // exactly the columns it lists, so the bytes are left untouched rather than
    // rewritten with a value this binary may not have been able to read.
    await this.db
      .update(operations)
      .set({ state, updatedAt: at, finishedAt: at })
      .where(eq(operations.id, id))
      .run()
  }

  async get(id: string): Promise<OperationRow | undefined> {
    const r = await this.db.select().from(operations).where(eq(operations.id, id)).get()
    return r ? toRow(r) : undefined
  }

  /**
   * The single-flight query (P6): the one non-terminal operation in a group.
   *
   * Terminality is evaluated in TypeScript rather than as a SQL `NOT IN (…)`
   * list so that the set of terminal states has exactly one definition, in the
   * protocol package, shared with everything that renders one. The candidate
   * set is at most a handful of rows — history is swept to twenty.
   */
  async activeByGroup(group: string): Promise<OperationRow | undefined> {
    const rows = await this.db
      .select()
      .from(operations)
      .where(eq(operations.exclusionGroup, group))
      .orderBy(desc(operations.createdAt))
      .all()
    return rows.map(toRow).find((row) => !isTerminalOperationState(row.state))
  }

  /**
   * Every live operation, newest first — what boot adoption sweeps (§3.4).
   *
   * Deliberately NOT "one per registered group": a kind this binary no longer
   * registers still has a row, and that row still holds its group. Finding it
   * is what lets adoption resolve it instead of leaving the group wedged by an
   * operation nothing will ever drive.
   */
  async active(): Promise<OperationRow[]> {
    const rows = await this.db.select().from(operations).orderBy(desc(operations.createdAt)).all()
    return rows.map(toRow).filter((row) => !isTerminalOperationState(row.state))
  }

  /** Newest first — what Settings → Updates lists (§3.7). */
  async history(kind?: string, limit: number = DEFAULT_OPERATION_HISTORY_LIMIT): Promise<OperationRow[]> {
    // The two arms stay two statements rather than one with a conditional
    // predicate: an absent `kind` means EVERY kind here, not a kind that is
    // null, and folding them would make that distinction a runtime accident.
    const rows =
      kind === undefined
        ? await this.db.select().from(operations).orderBy(desc(operations.createdAt)).limit(limit).all()
        : await this.db
            .select()
            .from(operations)
            .where(eq(operations.kind, kind))
            .orderBy(desc(operations.createdAt))
            .limit(limit)
            .all()
    return rows.map(toRow)
  }

  /**
   * Drops all but the newest `keep` FINISHED operations of a kind, and returns
   * how many went. Live operations are never counted and never swept: a
   * retention rule that could delete the row a running engine is driving would
   * turn a full history into a lost update.
   */
  async sweepRetention(kind: string, keep: number = DEFAULT_RETENTION): Promise<number> {
    // TWO COLUMNS, named rather than spread [spec rule 39]: the statement this
    // replaces read `id, state` out of the eight, and a sweep that dragged the
    // payload of every finished operation back with it would read seven columns
    // nobody asked for, on every row, on every sweep.
    const finished = (await this.db
      .select({ id: operations.id, state: operations.state })
      .from(operations)
      .where(eq(operations.kind, kind))
      .orderBy(desc(operations.createdAt))
      .all())
      .filter((r) => isTerminalOperationState(r.state))
    const doomed = finished.slice(keep)
    for (const row of doomed) {
      await this.db.delete(operations).where(eq(operations.id, row.id)).run()
    }
    return doomed.length
  }
}

/**
 * The eight columns of a row, from the operation the engine stamped.
 *
 * NAMED RATHER THAN POSITIONAL. The tuple this replaces was shared by the
 * insert and the update, which took it and dropped its first element — so the
 * update's column list and the insert's were the same list minus one, expressed
 * as an offset. Named fields say that directly, and the update destructures the
 * key it matches on rather than counting past it.
 *
 * EVERY COLUMN IS SUPPLIED, which is why rule 43 cannot bite here: the original
 * INSERT named all eight, so there is no column the conversion newly binds. And
 * `operations` declares no DEFAULT on any of its eight (verified with
 * `pragma table_info` against the migrated table), so there is no default for an
 * explicit null to override even in principle.
 */
function rowFor(operation: PersistedOperation): typeof operations.$inferInsert {
  return {
    id: operation.id,
    kind: operation.kind,
    exclusionGroup: operation.exclusionGroup,
    state: operation.state,
    createdAt: operation.createdAt,
    updatedAt: operation.updatedAt,
    finishedAt: operation.finishedAt ?? null,
    payload: JSON.stringify(operation),
  }
}
