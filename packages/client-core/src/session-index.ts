import { recordSliceDerivation } from './perf/store-stats'
import type { SessionView } from './session-values'

const indexes = new WeakMap<
  readonly Pick<SessionView, 'sessionId'>[],
  ReadonlyMap<string, Pick<SessionView, 'sessionId'>>
>()

/** One lazy index per immutable collection, including effective optimistic arrays.
 * Weak keys do not extend collection/row visibility. Values are the original rows.
 * First occurrence wins, matching Array.find even for duplicate IDs.
 */
export function sessionById<T extends Pick<SessionView, 'sessionId'>>(
  sessions: readonly T[],
): ReadonlyMap<string, T> {
  const cached = indexes.get(sessions)
  if (cached) return cached as ReadonlyMap<string, T>
  const index = new Map<string, T>()
  for (const session of sessions) {
    if (!index.has(session.sessionId)) index.set(session.sessionId, session)
  }
  indexes.set(sessions, index)
  recordSliceDerivation(sessions, 'sessionById')
  return index
}
