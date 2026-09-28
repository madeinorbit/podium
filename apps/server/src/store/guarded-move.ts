/**
 * THE GUARDED STATUS WRITE for a declared state machine (POD-4765, POD-4720
 * §5.4 block 2).
 *
 * One `UPDATE … WHERE <row> AND status IN (allowedFrom(to))`: the database, not
 * a read-then-write in application code, decides whether the move is allowed, so
 * two writers racing on one row cannot both win and a move the table does not
 * list cannot happen. When nothing moved, one read says why: the row is already
 * in `to` (a repeated report — a no-op, not an error), or it is somewhere the
 * table does not allow a move from (refused, with where it actually is).
 *
 * The helper owns the status guard; the caller owns the row key, any extra
 * condition, the other columns the move sets, and the statement itself (so it
 * can run inside the repository's commit funnel). The ship-order store's fence
 * (`transitionOrder`) is the recipe this generalises.
 */

import type { MoveOutcome, StateMachine } from '@podium/model'
import { type AnyColumn, inArray, type SQL, sql } from 'drizzle-orm'

export interface GuardedMove<S extends string> {
  readonly machine: StateMachine<S>
  /** The status column the guard reads. */
  readonly column: AnyColumn
  readonly to: S
  /**
   * Run the UPDATE. AND `guard` with the row key and any extra condition, set
   * the status column to `to`, and return how many rows moved. More than one is
   * a caller bug: the key must name one row.
   */
  write(guard: SQL): Promise<number>
  /** The row's status now, or null when there is no such row. Only read when
   *  the write moved nothing. */
  read(): Promise<S | null>
}

export async function moveStatus<S extends string>(move: GuardedMove<S>): Promise<MoveOutcome<S>> {
  const from = move.machine.allowedFrom(move.to)
  // `IN ()` is not SQL. A state nothing moves into (the initial one) refuses
  // every move by construction.
  const guard = from.length > 0 ? inArray(move.column, [...from]) : sql`0`
  const moved = await move.write(guard)
  if (moved > 1) {
    throw new Error(`${move.machine.name}: one move changed ${moved} rows`)
  }
  if (moved === 1) return { kind: 'applied' }
  const current = await move.read()
  if (current === move.to) return { kind: 'already-there' }
  return { kind: 'refused', current }
}
