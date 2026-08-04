import { randomUUID } from 'node:crypto'
import type { IssueWire } from '@podium/model'
import { attributionOf, type CommandPrincipal } from '../../../command-principal'
import type { IssueMessageRow } from '../../../store'
import type { IssueStore } from './core'
import { countContextAwarePendingMail } from './mail-pending'
import type { IssueReportsModule } from './reads'

/**
 * Comments and tracker-mail capability: durable messages
 * addressed to an ISSUE, with send-time nudge delivery via deps.onMailSent.
 */
export class IssueCommentsMailModule {
  constructor(
    readonly store: IssueStore,
    private readonly reports: () => Pick<IssueReportsModule, 'comments' | 'get'>,
  ) {}

  comments(
    ...args: Parameters<IssueReportsModule['comments']>
  ): ReturnType<IssueReportsModule['comments']> {
    return this.reports().comments(...args)
  }
  /**
   * Comments inherit their issue aggregate's owner and grants; actor and
   * on-behalf-of attribution are stamped from the authenticated principal.
   *
   * `principal` is REQUIRED and deliberately has no default (POD-1315). It was
   * optional here and defaulted to the first admin one layer up, which meant a
   * caller that simply forgot to say who was acting silently acted AS the
   * administrator — the fail-open shape ADR 3 Amendment 1 D14 rules out. There
   * is no identity this method could invent that would be honest: a human
   * behind a transport, an agent, and an in-process job are three different
   * answers and only the caller knows which one it is. Omission is therefore a
   * compile error, and `addComment-principal.test.ts` beside this file fails
   * the BUILD (not just the run) if a default comes back.
   */
  addComment(id: string, author: string, body: string, principal: CommandPrincipal): IssueWire {
    const issueId = this.store.resolveRef(id)
    const row = this.store.rowOrThrow(issueId)
    const attribution = attributionOf(principal)
    return this.store.persistWith(row, () =>
      this.store.deps.store.issues.addIssueComment({
        id: `cmt_${randomUUID()}`,
        issueId,
        author,
        body,
        createdAt: this.store.now(),
        actor: attribution.actor,
        onBehalfOf: attribution.onBehalfOf,
      }),
    )
  }

  // ---- agent mail (issue #103): messages addressed to an ISSUE ----

  /** Create a mail message on the target issue, then fire the delivery hook
   *  (send-time nudge). Delivery failures never fail the send — the message is
   *  durable and will surface via prime / inbox regardless. */
  sendMail(targetIssueId: string, fromAuthor: string, body: string): IssueMessageRow {
    const id = this.store.resolveRef(targetIssueId)
    const row = this.store.rowOrThrow(id)
    const message: IssueMessageRow = {
      id: `msg_${randomUUID()}`,
      issueId: id,
      fromAuthor,
      body,
      createdAt: this.store.now(),
      status: 'unread',
      claimedBy: null,
      claimedAt: null,
    }
    this.store.deps.funnel.run({
      write: () => this.store.deps.store.issues.addIssueMessage(message),
    })
    try {
      this.store.deps.onMailSent?.(row, message)
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
    const id = this.store.resolveRef(issueId)
    this.store.rowOrThrow(id)
    // markRead only when the RECIPIENT reads its own mailbox; a peek at another
    // issue's inbox (operator, other agents — reads are scope-free) must not
    // consume unread status or it silently suppresses stop-hook/prime delivery.
    const markRead = opts?.markRead !== false
    const reader = opts?.sessionId
    const messages = this.store.deps.store.issues.listIssueMessages(id)
    const unreadIds = markRead ? messages.filter((m) => m.status === 'unread').map((m) => m.id) : []
    // Per-reader unread [POD-1379]: what THIS session has not yet been shown,
    // whatever a peer on the same shared issue mailbox already did to the row.
    const ids = messages.map((m) => m.id)
    const seen = reader
      ? this.store.deps.store.messages.readReceipts(reader, ids)
      : new Set<string>()
    const mine = reader
      ? this.store.deps.store.messages.selfSentIds(reader, ids)
      : new Set<string>()
    const wasUnread = (m: IssueMessageRow): boolean =>
      reader ? !seen.has(m.id) && !mine.has(m.id) : m.status === 'unread'
    // Everything this read puts in the reader's context, minus what it already
    // had — the receipts are what the nag counts, so they are the whole point of
    // the write, and re-reading an inbox must stay free.
    const newReceipts = reader ? ids.filter((mid) => !seen.has(mid)) : []
    if (markRead && (unreadIds.length || newReceipts.length)) {
      this.store.deps.funnel.run({
        write: () => {
          const at = this.store.now()
          if (unreadIds.length) {
            // PER-USER read markers (POD-1076): `status` is the mail's shared
            // delivery state, `read_at` is a fact about THIS reader.
            this.store.deps.store.issues.markIssueMessagesRead(
              this.store.broadcastViewer(),
              id,
              unreadIds,
              at,
            )
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
              this.store.deps.store.messages.markDeliveredByPull(mid, reader ?? null, at)
          }
          if (reader)
            for (const mid of newReceipts)
              this.store.deps.store.messages.recordRead(mid, reader, at)
        },
      })
    }
    return messages.map((m) => ({
      ...m,
      ...(markRead && m.status === 'unread'
        ? { status: 'read' as const, readAt: this.store.now() }
        : {}),
      wasUnread: wasUnread(m),
    }))
  }

  /** Atomic claim (single guarded UPDATE): `claimed` is false when someone else won.
   *  Claim stays what it always was — the OPT-IN "I will act on this" signal, one
   *  winner. Delivery never depends on it [spec:SP-b11e]: an unclaimed message still
   *  reaches every session on the issue exactly once. Claiming does prove the
   *  claimer has the message, so it records that reader's receipt [POD-1379]. */
  mailClaim(
    messageId: string,
    claimedBy: string,
    opts?: { sessionId?: string },
  ): { claimed: boolean; message: IssueMessageRow } {
    const claimed = this.store.deps.funnel.run({
      write: () => {
        const won = this.store.deps.store.issues.claimIssueMessage(
          messageId,
          claimedBy,
          this.store.now(),
        )
        // Keep the unified-substrate mirror row in step (#237) [spec:SP-34d7].
        // The claimer demonstrably has the message, so it is the reader the
        // ledger names [POD-1420]; absent a session id there is nobody to name.
        if (won)
          this.store.deps.store.messages.markDeliveredByPull(
            messageId,
            opts?.sessionId ?? null,
            this.store.now(),
          )
        if (opts?.sessionId) {
          this.store.deps.store.messages.recordRead(messageId, opts.sessionId, this.store.now())
        }
        return won
      },
    })
    const message = this.store.deps.store.issues.getIssueMessage(messageId)
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
    const id = this.store.resolveRef(issueId)
    this.store.rowOrThrow(id)
    return countContextAwarePendingMail(
      this.store.deps.store,
      id,
      (fromIssue) => {
        const issue = this.reports().get(fromIssue)
        return issue ? `issue:#${issue.seq}` : fromIssue
      },
      opts?.sessionId,
    )
  }

  /** The issue a mail message belongs to (router scope enforcement for mailClaim). */
  mailMessage(messageId: string): IssueMessageRow | null {
    return this.store.deps.store.issues.getIssueMessage(messageId)
  }
}
