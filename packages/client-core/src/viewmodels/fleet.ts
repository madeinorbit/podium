import type { AgentKind, SessionMeta } from '@podium/model'

/**
 * WHO IS ON THIS TASK — the one presence rule behind every fleet stack.
 *
 * The rule used to be spelled inline on three surfaces (the sidebar row, the
 * board card and the phone row) as `!archived && status !== 'exited' &&
 * status !== 'hibernated'`, and that third clause was wrong (POD-756).
 * Hibernation is not an agent-lifecycle fact: `HibernationPolicy` parks IDLE
 * sessions to reclaim memory — after `idleMinutes`, past `maxIdleSessions`, or
 * under host memory/load pressure — and a parked session is resumable with its
 * full context. Filtering on it made the stack render the reaper's queue rather
 * than the roster: measured across 734 issues, `codex` had 0 live sessions and
 * 147 parked ones, so every Codex agent in the fleet was invisible on its issue.
 *
 * So presence is about the TASK, not the process:
 *
 *   present = not archived, not exited     (parked agents included, ghosted)
 *   gone    = archived, or exited          (nobody is coming back to this one)
 *
 * which is the same line {@link openSession} already draws inside the mission
 * viewmodel — one issue, one answer to "who is here".
 *
 * The stack that renders this is kinds, not sessions: a nine-agent mission on
 * three harnesses shows three tiles and a `9`. The stack answers "who is here",
 * the number answers "how many". Everything is derived from the caller's
 * session set; nothing is stored on the issue.
 */

/** How many distinct harness tiles a fleet stack shows before the total alone
 *  carries the rest. The approved artifact stacks kinds, not agents — three is
 *  what its widest mission renders. */
export const FLEET_KIND_LIMIT = 3

/** On the task: still assigned to it, whatever its process is doing. */
export const sessionPresentOnTask = (session: SessionMeta): boolean =>
  !session.archived && session.status !== 'exited'

/** Parked: process stopped to free memory, conversation intact, resumable. The
 *  agent is still on the task — it is drawn ghosted, not dropped. */
export const sessionParked = (session: SessionMeta): boolean => session.status === 'hibernated'

export interface FleetTile {
  kind: AgentKind
  /** Every present session of this kind is parked, so the tile draws ghosted.
   *  One awake session of the kind is enough to make it solid — the tile is a
   *  harness, and that harness IS running. */
  parked: boolean
}

export interface FleetPresence {
  /** Sessions on the task, in caller order. Archived and exited are dropped. */
  present: SessionMeta[]
  /** How many of `present` are parked (0 when the whole fleet is awake). */
  parkedCount: number
  /** One tile per harness kind, first-seen order. Callers that stack kinds slice
   *  this to {@link FLEET_KIND_LIMIT}; the count to show is `present.length`. */
  tiles: FleetTile[]
  /** Native (in-process Task) children, counted over AWAKE sessions only: a
   *  parked session's process is gone, so the subagent count its last
   *  `agentState` reported is not running anything. */
  nativeCount: number
  /** Hover/aria text — the facts the stack itself compresses. Deliberately not
   *  "N live agents": a parked agent is on the task, and calling the total
   *  "live" is what taught the sidebar to hide it in the first place. Leads are
   *  not in it — a coordinator is the Flight Deck's fact. */
  label: string
}

export function deriveFleetPresence(sessions: readonly SessionMeta[]): FleetPresence {
  const present = sessions.filter(sessionPresentOnTask)
  const parkedCount = present.filter(sessionParked).length
  const tiles: FleetTile[] = []
  for (const session of present) {
    const tile = tiles.find((t) => t.kind === session.agentKind)
    if (!tile) tiles.push({ kind: session.agentKind, parked: sessionParked(session) })
    else if (!sessionParked(session)) tile.parked = false
  }
  const nativeCount = present.reduce(
    (sum, session) =>
      sum + (sessionParked(session) ? 0 : (session.agentState?.nativeSubagentCount ?? 0)),
    0,
  )
  const label = [
    `${present.length} agent${present.length === 1 ? '' : 's'}`,
    parkedCount > 0 ? `${parkedCount} parked` : null,
    nativeCount > 0 ? `${nativeCount} native children` : null,
  ]
    .filter((part) => part !== null)
    .join(' · ')
  return { present, parkedCount, tiles, nativeCount, label }
}
