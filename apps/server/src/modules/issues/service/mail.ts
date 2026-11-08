import { randomUUID } from 'node:crypto'
import type { IssueId, IssueProjection, SessionId, UserId } from '@podium/model'
import { attributionOf, type CommandAttribution, type CommandPrincipal, onBehalfOfUser } from '../../../command-principal'
import type { IssueMessageRow } from '../../../store'
import { settingsAuditAttribution } from '../../../store/settings-audit'
import type { IssueStore } from './core'
import { countContextAwarePendingMail } from './mail-pending'
import { IssueNotFound } from './not-found'
import type { IssueReportsModule } from './reads'
import { IssueForbidden, IssueRefusal } from './refusal'
import type { IssueWriter } from './types'

/**
 * IS THIS COMMENT THE CALLER'S OWN (POD-6289, POD-6295; design §2.2)? Its
 * author is the human it was written for, so a member's agent counts as that
 * member. A comment with no recorded author is nobody's. The one rule behind
 * both the edit and delete refusal and the task page's edit control.
 */
export function isCommentAuthor(
  authorId: string | null | undefined,
  principal: CommandPrincipal,
): boolean {
  const caller = onBehalfOfUser(principal)
  return caller !== null && authorId === caller
}

/**
 * Comments and tracker-mail capability: an issue's comments, and the read side
 * of its mailbox (the messages addressed to the issue, mirrored in by the
 * message delivery service).
 */
export class IssueCommentsMailModule {
  constructor(
    readonly store: IssueStore,
    private readonly reports: () => Pick<IssueReportsModule, 'comments' | 'get'>,
  ) {}

