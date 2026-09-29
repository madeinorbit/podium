import type { IssueId } from '@podium/model'
import type { MessageDeliveryService } from './modules/messages/service'

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
  job: string,
): (issueId: IssueId, body: string) => Promise<string> {
  return async (issueId, body) => {
    const r = await messages.send(
      { kind: 'system', name: job },
      {
        to: { kind: 'issue', id: issueId },
        kind: 'notification',
        // next-turn, not fyi: an fyi issue message is delivered as a pointer to
        // the inbox, and the notice's words are the point.
        urgency: 'next-turn',
        lifecycle: 'wait',
        body,
      },
    )
    return r.message.id
  }
}
