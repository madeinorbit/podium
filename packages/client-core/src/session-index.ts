import type { SessionView } from './session-values'
import { recordSliceDerivation } from './perf/store-stats'

const indexes = new WeakMap<readonly SessionView[], ReadonlyMap<string, SessionView>>()

/** One lazy index per immutable collection, including effective optimistic arrays.
 * Weak keys do not extend collection/row visibility. Values are the original rows.
 * First occurrence wins, matching Array.find even for duplicate IDs.
 */
export function sessionById(sessions: readonly SessionView[]): ReadonlyMap<string, SessionView> {
  const cached = indexes.get(sessions)
  if (cached) return cached
  const index = new Map<string, SessionView>()
  for (const session of sessions) {
    if (!index.has(session.sessionId)) index.set(session.sessionId, session)
  }
  indexes.set(sessions, index)
  recordSliceDerivation(sessions, 'sessionById')
  return index
}
