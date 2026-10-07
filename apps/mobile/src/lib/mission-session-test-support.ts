import type { SessionView } from '@podium/client-core/session-values'
import { MobxPool } from '@podium/client-graph/pool'
import { mostRelevantSession as select } from './mission-session'

/** Existing row fixtures enter the same model boundary as the phone projection. */
export function mostRelevantSession(sessions: readonly SessionView[]): SessionView | undefined {
  const pool = new MobxPool({ selectedIssueId: null, coarseNow: 0 })
  try {
    pool.apply({ type: 'replace', rows: sessions.map(value => ({
      kind: 'session' as const, id: value.sessionId, value: value as never,
    })) })
    const selected = select(sessions.map(session => pool.sessionObject(session.sessionId)))
    return sessions.find(session => session.sessionId === selected?.sessionId)
  } finally { pool.dispose() }
}
