import { randomUUID } from 'node:crypto'
import type { IssueMessageRow } from '../../../store'
import { IssueServiceAttention } from './attention'

/**
 * IssueService layer 4 — agent mail (issue #103, #190 split): durable messages
 * addressed to an ISSUE, with send-time nudge delivery via deps.onMailSent.
 */
export abstract class IssueServiceMail extends IssueServiceAttention {
  // ---- agent mail (issue #103): messages addressed to an ISSUE ----

  /** Create a mail message on the target issue, then fire the delivery hook
   *  (send-time nudge). Delivery failures never fail the send — the message is
   *  durable and will surface via prime / inbox regardless. */
  sendMail(targetIssueId: string, fromAuthor: string, body: string): IssueMessageRow {
    const id = this.resolveRef(targetIssueId)
    const row = this.rowOrThrow(id)
    const message: IssueMessageRow = {
      id: `msg_${randomUUID()}`,
      issueId: id,
      fromAuthor,
      body,
      createdAt: this.now(),
      status: 'unread',
      claimedBy: null,
      readAt: null,
      claimedAt: null,
    }
    this.deps.funnel.run({ write: () => this.deps.store.addIssueMessage(message) })
    try {
      this.deps.onMailSent?.(row, message)
    } catch {}
    return message
  }

  /** List an issue's mailbox, marking the returned currently-unread messages read
   *  (read-on-list; content is never destroyed). `wasUnread` carries the pre-read
   *  status so the caller can render the unread marker. */
  mailInbox(
    issueId: string,
    opts?: { markRead?: boolean },
  ): Array<IssueMessageRow & { wasUnread: boolean }> {
    const id = this.resolveRef(issueId)
    this.rowOrThrow(id)
    // markRead only when the RECIPIENT reads its own mailbox; a peek at another
    // issue's inbox (operator, other agents — reads are scope-free) must not
    // consume unread status or it silently suppresses stop-hook/prime delivery.
    const markRead = opts?.markRead !== false
    const messages = this.deps.store.listIssueMessages(id)
    const unreadIds = markRead ? messages.filter((m) => m.status === 'unread').map((m) => m.id) : []
    if (unreadIds.length) {
      this.deps.funnel.run({
        write: () => this.deps.store.markIssueMessagesRead(id, unreadIds, this.now()),
      })
    }
    return messages.map((m) => ({
      ...m,
      ...(markRead && m.status === 'unread' ? { status: 'read' as const, readAt: this.now() } : {}),
      wasUnread: m.status === 'unread',
    }))
  }

  /** Atomic claim (single guarded UPDATE): `claimed` is false when someone else won. */
  mailClaim(messageId: string, claimedBy: string): { claimed: boolean; message: IssueMessageRow } {
    const claimed = this.deps.funnel.run({
      write: () => this.deps.store.claimIssueMessage(messageId, claimedBy, this.now()),
    })
    const message = this.deps.store.getIssueMessage(messageId)
    if (!message) throw new Error(`unknown mail message ${messageId}`)
    return { claimed, message }
  }

  /** Cheap unread check (for stop-hooks / polling). */
  mailPending(issueId: string): { unread: number } {
    const id = this.resolveRef(issueId)
    this.rowOrThrow(id)
    return { unread: this.deps.store.countUnreadIssueMessages(id) }
  }

  /** The issue a mail message belongs to (router scope enforcement for mailClaim). */
  mailMessage(messageId: string): IssueMessageRow | null {
    return this.deps.store.getIssueMessage(messageId)
  }
}
