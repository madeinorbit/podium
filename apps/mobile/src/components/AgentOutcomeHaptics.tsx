import type { SessionMeta } from '@podium/model'

/** A stable identity for one errored-state arrival, or null outside that phase. */
export function agentErrorKey(session: SessionMeta): string | null {
  if (session.agentState?.phase !== 'errored') return null
  return `${session.agentState.since}:${session.agentState.error?.class ?? 'unknown'}`
}

/**
 * Background agent state must not vibrate the phone without a user action.
 * Visible attention state and future notification policy own that feedback.
 */
export function AgentOutcomeHaptics() {
  return null
}
