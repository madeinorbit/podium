import { compareStructural } from 'mobx'
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

/** A seated (non-archived) session: one constant, so a heartbeat on it
 * re-reads its row and stops there. Its readers read the row directly. */
const SEATED = Object.freeze({ seat: 'seated' as const })
/** A cold session whose declared summary does not carry the archived flag. */
const UNSETTLED = Object.freeze({ seat: 'unknown' as const })

/** An archived session, with everything history aggregates read of it. A
 * read marker or any other display change leaves these facts, and so every
 * aggregate above them, untouched. */
export interface RetiredSeat {
  readonly seat: 'retired'
  /** The row in hand is the whole (resident) row: every fact below is exact.
   * Otherwise only the declared summary answered; a reader needing the
   * remaining facts reads the row itself. */
  readonly complete: boolean
  /** Whether `lastActiveAt` was answered by the row in hand. */
  readonly stamped: boolean
  readonly sessionId: string
  readonly lastActiveAt: string
  readonly lastInputAt?: string | null
  readonly transcriptAvailable?: boolean
  readonly agentKind: string
  readonly moved: boolean
  readonly phase: string
  readonly archived: true
  /** Drawn in a roster: neither headless nor a shell. */
  readonly roster: boolean
}
export type Seat = typeof SEATED | typeof UNSETTLED | RetiredSeat

export interface SessionSeats {
  /** LOADING while a member's summary is still being loaded. Never loads a row. */
  partition(relation: SeatRelation, issueId: string): SeatPartition | typeof LOADING
  /** One session's seat; undefined when the session is unknown. Never loads a row. */
  seat(sessionId: string): Loaded<Seat>
}

type SeatRow = {
  archived?: boolean
  lastActiveAt?: string
  lastInputAt?: string | null
  transcriptAvailable?: boolean
  agentKind?: string
  headless?: boolean
  handoffTarget?: unknown
  agentState?: { phase?: string }
}

/**
 * Seat partitions over the one row reader (review findings 2–4). Each session
 * has ONE cached seat, shared by the partitions, navigation's activity and
 * the mission history: a heartbeat or a read marker re-reads that one row and
 * stops there, and archived history is walked again only when membership or
 * an archived session's facts change. A cold mission switch builds one cached
 * value per session. Nothing here loads a row; everything lives only while a
 * mounted reader observes it, and no index or keep-alive is added to the pool.
 */
function createSessionSeats(pool: MobxPool): SessionSeats {
  const seat = cachedKey('SessionSeat', 'seat', (sessionId): Loaded<Seat> => {
    // A resident row already has the exact flag and history fields. Asking
    // for a cold summary as well repeats one read for every mission seat.
    const residentRow = pool.row('session', sessionId, 'mark') as Loaded<SeatRow>
    const row = residentRow === LOADING
      ? pool.row('session', sessionId, 'summary') as Loaded<SeatRow>
      : residentRow
    if (row === LOADING || row === undefined) return row
    // A resident row is the whole row: an absent optional field is unset.
    const resident = residentRow !== LOADING
    const archived = Object.hasOwn(row, 'archived')
      ? Boolean(row.archived)
      : resident
        ? false
        : null
    if (archived === false) return SEATED
    if (archived === null) return UNSETTLED
    return {
      seat: 'retired',
      complete: resident,
      stamped: resident || Object.hasOwn(row, 'lastActiveAt'),
      sessionId,
      lastActiveAt: row.lastActiveAt ?? '',
      lastInputAt: row.lastInputAt,
      transcriptAvailable: row.transcriptAvailable,
      agentKind: row.agentKind ?? '',
      moved: Boolean(row.handoffTarget),
      phase: row.agentState?.phase ?? 'unknown',
      archived: true,
      roster: !row.headless && row.agentKind !== 'shell',
    }
  }, compareStructural)
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
            const value = seat(sessionId)
            if (value === LOADING) pending = true
            else if (value === SEATED) present.push(sessionId)
            else if (value === UNSETTLED) unknown.push(sessionId)
            else if (value) history.push(sessionId)
          }
          return pending ? LOADING : { present, archived: history, unknown }
        }, compareStructural,
      )
      partitions.set(relation, read)
    }
    return read
  }
  return {
    seat,
    partition: (relation, issueId) => partitionOf(relation)(issueId),
  }
}

/** One service on the existing pool, like `missions`. */
export function sessionSeats(pool: MobxPool): SessionSeats {
  return pool.sources.view('sessionSeats', () => createSessionSeats(pool))
}
