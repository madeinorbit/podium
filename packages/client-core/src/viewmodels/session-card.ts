import type { IssueWire, SessionId, SessionMeta } from '@podium/model'
import { type AttentionGroup, attentionGroup, attentionSummary, relativeTime } from '../focus'
import { type DotTone, panelLabel, sessionDotTone } from './session-status'

export interface SessionCardModel {
  sessionId: SessionId
  title: string
  subtitle: string
  issueLabel: string | null
  summary: string | null
  group: AttentionGroup
  /** Canonical status-dot semantics, shared with the web (sessionDotTone). */
  dotTone: DotTone
  queuedCount?: number
}

export function sessionTitle(session: SessionMeta): string {
  const named = session.name?.trim() || session.title?.trim()
  if (named) return named
  const cwdName = session.cwd.split('/').filter(Boolean).pop()
  return cwdName || session.agentKind
}

export function sessionCardModel(
  session: SessionMeta,
  issue: IssueWire | undefined,
  now: number,
): SessionCardModel {
  return {
    sessionId: session.sessionId,
    title: sessionTitle(session),
    subtitle: `${panelLabel(session.agentKind)} · ${session.status} · ${relativeTime(session.lastActiveAt, now)}`,
    issueLabel: issue ? `#${issue.seq} ${issue.title}` : null,
    summary: attentionSummary(session),
    group: attentionGroup(session),
    dotTone: sessionDotTone(session),
    queuedCount: session.queuedMessageCount,
  }
}
