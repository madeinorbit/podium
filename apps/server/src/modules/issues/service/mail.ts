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
   */
  addComment(id: string, author: string, body: string, principal?: CommandPrincipal): IssueWire {
    const issueId = this.store.resolveRef(id)
    const row = this.store.rowOrThrow(issueId)
    const attribution = principal ? attributionOf(principal) : undefined
    return this.store.persistWith(row, () =>
      this.store.deps.store.issues.addIssueComment({
        id: `cmt_${randomUUID()}`,
        issueId,
        author,
        body,
        createdAt: this.store.now(),
        ...(attribution ? { actor: attribution.actor, onBehalfOf: attribution.onBehalfOf } : {}),
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

  /** List an issue's mailbox, marking the returned currently-unread messages read
   *  (read-on-list; content is never destroyed). `wasUnread` carries the pre-read
   *  status so the caller can render the unread marker. */
  mailInbox(
    issueId: string,
    opts?: { markRead?: boolean },
  ): Array<IssueMessageRow & { wasUnread: boolean }> {
    const id = this.store.resolveRef(issueId)
    this.store.rowOrThrow(id)
    // markRead only when the RECIPIENT reads its own mailbox; a peek at another
    // issue's inbox (operator, other agents — reads are scope-free) must not
    // consume unread status or it silently suppresses stop-hook/prime delivery.
    const markRead = opts?.markRead !== false
    const messages = this.store.deps.store.issues.listIssueMessages(id)
    const unreadIds = markRead ? messages.filter((m) => m.status === 'unread').map((m) => m.id) : []
    if (unreadIds.length) {
      this.store.deps.funnel.run({
        write: () => {
          // PER-USER read markers (POD-1076): `status` is the mail's shared
          // delivery state, `read_at` is a fact about THIS reader.
          this.store.deps.store.issues.markIssueMessagesRead(
            this.store.broadcastViewer(),
            id,
            unreadIds,
            this.store.now(),
          )
          // Unified substrate mirror (#237) [spec:SP-34d7]: the rows share ids —
          // a recipient read consumes the queued status on BOTH tables, so the
          // stop-hook/prime pending count (new source) stops nagging too.
          for (const mid of unreadIds)
            this.store.deps.store.messages.markDelivered(mid, null, this.store.now())
        },
      })
    }
    return messages.map((m) => ({
      ...m,
      ...(markRead && m.status === 'unread'
        ? { status: 'read' as const, readAt: this.store.now() }
        : {}),
      wasUnread: m.status === 'unread',
    }))
  }

  /** Atomic claim (single guarded UPDATE): `claimed` is false when someone else won. */
  mailClaim(messageId: string, claimedBy: string): { claimed: boolean; message: IssueMessageRow } {
    const claimed = this.store.deps.funnel.run({
      write: () => {
        const won = this.store.deps.store.issues.claimIssueMessage(
          messageId,
          claimedBy,
          this.store.now(),
        )
        // Keep the unified-substrate mirror row in step (#237) [spec:SP-34d7].
        if (won) this.store.deps.store.messages.markDelivered(messageId, null, this.store.now())
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
  mailPending(issueId: string): { unread: number; senders: string[] } {
    const id = this.store.resolveRef(issueId)
    this.store.rowOrThrow(id)
    return countContextAwarePendingMail(this.store.deps.store, id, (fromIssue) => {
      const issue = this.reports().get(fromIssue)
      return issue ? `issue:#${issue.seq}` : fromIssue
    })
  }

  /** The issue a mail message belongs to (router scope enforcement for mailClaim). */
  mailMessage(messageId: string): IssueMessageRow | null {
    return this.store.deps.store.issues.getIssueMessage(messageId)
  }
}
