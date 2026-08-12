/**
 * The public, non-secret lifecycle projection every human client reads before it
 * opens an operator transport.  The server is the only authority that derives
 * this value; clients render it and never infer readiness from a configured mode.
 */
export type ServerReadinessState = 'unconfigured' | 'activation_pending' | 'ready' | 'degraded'

export type ServerReadinessReason =
  | 'setup_required'
  | 'restart_required'
  | 'agent_unavailable'
  | 'configuration_invalid'
  | null

export interface ServerReadiness {
  readonly state: ServerReadinessState
  readonly reason: ServerReadinessReason
  readonly dataPlane: 'blocked' | 'available'
}

/** Runtime guard for the public response. It validates the combinations too:
 * a contradictory `ready + blocked` response must fail closed in a client. */
export function isServerReadiness(value: unknown): value is ServerReadiness {
  if (!value || typeof value !== 'object') return false
  const candidate = value as Partial<ServerReadiness>
  switch (candidate.state) {
    case 'unconfigured':
      return candidate.reason === 'setup_required' && candidate.dataPlane === 'blocked'
    case 'activation_pending':
      return candidate.reason === 'restart_required' && candidate.dataPlane === 'blocked'
    case 'ready':
      return candidate.reason === null && candidate.dataPlane === 'available'
    case 'degraded':
      return (
        (candidate.reason === 'agent_unavailable' ||
          candidate.reason === 'configuration_invalid') &&
        candidate.dataPlane === 'available'
      )
    default:
      return false
  }
}
