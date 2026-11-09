/**
 * A member's pin of a task in a test (POD-6692): a `pins` row of kind 'issue',
 * written straight to the store. The app writes it as a `records.pin` create or
 * remove; tests that only need the row pinned (the sort scope, a listing) set
 * it here, for the task's assignee unless a member is named.
 */

import type { UserId } from '@podium/model'
import type { SessionStore } from '../store'

export async function pinIssueFor(
  store: Pick<SessionStore, 'issues' | 'sessions'>,
  issueId: string,
  pinned: boolean,
  member?: UserId,
): Promise<void> {
  const user = member ?? (await store.issues.getIssue(issueId))?.ownerUserId
  if (!user) throw new Error(`issue ${issueId} has no member to pin it for`)
  if (pinned) await store.sessions.addPin(user, 'issue', issueId, new Date().toISOString())
  else await store.sessions.removePin(user, 'issue', issueId)
}
