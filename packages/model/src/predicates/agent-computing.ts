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
  agentState?: { phase: string } | undefined
}

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
