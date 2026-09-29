/**
 * MESSAGES THAT DID NOT ARRIVE, ANYWHERE IN THE APP (POD-4764).
 *
 * A chat message the server says will not be delivered (`failed`, `expired`),
 * or that nobody can vouch for (`unknown`), is shown in its chat — and here,
 * so a person who has moved on to another screen still learns it. Read from the
 * same synced records the chat reads; it leaves when its sender dismisses it
 * or sends it again, on every device at once.
 */

import {
  deadLetterDeliveryLine,
  isMessageRecordAttention,
  type MessageRecordWire,
  type SessionId,
  type SessionMeta,
} from '@podium/model'
import { sessionTitle } from './session-card'

export interface MessageNotice {
  readonly messageId: string
  readonly sessionId: SessionId
  /** The session it was sent to, as its card names it. */
  readonly sessionLabel: string
  /** The message's first line, shortened. */
  readonly excerpt: string
  readonly status: 'failed' | 'expired' | 'unknown'
  /** What happened, in the chat bubble's words. */
  readonly line: string
  readonly createdAt: string
}

const EXCERPT_MAX = 80

function excerptOf(body: string): string {
  const first = body.trim().split('\n')[0] ?? ''
  return first.length > EXCERPT_MAX ? `${first.slice(0, EXCERPT_MAX - 1)}…` : first
}

/** What happened to a message the server says did not (or may not have) arrived. */
export function messageNoticeLine(record: Pick<MessageRecordWire, 'status' | 'reason'>): string {
  if (record.status === 'unknown') return 'not confirmed — it may or may not have arrived'
  if (record.status === 'expired') return 'not delivered · it waited too long'
  return deadLetterDeliveryLine(record.reason)
}

/** The notices, newest first. */
export function messageNotices(
  records: readonly MessageRecordWire[],
  sessions: readonly SessionMeta[],
): MessageNotice[] {
  const byId = new Map(sessions.map((session) => [session.sessionId as string, session]))
  const notices: MessageNotice[] = []
  for (const record of records) {
    if (!isMessageRecordAttention(record.status)) continue
    const session = byId.get(record.sessionId)
    notices.push({
      messageId: record.id,
      sessionId: record.sessionId,
      sessionLabel: session ? sessionTitle(session) : 'a closed session',
      excerpt: excerptOf(record.body),
      status: record.status as MessageNotice['status'],
      line: messageNoticeLine(record),
      createdAt: record.createdAt,
    })
  }
  return notices.sort((a, b) => b.createdAt.localeCompare(a.createdAt))
}
