import { isTerminalOperationState, type Operation, parseOperation } from '@podium/protocol'
import type { SqlDatabase } from '@podium/runtime/sqlite'

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

function toRow(r: Record<string, unknown>): OperationRow {
  const payload = r.payload as string
  return {
    id: r.id as string,
    kind: r.kind as string,
    exclusionGroup: r.exclusion_group as string,
    state: r.state as string,
    createdAt: Number(r.created_at),
    updatedAt: Number(r.updated_at),
    finishedAt:
      r.finished_at === null || r.finished_at === undefined ? null : Number(r.finished_at),
    payload,
    operation: parseStored(payload),
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

export const DEFAULT_HISTORY_LIMIT = 20
/** §9.6: twenty operations, server-side. */
export const DEFAULT_RETENTION = 20

export class OperationStore {
  constructor(private readonly db: SqlDatabase) {}

  insert(operation: PersistedOperation): void {
    this.db
      .prepare(
        `INSERT INTO operations
           (id, kind, exclusion_group, state, created_at, updated_at, finished_at, payload)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(...values(operation))
  }

  /**
   * Writes the operation back WHOLE. There is no field-wise update and there
   * cannot be one: a partial write would have to enumerate the fields, and the
   * frozen contract's whole point is that no writer knows them all — a
   * successor's field would be dropped on the first progress event.
   */
  update(operation: PersistedOperation): void {
    this.db
      .prepare(
        `UPDATE operations
            SET kind = ?, exclusion_group = ?, state = ?, created_at = ?, updated_at = ?,
                finished_at = ?, payload = ?
          WHERE id = ?`,
      )
      .run(...values(operation).slice(1), operation.id)
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
  markTerminal(id: string, state: string, at: number): void {
    this.db
      .prepare('UPDATE operations SET state = ?, updated_at = ?, finished_at = ? WHERE id = ?')
      .run(state, at, at, id)
  }

  get(id: string): OperationRow | undefined {
    const r = this.db.prepare('SELECT * FROM operations WHERE id = ?').get(id) as
      | Record<string, unknown>
      | undefined
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
  activeByGroup(group: string): OperationRow | undefined {
    const rows = this.db
      .prepare('SELECT * FROM operations WHERE exclusion_group = ? ORDER BY created_at DESC')
      .all(group) as Record<string, unknown>[]
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
  active(): OperationRow[] {
    const rows = this.db
      .prepare('SELECT * FROM operations ORDER BY created_at DESC')
      .all() as Record<string, unknown>[]
    return rows.map(toRow).filter((row) => !isTerminalOperationState(row.state))
  }

  /** Newest first — what Settings → Updates lists (§3.7). */
  history(kind?: string, limit: number = DEFAULT_HISTORY_LIMIT): OperationRow[] {
    const rows = (
      kind === undefined
        ? this.db.prepare('SELECT * FROM operations ORDER BY created_at DESC LIMIT ?').all(limit)
        : this.db
            .prepare('SELECT * FROM operations WHERE kind = ? ORDER BY created_at DESC LIMIT ?')
            .all(kind, limit)
    ) as Record<string, unknown>[]
    return rows.map(toRow)
  }

  /**
   * Drops all but the newest `keep` FINISHED operations of a kind, and returns
   * how many went. Live operations are never counted and never swept: a
   * retention rule that could delete the row a running engine is driving would
   * turn a full history into a lost update.
   */
  sweepRetention(kind: string, keep: number = DEFAULT_RETENTION): number {
    const finished = (
      this.db
        .prepare('SELECT id, state FROM operations WHERE kind = ? ORDER BY created_at DESC')
        .all(kind) as Record<string, unknown>[]
    ).filter((r) => isTerminalOperationState(r.state as string))
    const doomed = finished.slice(keep)
    for (const row of doomed) {
      this.db.prepare('DELETE FROM operations WHERE id = ?').run(row.id as string)
    }
    return doomed.length
  }
}

function values(
  operation: PersistedOperation,
): [string, string, string, string, number, number, number | null, string] {
  return [
    operation.id,
    operation.kind,
    operation.exclusionGroup,
    operation.state,
    operation.createdAt,
    operation.updatedAt,
    operation.finishedAt ?? null,
    JSON.stringify(operation),
  ]
}
