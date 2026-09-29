import { randomUUID } from 'node:crypto'
import type { IssueId } from '@podium/model'
import type { IssueMessageRow, SessionStore } from '../store'

/**
 * Put an unread row into an issue's mailbox, as the message delivery service's
 * mirror does. Mail is SENT only through `messages.send` (POD-4846); a fixture
 * about the mailbox's read side (inbox, claim, pending) seeds the row directly,
 * so the send's delivery rules — authorization, a target with no session — are
 * not what the test depends on.
 */
export async function seedIssueMail(
  store: Pick<SessionStore, 'issues'>,
  issueId: IssueId,
  fromAuthor: string,
  body: string,
  createdAt = new Date().toISOString(),
): Promise<IssueMessageRow> {
  const row: IssueMessageRow = {
    id: `msg_${randomUUID()}`,
    issueId,
    fromAuthor,
    body,
    createdAt,
    status: 'unread',
    claimedBy: null,
    claimedAt: null,
  }
  await store.issues.addIssueMessage(row)
  return row
}
