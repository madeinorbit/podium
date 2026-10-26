/**
 * The agent-facing mail nudges a turn-end hook returns as its block reason
 * [spec:SP-34d7] — the daemon builds them, and the transcript adapters match
 * them so the chat does not show them: the human sees the mail itself. One copy
 * here, so a rewording cannot leave the chat showing a nudge it no longer knows.
 */
const UNREAD_PREFIX = 'You have '
const UNREAD_TAIL = ` on your issue: run 'podium issue mail inbox' to read them now; `
const ACK_TAIL = ' podium message(s) awaiting your reply before you go idle:\n'

/** Pointer rendering (#237): N pending messages coalesce into one inbox pointer,
 *  naming the senders when the server supplies them. */
export function mailUnreadNudge(unread: number, senders: readonly string[]): string {
  const who = senders.length > 0 ? ` from ${senders.join(', ')}` : ''
  return (
    `${UNREAD_PREFIX}${unread} message(s)${who}${UNREAD_TAIL}` +
    "claim a message with 'podium issue mail claim <id>' only if you will act on it."
  )
}

/** The single reminder for delivered-but-unacked messages (#237 acks). */
export function mailAckNudge(reminders: readonly { id: string; from: string }[]): string {
  const lines = reminders
    .slice(0, 5)
    .map(
      (m) =>
        `- ${m.id} (from ${m.from}): reply with what you did — podium mail reply ${m.id} --body "…"`,
    )
  return (
    `${UNREAD_PREFIX}${reminders.length}${ACK_TAIL}` +
    `${lines.join('\n')}\n` +
    'This is your only reminder; unanswered senders get a mechanical system notice instead.'
  )
}

/** True for text either builder above produced. */
export function isMailNudge(text: string): boolean {
  return text.startsWith(UNREAD_PREFIX) && (text.includes(UNREAD_TAIL) || text.includes(ACK_TAIL))
}
