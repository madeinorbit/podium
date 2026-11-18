/**
 * The phone's old all-sessions roster and mention-issue hooks, kept for the
 * tests that use them as probes of pool attachment. No screen reads them:
 * POD-7088 removed them from the app, because the device does not hold every
 * session or issue.
 */
import type { IssueViewModel } from '@podium/client-core/replica'
import type { SessionView } from '@podium/client-core/session-values'
import { chatMentionIssues } from '@podium/client-graph/chat-context'
import { omitGone } from '@podium/client-graph/lookup'
import type { MobxPool } from '@podium/client-graph/pool'
import { dedupeSessionsByResume } from '@podium/model'
import { useMobilePoolProjection } from '../src/client/mobile-pool'

const EMPTY_SESSIONS: SessionView[] = []
const EMPTY_ISSUES: IssueViewModel[] = []

function ready(pool: MobxPool): boolean {
  const reader = omitGone(pool.row('mobileSessionReader', 'reader'))
  return Boolean(reader) && typeof reader !== 'symbol'
}

function sessionsOf(pool: MobxPool): SessionView[] {
  if (!ready(pool)) return EMPTY_SESSIONS
  const order = omitGone(pool.row('chatSessionOrder', 'order'))
  if (!order || typeof order === 'symbol') return EMPTY_SESSIONS
  const known = pool.queries.ids({ kind: 'referenceSessions' })
  const present = new Set(known)
  const sessions: SessionView[] = []
  for (const id of new Set([...order.ids.filter((id) => present.has(id)), ...known])) {
    const row = omitGone(pool.row('session', id)) as SessionView | symbol | undefined
    if (row && typeof row !== 'symbol') sessions.push(row)
  }
  return dedupeSessionsByResume(sessions)
}

function issuesOf(pool: MobxPool): IssueViewModel[] {
  return ready(pool) ? chatMentionIssues(pool).issues : EMPTY_ISSUES
}

export function useSessions(): SessionView[] {
  return useMobilePoolProjection(sessionsOf, EMPTY_SESSIONS)
}
export function useIssues(): IssueViewModel[] {
  return useMobilePoolProjection(issuesOf, EMPTY_ISSUES)
}
export { useSessions as useSessionContextSessions }
