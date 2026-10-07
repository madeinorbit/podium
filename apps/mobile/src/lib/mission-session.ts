import type { SessionView } from '@podium/client-core/session-values'
import type { SessionModel } from '@podium/client-graph/models'

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
 * The screen ranks the shared open/asking answers, then excludes hibernated
 * agents from immediate conversation selection. That exclusion and the exact
 * working-phase rank are phone navigation rules, independent of execution.
 */
export function mostRelevantSession<S extends SessionModel | SessionView>(sessions: readonly S[]): S | undefined {
  const rank = (s: S): number => {
    // The phone projection carries the pool's models through its wire-shaped API.
    const model = s as SessionModel
    if (!model.open || model.status === 'hibernated') return 3
    if (model.asking) return 0
    if (model.phase === 'working') return 1
    return 2
  }
  return [...sessions].sort(
    (a, b) => rank(a) - rank(b) || b.lastActiveAt.localeCompare(a.lastActiveAt),
  )[0]
}
