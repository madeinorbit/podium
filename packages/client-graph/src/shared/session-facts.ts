import type { SessionView } from '@podium/client-core/session-values'
import { CONFIRMED_AGENT_ACTIVITY_MAX_AGE_MS, isAgentComputing } from '@podium/model/browser'

/** A session's execution evidence expires independently of any view or tick. */
export function computingDeadlineOf(row: SessionView | undefined): number | undefined {
  if (!row || row.status !== 'live' || !isAgentComputing(row)) return undefined
  const activity = Math.max(...[row.agentState?.stateObservedAt, row.lastActiveAt, row.agentState?.since]
    .map(stamp => Date.parse(stamp ?? '')).filter(Number.isFinite))
  return Number.isFinite(activity) ? activity + CONFIRMED_AGENT_ACTIVITY_MAX_AGE_MS : undefined
}