  async comments(
    ...args: Parameters<IssueReportsModule['comments']>
  ): Promise<Awaited<ReturnType<IssueReportsModule['comments']>>> {
    return await this.reports().comments(...args)
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
  async addComment(
    writer: IssueWriter,
    id: string,
    author: string,
    body: string,
    principal: CommandPrincipal | CommandAttribution,
  ): Promise<IssueProjection> {
    const issueId = await this.store.resolveRef(id)
    const row = await this.store.draftOrThrow(issueId)
    // An effect's executor (POD-6394) has the stored attribution, not a live principal.
    const attribution = 'kind' in principal ? attributionOf(principal) : principal
    return await this.store.persistWith(
      writer,
      row,
      async () =>
        await this.store.deps.store.issues.addIssueComment({
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

  /**
   * A comment from a TRANSPORT caller (POD-4751): the displayed author is
   * derived from the principal, never taken from the request. `addComment`
   * above stays the server-side path for in-process writers (steward,
   * integrate, workflow audit notes) that name themselves — and the steward
   * and integrate dedupe on those names, so a client that could choose its
   * author could also suppress their notes.
   */
  async addCallerComment(
    writer: IssueWriter,
    id: string,
    body: string,
    principal: CommandPrincipal,
  ): Promise<IssueProjection> {
    return await this.addComment(writer, id, await this.authorOf(principal), body, principal)
  }

  /**
   * EDIT OR DELETE A COMMENT (POD-6289, design §2.2/§4.4).
   *
   * Only the comment's author may: the human it was written for, so a
   * member's agent edits its human's comments and nobody else's. An admin may
   * moderate any comment. That is allowed, written to the audit trail in the
   * same transaction, and the comment keeps its author: a moderated edit
   * stamps the admin as `edited_on_behalf_of` and never touches the author
   * columns. A comment with no recorded author (written before attribution)
   * can only be moderated.
   */
  async editComment(
    writer: IssueWriter,
    id: string,
    commentId: string,
    body: string,
    principal: CommandPrincipal,
  ): Promise<IssueProjection> {
    return await this.changeComment(writer, id, commentId, principal, { kind: 'edit', body })
  }

  async deleteComment(
    writer: IssueWriter,
    id: string,
    commentId: string,
    principal: CommandPrincipal,
  ): Promise<IssueProjection> {
    return await this.changeComment(writer, id, commentId, principal, { kind: 'delete' })
  }

  private async changeComment(
    writer: IssueWriter,
    id: string,
    commentId: string,
    principal: CommandPrincipal,
    change: { kind: 'edit'; body: string } | { kind: 'delete' },
  ): Promise<IssueProjection> {
    const issueId = await this.store.resolveRef(id)
    const row = await this.store.draftOrThrow(issueId)
    const issues = this.store.deps.store.issues
    const comment = await issues.getIssueComment(commentId)
    // Another task's comment is as unknown here as a missing one.
    if (!comment || comment.issueId !== issueId) {
      throw new IssueNotFound(`comment ${commentId}`)
    }
    const authored = isCommentAuthor(comment.onBehalfOf, principal)
    // Moderation is a PERSON's admin action: an admin's agent is not an admin.
    const moderating =
      !authored &&
      principal.kind === 'user' &&
      (await this.store.deps.store.users.get(principal.user))?.role === 'admin'
    if (!authored && !moderating) {
      throw new IssueForbidden(`only the comment's author can ${change.kind} comment ${commentId}`)
    }
    const attribution = attributionOf(principal)
    const at = this.store.now()
    return await this.store.persistWith(writer, row, async () => {
      if (change.kind === 'edit') {
        await issues.editIssueComment({
          id: commentId,
          body: change.body,
          editedAt: at,
          editedBy: attribution.actor,
          editedOnBehalfOf: attribution.onBehalfOf,
        })
      } else {
        await issues.deleteIssueComment(commentId)
      }
      if (moderating) {
        await this.store.deps.store.settingsAudit.append({
          command: change.kind === 'edit' ? 'issues.editComment' : 'issues.deleteComment',
          outcome: 'applied',
          ...settingsAuditAttribution(principal),
          // Ids only: the audit trail carries no comment text.
          detail: {
            moderation: true,
            issueId,
            commentId,
            authorId: comment.onBehalfOf ?? null,
            authorActor: comment.actor ?? null,
          },
          redactedPaths: [],
          createdAt: at,
        })
      }
    })
  }

  /** The display name a principal comments under: a human's own profile name,
   *  an issue-bound agent as `issue:#<seq>` (the mail sender's vocabulary). */
  private async authorOf(principal: CommandPrincipal): Promise<string> {
    switch (principal.kind) {
      case 'user':
        return (
          (await this.store.deps.store.users.get(principal.user))?.displayName || principal.user
        )
      case 'agent': {
        const scope = principal.capability.scope
        if (scope.kind !== 'subtree') return 'agent'
        const root = await this.store.row(scope.rootId)
        return root ? `issue:#${root.seq}` : 'agent'
      }
      case 'system':
        return `system:${principal.job}`
    }
  }

  // ---- agent mail (issue #103): messages addressed to an ISSUE ----
  //
  // Sending is the message delivery service's (`messages.send` to the issue),
  // which mirrors each issue message into this mailbox under its id (POD-4846
  // deleted the direct write and its pointer nudge). What stays here is the
  // mailbox's read side: inbox, claim, pending.

  /** List an issue's mailbox, marking the returned messages read FOR THE READING
   *  SESSION (read-on-list; content is never destroyed). `wasUnread` carries the
   *  pre-read status so the caller can render the unread marker.
   *
   *  The mailbox is per ISSUE and several agents work one issue, so the read
   *  state is per READER [POD-1379] [spec:SP-b11e]: it records a receipt for `sessionId` and
   *  leaves every peer's unread status intact. The shared delivery ledger still
   *  advances (it is what stops the push/retry sweep re-injecting a message the
   *  issue has now pulled) — it just no longer decides who gets nagged. */
  async mailInbox(
    writer: IssueWriter,
    issueId: IssueId,
    opts?: {
      markRead?: boolean
      sessionId?: SessionId
      /** Whose per-user read markers the read writes: the member the reading
       *  agent acts for (POD-6291). Absent = no per-user marker, only the
       *  shared delivery state moves. */
      member?: UserId
    },
  ): Promise<Array<IssueMessageRow & { wasUnread: boolean }>> {
    const id = await this.store.resolveRef(issueId)
    await this.store.rowOrThrow(id)
    // markRead only when the RECIPIENT reads its own mailbox; a peek at another
    // issue's inbox (operator, other agents — reads are scope-free) must not
    // consume unread status or it silently suppresses stop-hook/prime delivery.
    const markRead = opts?.markRead !== false
    const reader = opts?.sessionId
    const messages = await this.store.deps.store.issues.listIssueMessages(id)
    const unreadIds = markRead ? messages.filter((m) => m.status === 'unread').map((m) => m.id) : []
    // Per-reader unread [POD-1379]: what THIS session has not yet been shown,
    // whatever a peer on the same shared issue mailbox already did to the row.
    const ids = messages.map((m) => m.id)
    const seen = reader
      ? await this.store.deps.store.messages.readReceipts(reader, ids)
      : new Set<string>()
    const mine = reader
      ? await this.store.deps.store.messages.selfSentIds(reader, ids)
      : new Set<string>()
    const wasUnread = (m: IssueMessageRow): boolean =>
      reader ? !seen.has(m.id) && !mine.has(m.id) : m.status === 'unread'
    // Everything this read puts in the reader's context, minus what it already
    // had — the receipts are what the nag counts, so they are the whole point of
    // the write, and re-reading an inbox must stay free.
    const newReceipts = reader ? ids.filter((mid) => !seen.has(mid)) : []
    if (markRead && (unreadIds.length || newReceipts.length)) {
      // On the reading command's writer (POD-6602): the pull moves the messages
      // rows' delivery status, a synced write; their feed changes come from the
      // messages table's capture, so the commit declares none.
      await writer.commit({
        changes: () => [],
        write: async (scope) => {
          const at = this.store.now()
          if (unreadIds.length) {
            // PER-USER read markers (POD-1076): `status` is the mail's shared
            // delivery state, `read_at` is a fact about THIS reader.
            await this.store.deps.store.issues.markIssueMessagesRead(
              opts?.member ?? null,
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
              await this.store.deps.store.messages.markDeliveredByPull(
                scope,
                mid,
                reader ?? null,
                at,
              )
          }
          if (reader)
            for (const mid of newReceipts)
              await this.store.deps.store.messages.recordRead(mid, reader, at)
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
  async mailClaim(
    writer: IssueWriter,
    messageId: string,
    claimedBy: string,
    opts?: { sessionId?: SessionId },
  ): Promise<{ claimed: boolean; message: IssueMessageRow }> {
    const { result: claimed } = await writer.commit({
      changes: () => [],
      write: async (scope) => {
        const won = await this.store.deps.store.issues.claimIssueMessage(
          messageId,
          claimedBy,
          this.store.now(),
        )
        // Keep the unified-substrate mirror row in step (#237) [spec:SP-34d7].
        // The claimer demonstrably has the message, so it is the reader the
        // ledger names [POD-1420]; absent a session id there is nobody to name.
        if (won)
          await this.store.deps.store.messages.markDeliveredByPull(
            scope,
            messageId,
            opts?.sessionId ?? null,
            this.store.now(),
          )
        if (opts?.sessionId) {
          await this.store.deps.store.messages.recordRead(
            messageId,
            opts.sessionId,
            this.store.now(),
          )
        }
        return won
      },
    })
    const message = await this.store.deps.store.issues.getIssueMessage(messageId)
    if (!message) throw new IssueRefusal(`unknown mail message ${messageId}`)
    return { claimed, message }
  }

  /** Cheap pending check (for stop-hooks / polling). CONTEXT-AWARE [POD-909]
   *  (design §10): only messages NOT yet in the agent's context drive the
   *  "run mail inbox" nag. Substrate source of truth:
   *    - pending (stored … typed, unknown) — not confirmed yet → count it
   *    - `confirmed` — echoed as a turn or read from an inbox → EXCLUDE
   *    - failed / expired / cancelled — gone → EXCLUDE
   *  `countPending` counts pending rows only. The legacy
   *  issue_messages unread count is a transition fallback for pre-substrate
   *  rows only: a dual-written twin that is no longer pending must not resurrect
   *  the nag when the mirror lags. `senders` lets the stop-hook render the
   *  coalesced pointer ("N messages from X, Y"). */
  async mailPending(
    issueId: IssueId,
    opts?: { sessionId?: SessionId },
  ): Promise<{ unread: number; senders: string[] }> {
    const id = await this.store.resolveRef(issueId)
    await this.store.rowOrThrow(id)
    return await countContextAwarePendingMail(
      this.store.deps.store,
      id,
      async (fromIssue) => {
        const issue = await this.reports().get(fromIssue)
        return issue ? `issue:#${issue.seq}` : fromIssue
      },
      opts?.sessionId,
    )
  }

  /** The issue a mail message belongs to (router scope enforcement for mailClaim). */
  async mailMessage(messageId: string): Promise<IssueMessageRow | null> {
    return await this.store.deps.store.issues.getIssueMessage(messageId)
  }
}
