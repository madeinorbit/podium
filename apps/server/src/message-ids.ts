import { createHash } from 'node:crypto'
import { MESSAGE_ID_PREFIX, type SessionId } from '@podium/model'

/**
 * A MESSAGE ID DERIVED FROM WHAT THE MESSAGE IS, for the messages the server
 * writes itself (POD-4763). Every attempt at the same message carries the same
 * id, so a crash between writing and telling repeats the write under that id,
 * and the store keeps one row per id. Shaped like a sender-minted id — `msg_`
 * and a UUID laid out from a hash — so it passes the one check every message id
 * meets at the boundary, rather than widening that check.
 */
export function derivedMessageId(key: string): string {
  const h = createHash('sha256').update(key).digest('hex')
  const variant = ((Number.parseInt(h.charAt(16), 16) & 0x3) | 0x8).toString(16)
  return `${MESSAGE_ID_PREFIX}${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-${variant}${h.slice(17, 20)}-${h.slice(20, 32)}`
}

/** The notice telling a sender that `messageId` was not delivered (POD-4778).
 *  A message fails at most once, so it has at most one notice. */
export const failureNoticeId = (messageId: string): string =>
  derivedMessageId(`failure-notice\u0000${messageId}`)

/** The task prompt a session was spawned with, as a message from its spawner
 *  (POD-4778). One per session. */
export const spawnPromptMessageId = (sessionId: SessionId): string =>
  derivedMessageId(`spawn-prompt\u0000${sessionId}`)

/** One automation run's prompt to one session (POD-4846). Per target as well as
 *  per run: a resume that could not happen falls back to a fresh session, and
 *  that prompt is a second message. */
export const automationPromptMessageId = (runId: string, sessionId: SessionId): string =>
  derivedMessageId(`automation-prompt\u0000${runId}\u0000${sessionId}`)

/** The auto-continue for one errored turn of one session (POD-4846). The retry
 *  loop fires again while the session stays errored; every firing inside the
 *  same errored turn is this one message, and a retry that errors again is a
 *  new turn and a new message. */
export const autoContinueMessageId = (sessionId: SessionId, erroredTurn: string): string =>
  derivedMessageId(`auto-continue\u0000${sessionId}\u0000${erroredTurn}`)
