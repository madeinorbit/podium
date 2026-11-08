import { AUTO_CONTINUE_SENDER } from '@podium/commands'
import type { IssueId, SessionId } from '@podium/model'
import { autoContinueMessageId } from './message-ids'
import type { MessageDeliveryService } from './modules/messages/service'
import type { MessageWriter } from './modules/messages/writer'

/**
 * A NOTICE FROM A SERVER JOB TO AN ISSUE IS A MESSAGE (POD-4846).
 *
 * The lock manager (grants, steals), the approval broker and the machine
 * diagnostics tell an issue something. They used to write the legacy issue
 * mailbox directly, and a separate nudge typed a pointer line into one live
 * session. Now each notice is one `messages` row from `system:<job>` to the
 * issue: delivered in full inside the envelope to the issue's session (or held
 * for its next one), mirrored into the issue's mailbox under the same id, and
 * followed by its delivery status like any mail. A system sender is told of no
 * failure. Answers the stored message's id.
 */
export function systemIssueNotice(
  messages: Pick<MessageDeliveryService, 'send'>,
  /** The job's own writer: a server job's notice is its own write (POD-6602). */
  writer: MessageWriter,
  job: string,
): (issueId: IssueId, body: string) => Promise<string> {
  return async (issueId, body) => {
    const r = await messages.send(
      writer,
      { kind: 'system', name: job },
      {
        to: { kind: 'issue', id: issueId },
        kind: 'notification',
        // next-turn: the notice's words are the point, typed in full at the
        // next turn boundary.
        urgency: 'next-turn',
        lifecycle: 'wait',
        body,
      },
    )
    return r.message.id
  }
}

/**
 * AUTO-CONTINUE IS A MESSAGE (POD-4846): the 'continue' the server types into
 * an errored agent, as one row from `system:auto-continue` per errored turn.
 * Typed inside the short frame (POD-4868) — its id in the text, none of the
 * rules for mail an agent answers — with the `auto_continue` input origin, so
 * it neither clears a standing offer nor reads as the person in the chat.
 * `wait`: it only ever goes to a running session.
 */
export function autoContinueSender(
  messages: Pick<MessageDeliveryService, 'send'>,
): (
  writer: MessageWriter,
  input: { sessionId: SessionId; erroredTurn: string },
) => Promise<{ ok: boolean; reason?: string }> {
  // The writer is whoever asked for the continue (POD-6602): the
  // `sessions.continue` command's own, or the auto-continue controller's.
  return async (writer, { sessionId, erroredTurn }) => {
    const r = await messages.send(
      writer,
      { kind: 'system', name: AUTO_CONTINUE_SENDER },
      {
        messageId: autoContinueMessageId(sessionId, erroredTurn),
        to: { kind: 'session', id: sessionId },
        kind: 'message',
        urgency: 'next-turn',
        lifecycle: 'wait',
        body: 'continue',
      },
    )
    // Stored is accepted; only a continue that ended undelivered failed.
    return r.disposition === 'dead_letter'
      ? { ok: false, ...(r.reason ? { reason: r.reason } : {}) }
      : { ok: true }
  }
}
