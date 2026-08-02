import { randomUUID } from 'node:crypto'
import type { IssueMessageRow } from '../../../store'
import { IssueServiceAttention } from './attention'
import { countContextAwarePendingMail } from './mail-pending'

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
    this.deps.funnel.run({ write: () => this.deps.store.issues.addIssueMessage(message) })
    try {
      this.deps.onMailSent?.(row, message)
    } catch {}
    return message
  }

  /** List an issue's mailbox, marking the returned messages read FOR THE READING
   *  SESSION (read-on-list; content is never destroyed). `wasUnread` carries the
   *  pre-read status so the caller can render the unread marker.
   *
   *  The mailbox is per ISSUE and several agents work one issue, so the read
   *  state is per READER [POD-1379] [spec:SP-b11e]: it records a receipt for `sessionId` and
   *  leaves every peer's unread status intact. The shared delivery ledger still
   *  advances (it is what stops the push/retry sweep re-injecting a message the
   *  issue has now pulled) — it just no longer decides who gets nagged. */
  mailInbox(
    issueId: string,
    opts?: { markRead?: boolean; sessionId?: string },
  ): Array<IssueMessageRow & { wasUnread: boolean }> {
    const id = this.resolveRef(issueId)
    this.rowOrThrow(id)
    // markRead only when the RECIPIENT reads its own mailbox; a peek at another
    // issue's inbox (operator, other agents — reads are scope-free) must not
    // consume unread status or it silently suppresses stop-hook/prime delivery.
    const markRead = opts?.markRead !== false
    const reader = opts?.sessionId
    const messages = this.deps.store.issues.listIssueMessages(id)
    const unreadIds = markRead ? messages.filter((m) => m.status === 'unread').map((m) => m.id) : []
    // Per-reader unread: what THIS session has not yet been shown, whatever a
    // peer already did to the shared row.
    const ids = messages.map((m) => m.id)
    const seen = reader ? this.deps.store.messages.readReceipts(reader, ids) : new Set<string>()
    const mine = reader ? this.deps.store.messages.selfSentIds(reader, ids) : new Set<string>()
    const wasUnread = (m: IssueMessageRow): boolean =>
      reader ? !seen.has(m.id) && !mine.has(m.id) : m.status === 'unread'
    // Everything this read puts in the reader's context, minus what it already
    // had — the receipts are what the nag counts, so they are the whole point of
    // the write, and re-reading an inbox must stay free.
    const newReceipts = reader ? ids.filter((mid) => !seen.has(mid)) : []
    if (markRead && (unreadIds.length || newReceipts.length)) {
      this.deps.funnel.run({
        write: () => {
          const at = this.now()
          if (unreadIds.length) {
            this.deps.store.issues.markIssueMessagesRead(id, unreadIds, at)
            // Unified substrate mirror (#237) [spec:SP-34d7]: the rows share ids —
            // the pull advances the shared delivery ledger on BOTH tables so the
            // sweep stops pushing what the issue has now read.
            // NAME the reader on the ledger [POD-1420]. A pull is a delivery to a
            // known session, so `delivered_to` is that session. Passing null here
            // made every inbox read indistinguishable from mail that reached
            // nobody — the two are the same row shape, and the resulting
            // `delivered_to IS NULL` count was read as a mass delivery failure
            // when it was overwhelmingly the pull path working. A readerless peek
            // (operator/UI) still has nobody to name and stays null.
            for (const mid of unreadIds)
              this.deps.store.messages.markDeliveredByPull(mid, reader ?? null, at)
          }
          if (reader)
            for (const mid of newReceipts) this.deps.store.messages.recordRead(mid, reader, at)
        },
      })
    }
    return messages.map((m) => ({
      ...m,
      ...(markRead && m.status === 'unread' ? { status: 'read' as const, readAt: this.now() } : {}),
      wasUnread: wasUnread(m),
    }))
  }

  /** Atomic claim (single guarded UPDATE): `claimed` is false when someone else won.
   *  Claim stays what it always was — the OPT-IN "I will act on this" signal, one
   *  winner. Delivery never depends on it [spec:SP-b11e]: an unclaimed message still
   *  reaches every session on the issue exactly once. Claiming does prove the
   *  claimer has the message, so it records that reader's receipt. */
  mailClaim(
    messageId: string,
    claimedBy: string,
    opts?: { sessionId?: string },
  ): { claimed: boolean; message: IssueMessageRow } {
    const claimed = this.deps.funnel.run({
      write: () => {
        const won = this.deps.store.issues.claimIssueMessage(messageId, claimedBy, this.now())
        // Keep the unified-substrate mirror row in step (#237) [spec:SP-34d7].
        // The claimer demonstrably has the message, so it is the reader the
        // ledger names [POD-1420]; absent a session id there is nobody to name.
        if (won)
          this.deps.store.messages.markDeliveredByPull(
            messageId,
            opts?.sessionId ?? null,
            this.now(),
          )
        if (opts?.sessionId) {
          this.deps.store.messages.recordRead(messageId, opts.sessionId, this.now())
        }
        return won
      },
    })
    const message = this.deps.store.issues.getIssueMessage(messageId)
    if (!message) throw new Error(`unknown mail message ${messageId}`)
    return { claimed, message }
  }

  /** Cheap pending check (for stop-hooks / polling). CONTEXT-AWARE [POD-909]
   *  (design §10): only messages NOT yet in the agent's context drive the
   *  "run mail inbox" nag. Substrate source of truth:
   *    - `queued`  — never transcript-confirmed / never pulled → count it
   *    - `delivered` — envelope echoed as a turn → already in context → EXCLUDE
   *    - `read` / terminal — consumed or gone → EXCLUDE
   *  `countPending` counts status='queued' only. The legacy
   *  issue_messages unread count is a transition fallback for pre-substrate
   *  rows only: a dual-written twin that has left `queued` must not resurrect
   *  the nag when the mirror lags. `senders` lets the stop-hook render the
   *  coalesced pointer ("N messages from X, Y"). */
  mailPending(
    issueId: string,
    opts?: { sessionId?: string },
  ): { unread: number; senders: string[] } {
    const id = this.resolveRef(issueId)
    this.rowOrThrow(id)
    return countContextAwarePendingMail(
      this.deps.store,
      id,
      (fromIssue) => {
        const issue = this.get(fromIssue)
        return issue ? `issue:#${issue.seq}` : fromIssue
      },
      opts?.sessionId,
    )
  }

  /** The issue a mail message belongs to (router scope enforcement for mailClaim). */
  mailMessage(messageId: string): IssueMessageRow | null {
    return this.deps.store.issues.getIssueMessage(messageId)
  }
}
