import type { SessionId } from '@podium/model'
import { machinePathBasename } from '@podium/model'
import { type AttentionGroup, attentionGroup, attentionSummary, relativeTime } from '../focus'
import type { SessionView } from '../session-values'
import type { IssueViewModel } from '../values/issue-type'
import { type DotTone, isUnstartedSession, panelLabel, sessionDotTone } from './session-status'

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

export function sessionTitle(session: SessionView): string {
  const named = session.name?.trim() || session.title?.trim()
  if (named) return named
  const cwdName = machinePathBasename(session.cwd)
  return cwdName || session.agentKind
}

export function sessionCardModel(
  session: SessionView,
  issue: Pick<IssueViewModel, 'seq' | 'title'> | undefined,
  now?: number,
): SessionCardModel {
  return {
    sessionId: session.sessionId,
    title: sessionTitle(session),
    subtitle: `${panelLabel(session.agentKind)} · ${session.status}${now === undefined ? '' : ` · ${relativeTime(session.lastActiveAt, now)}`}`,
    issueLabel: issue ? `#${issue.seq} ${issue.title}` : null,
    summary: attentionSummary(session),
    group: attentionGroup(session),
    dotTone: sessionDotTone(session),
    queuedCount: session.queuedMessageCount,
  }
}

/**
 * Strip a leading status/spinner glyph from a live terminal title. Claude Code
 * (and others) prefix the title with an animated marker — ✻ ✽ ✶ ● · … — that
 * churns every frame and just adds visual noise in the tab bar and sidebar. Only
 * leading "symbol" glyphs (and the bullet/middle-dot) are removed, so real titles
 * like `~/src/podium` or `[branch]` keep their leading punctuation.
 */
export function normalizeTitle(title: string): string {
  return title.replace(/^[\p{So}\p{Sk}·•\s]+/u, '').trim()
}

/** The display name for a session anywhere in the UI: user-set name beats the
 *  live title; a still-unstarted session reads "New session" (its kind already
 *  rides on the adjacent icon) rather than echoing the harness's boot title. */
export function sessionDisplayName(session: SessionView): string {
  if (isUnstartedSession(session)) return 'New session'
  return session.name?.trim() || normalizeTitle(session.title) || 'untitled'
}
