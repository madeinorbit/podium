import { sessionNeedsHuman } from '@podium/client-core/viewmodels'
import type { SessionMeta } from '@podium/model'

/**
 * WHO THE MISSION OPENS ON [POD-724].
 *
 * Tapping a task on the phone now lands straight in one agent's conversation, so
 * this is a triage rule rather than a convenience: pick wrong and the operator
 * pays a pull-down and a second choice on every single visit.
 *
 * The order is the operator's own, and it is deliberately not "most recent". An
 * agent that stopped to ask you something is why you picked the phone up, and it
 * stays the answer even when a sibling has been printing tool output for the
 * last ten minutes. Asking, then working, then whoever spoke last.
 *
 * OPEN IS CHECKED FIRST, before what the session wants. `sessionNeedsHuman` is
 * true of an archived session still carrying a stale offer, and ranking on the
 * ask alone would open the mission on a transcript nobody can reply to while a
 * live agent waited one pull away.
 */
export function mostRelevantSession(sessions: readonly SessionMeta[]): SessionMeta | undefined {
  const rank = (s: SessionMeta): number => {
    const open = !s.archived && s.status !== 'exited' && s.status !== 'hibernated'
    if (!open) return 3
    if (sessionNeedsHuman(s)) return 0
    if (s.agentState?.phase === 'working') return 1
    return 2
  }
  return [...sessions].sort(
    (a, b) => rank(a) - rank(b) || b.lastActiveAt.localeCompare(a.lastActiveAt),
  )[0]
}
