/**
 * "Is this agent computing RIGHT NOW?" — the fleet-wide counter's predicate.
 *
 * `agentState.phase` alone does not answer it. The phase is the last thing the
 * harness *observed*, and it deliberately outlives the process: `onExit` keeps
 * the final turn diagnosis so a dead session stays inspectable, and hibernation
 * keeps the phase so a parked "needs input" still reads amber. So a session that
 * exited mid-turn, or was parked while working, keeps `phase: 'working'`
 * forever. Counting raw phase gives a number that only ever ratchets up — every
 * agent that ever died mid-turn is still "working" hours later (POD-730).
 *
 * Liveness is therefore part of the question, not a caller's afterthought.
 * Structural shape on purpose (model is the L0 zero-dep root) so the server's
 * `Session` class and the client's `SessionMeta` can both be passed straight in.
 */

/** The minimal row shape the computing predicate reads. */
export interface AgentComputingFields {
  status: 'starting' | 'live' | 'reconnecting' | 'hibernated' | 'exited'
  archived?: boolean
  lastActiveAt?: string | undefined
  agentState?:
    | {
        phase: string
        since?: string | undefined
        stateObservedAt?: string | undefined
      }
    | undefined
}

/** A silent working phase stops being evidence after this long. */
export const CONFIRMED_AGENT_ACTIVITY_MAX_AGE_MS = 15 * 60 * 1_000

/**
 * True only for a session whose process is still around AND whose harness is
 * mid-computation. `compacting` counts: the harness is still burning tokens,
 * just about its own context — the same reading `sessionDotTone` takes.
 *
 * `reconnecting` counts as alive: the daemon link dropped, not the agent.
 */
export function isAgentComputing(row: AgentComputingFields): boolean {
  if (row.status === 'exited' || row.status === 'hibernated') return false
  if (row.archived) return false
  const phase = row.agentState?.phase
  return phase === 'working' || phase === 'compacting'
}

/**
 * True only when Podium can currently confirm the process and harness state.
 *
 * `isAgentComputing` deliberately treats `reconnecting` as alive for guards
 * that must not interrupt a turn during a short daemon outage. A fleet counter
 * has the opposite burden of proof: once the daemon link is gone, Podium no
 * longer knows that the preserved working phase still describes the process.
 * Counting that row until some later lifecycle event arrives turns an outage
 * into an ever-growing "agents working" headline.
 */
export function isAgentConfirmedComputing(
  row: AgentComputingFields,
  nowMs: number,
): boolean {
  if (row.status !== 'live') return false
  if (!isAgentComputing(row)) return false
  const activityAt = Math.max(
    ...[row.agentState?.stateObservedAt, row.lastActiveAt, row.agentState?.since]
      .map((stamp) => Date.parse(stamp ?? ''))
      .filter(Number.isFinite),
  )
  return Number.isFinite(activityAt) && nowMs - activityAt <= CONFIRMED_AGENT_ACTIVITY_MAX_AGE_MS
}
