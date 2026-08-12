/**
 * One unread rule for every surface that names an issue or a session.
 *
 * Issue unread is "activity after this issue's readAt" — never the OR of
 * children's own unread flags. A parent click stamps the parent's cursor and
 * must cover whatever is currently rolled into that row (own sessions, child
 * issues, child sessions). Children's own cursors stay independent so an
 * expanded Flight Deck strip can keep showing which session is still new.
 *
 * Session unread is the session's own cursor. Working sessions suppress
 * emphasis: lastActiveAt ticks every token, and the spinner already says
 * "something is happening".
 */
import type { SessionMeta } from '@podium/model'
import { isSessionWorking } from './session-status'

export function parseStamp(value: string | null | undefined): number | null {
  if (!value) return null
  const at = Date.parse(value)
  return Number.isFinite(at) ? at : null
}

/** Latest ISO stamp among an issue's own updatedAt and the given sessions. */
export function latestActivityAt(
  updatedAt: string,
  sessions: readonly { lastActiveAt?: string }[],
): string {
  let latest = updatedAt
  for (const session of sessions) {
    if (session.lastActiveAt && session.lastActiveAt > latest) latest = session.lastActiveAt
  }
  return latest
}

/** True when `activityAt` is strictly after `readAt`. A missing readAt is unread. */
export function activityAfterRead(readAt: string | null | undefined, activityAt: string): boolean {
  const read = parseStamp(readAt)
  if (read === null) return true
  const activity = parseStamp(activityAt)
  return activity !== null && activity > read
}

/**
 * Issue-row activity the operator has not seen: the issue's own updatedAt, any
 * descendant's updatedAt, and every session in the supplied set (callers pass
 * own members, or the whole subtree for a collapsed / sidebar rollup).
 */
export function subtreeUnread(args: {
  readAt: string | null | undefined
  updatedAt: string
  descendantUpdatedAts?: readonly string[]
  sessions: readonly { lastActiveAt?: string }[]
}): boolean {
  let latest = args.updatedAt
  for (const stamp of args.descendantUpdatedAts ?? []) {
    if (stamp > latest) latest = stamp
  }
  return activityAfterRead(args.readAt, latestActivityAt(latest, args.sessions))
}

/** Issue metadata only — member sessions speak for themselves on an expanded strip. */
export function issueOwnContentUnread(issue: {
  readAt?: string | null
  updatedAt: string
}): boolean {
  return activityAfterRead(issue.readAt, issue.updatedAt)
}

/** Session unread that is actually worth drawing. */
export function sessionUnreadEmphasized(session: SessionMeta): boolean {
  return session.unread === true && !isSessionWorking(session)
}
