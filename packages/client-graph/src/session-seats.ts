import { cachedKey } from './cached'
import type { MobxPool } from './pool'
import { LOADING, type Loaded } from './worklist/rollup'

/** The issue → session collections a seat partition may split. */
export type SeatRelation = 'missionSessions' | 'sessions' | 'pageSessions'

/**
 * An issue's sessions on one declared relation, split by the archived flag
 * as far as the rows in hand answer it. IDs only, in relation order; readers
 * apply their own presentation order.
 */
export interface SeatPartition {
  readonly present: readonly string[]
  readonly archived: readonly string[]
  /** Cold sessions whose declared summary does not carry the flag. A reader
   * that needs the flag settles these from the rows it reads anyway; one that
   * only aggregates (activity) may count them with either side. */
  readonly unknown: readonly string[]
}

export interface SessionSeats {
  /** LOADING while a member's summary is still being loaded. Never loads a row. */
  partition(relation: SeatRelation, issueId: string): SeatPartition | typeof LOADING
}

/**
 * Seat partitions over the one row reader (review findings 2–4). A session's
 * archived flag is its own cached value, so a heartbeat or a read marker
 * re-reads that one row and stops there: the partition depends on the flags,
 * never on row identity, and archived history is walked again only when
 * membership or a flag changes. Nothing here loads a row; everything lives
 * only while a mounted reader observes it, and no index or keep-alive is
 * added to the pool.
 */
export function createSessionSeats(pool: MobxPool): SessionSeats {
  /** true/false when the row in hand answers; null for a cold summary without the field. */
  const archived = cachedKey('SessionSeat', 'archived', (sessionId): Loaded<boolean | null> => {
    const row = pool.row('session', sessionId, 'summary') as Loaded<{ archived?: boolean }>
    if (row === LOADING || row === undefined) return row
    if (Object.hasOwn(row, 'archived')) return Boolean(row.archived)
    // A resident row is the whole row: an absent optional flag is false.
    return pool.row('session', sessionId, 'mark') === LOADING ? null : false
  })
  const partitions = new Map<SeatRelation, (issueId: string) => SeatPartition | typeof LOADING>()
  function partitionOf(relation: SeatRelation) {
    let read = partitions.get(relation)
    if (!read) {
      read = cachedKey(
        `Seats.${relation}`,
        'partition',
        (issueId): SeatPartition | typeof LOADING => {
          const present: string[] = [],
            history: string[] = [],
            unknown: string[] = []
          let pending = false
          for (const sessionId of pool.graph.many('issue', issueId, relation)) {
            const flag = archived(sessionId)
            if (flag === LOADING) pending = true
            else if (flag === true) history.push(sessionId)
            else if (flag === false) present.push(sessionId)
            else if (flag === null) unknown.push(sessionId)
          }
          return pending ? LOADING : { present, archived: history, unknown }
        },
      )
      partitions.set(relation, read)
    }
    return read
  }
  return {
    partition: (relation, issueId) => partitionOf(relation)(issueId),
  }
}

/** One service on the existing pool, like `missions`. */
export function sessionSeats(pool: MobxPool): SessionSeats {
  return pool.sources.view('sessionSeats', () => createSessionSeats(pool))
}
