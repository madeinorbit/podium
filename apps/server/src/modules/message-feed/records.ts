/**
 * A DEVICE'S OWN MESSAGES, BY ID (POD-4811) — the catch-up beside the feed.
 *
 * The feed carries a chat message while it is on its way, until its sender
 * dismisses a notice, and for its session's last few confirmations
 * (`CONFIRMED_PER_SESSION`). A device that was away longer than that never
 * sees the record of a message it sent, so its bubble would keep what the
 * device last knew ("sending", "sent") forever. It asks for those ids here
 * instead, all in one read, and settles the bubbles from the answer.
 *
 * The answer is each record exactly as the feed would carry it, read from the
 * table — plus `noticeDismissedAt`, which the feed never carries because a
 * dismissed message has left it. Who may read one is the feed's own rule for
 * kind `message` (`feed-visibility.ts`): the person who sent it, and the owner
 * of the session it was sent to. An id with no row, a row that is not a
 * person's chat message, and a row someone else may read are all simply left
 * out: nobody can tell them apart from the answer.
 */

import type { MessageRecordWire, UserId } from '@podium/model'
import type { MessagesRepository } from '../../store/messages'
import type { SessionsRepository } from '../../store/sessions'
import { messageRecordOf } from './feed'

export interface MessageRecordReadDeps {
  readonly messages: Pick<MessagesRepository, 'getMessages'>
  readonly sessions: Pick<SessionsRepository, 'getSessions'>
}

/** The records of these messages that `userId` may read, in one read of each table. */
export async function readMessageRecords(
  deps: MessageRecordReadDeps,
  userId: UserId,
  ids: readonly string[],
): Promise<MessageRecordWire[]> {
  const records: MessageRecordWire[] = []
  for (const row of await deps.messages.getMessages(ids)) {
    const record = messageRecordOf(row)
    if (record !== null) records.push(record)
  }
  const others = [
    ...new Set(
      records.filter((record) => record.senderUserId !== userId).map((r) => r.sessionId),
    ),
  ]
  const sessions = others.length === 0 ? new Map() : await deps.sessions.getSessions(others)
  return records.filter(
    (record) =>
      record.senderUserId === userId || sessions.get(record.sessionId)?.ownerUserId === userId,
  )
}
