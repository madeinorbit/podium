import { compareStructural } from 'mobx'
import { cachedKey } from './cached'
import type { MobxPool } from './pool'
import { LOADING, type Loaded } from './worklist/rollup'

/** The issue → session collections a seat partition may split. */
export type SeatRelation = 'missionSessions' | 'sessions' | 'pageSessions'
export interface SeatPartition {
  readonly present: readonly string[]
  readonly archived: readonly string[]
  readonly unknown: readonly string[]
}
const SEATED = Object.freeze({ seat: 'seated' as const })
const RETIRED = Object.freeze({ seat: 'retired' as const })
export type Seat = typeof SEATED | typeof RETIRED
export interface SessionSeats {
  partition(relation: SeatRelation, issueId: string): SeatPartition | typeof LOADING
  seat(sessionId: string): Loaded<Seat>
}

/** Relations split on the shared session fact. No private per-session cache or
 * history copy lives here; scalar history belongs to SessionModel. */
function createSessionSeats(pool: MobxPool): SessionSeats {
  const seat = (sessionId: string): Loaded<Seat> => {
    try {
      const archived = pool.sessionObject(sessionId).archived
      return archived === undefined ? undefined : archived ? RETIRED : SEATED
    } catch (error) { if (error === LOADING) return LOADING; throw error }
  }
  const partitionOf = (relation: SeatRelation) => cachedKey(
    `Seats.${relation}`, 'partition', (issueId): SeatPartition | typeof LOADING => {
      const present: string[] = [], archived: string[] = []
      let pending = false
      for (const sessionId of pool.graph.many('issue', issueId, relation)) {
        const value = seat(sessionId)
        if (value === LOADING) pending = true
        else if (value === SEATED) present.push(sessionId)
        else if (value === RETIRED) archived.push(sessionId)
      }
      return pending ? LOADING : { present, archived, unknown: [] }
    }, compareStructural,
  )
  // Three declared relations, rather than a dynamically growing registry.
  const partitions = { missionSessions: partitionOf('missionSessions'), sessions: partitionOf('sessions'), pageSessions: partitionOf('pageSessions') }
  return { seat, partition: (relation, issueId) => partitions[relation](issueId) }
}
export function sessionSeats(pool: MobxPool): SessionSeats {
  return pool.sources.view('sessionSeats', () => createSessionSeats(pool))
}
