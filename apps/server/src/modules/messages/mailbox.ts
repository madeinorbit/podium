/**
 * The PULL path — extracted from `MessageDeliveryService` (POD-1397).
 *
 * The delivery service pushes a message toward a live PTY and waits for proof.
 * This module is the other half of the same rows' lives: replying to one,
 * reading a mailbox, dismissing a row, reminding a session that it still owes a
 * response, and the bounded waits a sender uses to learn what became of its
 * send. They are one capability because they share one confirmation rule — an
 * inbox READ is what confirms a row the push path could not, and every entry
 * point here either performs that read or reports on it.
 *
 * It owns NO mutable state, so it has no dispose contract; the two bounded
 * waits (`awaitAck`, `awaitDelivered`) are self-limiting polls with an
 * injectable clock and sleep, holding no timer between calls.
 *
 * THOSE TWO ARE DELIBERATELY OUTSIDE THE DISPOSAL CONTRACT, and the exception is
 * worth stating rather than leaving to be rediscovered. Each iteration sleeps on
 * a fresh `setTimeout` that nothing retains, so there is no handle for a
 * `dispose()` to clear and no timer that outlives the deadline. The consequence:
 * if the service is disposed while a caller is mid-await, the loop wakes ONCE
 * more and reads `getMessage()` from a store that may already be shut. That is
 * the same family as POD-1390 but not its severity — one poll, 250–500ms,
 * read-only, and the caller is still holding the promise it asked for. Giving
 * these an abort would mean deciding what a caller mid-`sendAndConfirm` should
 * observe at shutdown, which is a real question and not this issue's.
 * [POD-1385 review of POD-1397]
 *
 * It composes over the delivery service rather than reaching into it: the one
 * send path, the transition ledger and the sender label all arrive as ports.
 * This is the shape POD-320 established for `issues/service`.
 */

import type { SessionId, SessionMeta } from '@podium/model'
import type { MessageKind, MessageLifecycle, MessageRow, MessageUrgency } from '../../store'
import type { MessagesRepository } from '../../store/messages'
import type { NotificationArbiter } from '../../store/notification-facts'
import type { IssueService } from '../issues/service'
import type { MessageSender, MessageSendInput, MessageSendResult, SendDisposition } from './types'

/** Urgency-gated blocking send budgets [spec:SP-cb9f] [POD-854]. A `next-turn`
 *  send blocks up to this budget for the transcript-observed `delivered`; a busy /
 *  draft-held target that outlasts it returns `accepted` (still queued — the sender
 *  queries `podium mail status`). 25s tracks the harness queue-drain deadline: long
 *  enough to catch an idle or quickly-finishing target, short enough that the CLI
 *  never hangs on a long turn. */
export const NEXT_TURN_DELIVERY_BUDGET_MS = 25_000
/** An `interrupt` send blocks until `delivered`; this ceiling is only a hang-guard
 *  [spec:SP-cb9f] [POD-854]. An interrupt injects immediately (ESC + inject), so it
 *  normally confirms within seconds at the ESC-cancelled turn boundary — but a
 *  composer-draft hold [POD-865] or a dead PTY can legitimately keep the row queued,
 *  so at this ceiling it returns the honest `accepted` rather than block forever.
 *  Matches ECHO_CONFIRM_WINDOW_MS (the outer bound on any single confirmation).
 *  INVARIANT: must stay under @podium/protocol's AGENT_RELAY_BLOCKING_TIMEOUT_MS —
 *  the loopback relay hub gives `messages.send` that long before it times out, and
 *  a block that outlives the transport makes the agent CLI throw instead of getting
 *  this disposition (a drift-guard test enforces the gap). */
export const INTERRUPT_DELIVERY_CEILING_MS = 90_000

/**
 * Ports, narrowed from the real collaborators rather than restated.
 */
export interface MessageMailboxDeps {
  messages: Pick<
    MessagesRepository,
    | 'getMessage'
    | 'listDeliveredUnacked'
    | 'listLedger'
    | 'listMessagesFor'
    | 'listSettleNotifiable'
    | 'markRead'
    | 'markReminded'
    // The per-reader ledger the nag counts [POD-1379] — distinct from `markRead`,
    // which moves the SHARED delivery status for the message as a whole.
    | 'recordRead'
  >
  issues: Pick<IssueService, 'resolveRef' | 'has'>
  notificationArbiter: Pick<NotificationArbiter, 'retire'>
  listSessions(): SessionMeta[]
  now(): string
  /** Legacy mirror read-marking (store.issues.markIssueMessagesRead): a
   *  substrate inbox read must consume the mirror row's unread status too, or
   *  mailPending's legacy fallback keeps nagging. Drop with the table. */
  mirrorMarkIssueMailRead?(issueId: string, ids: string[]): void
  /** THE send path. A reply is an ordinary send with a server-computed
   *  recipient, so it goes through the same clamps, brakes and ledger. */
  send(from: MessageSender, input: MessageSendInput): MessageSendResult
  /** The transition ledger — a read is a status transition like any other. */
  emitTransition(message: MessageRow, kind: string, extra?: Record<string, unknown>): void
  /** The rendered sender label, for a reminder's render-ready row. */
  fromLabel(message: MessageRow): string
}

export class MessageMailbox {
  constructor(private readonly deps: MessageMailboxDeps) {}

  /** Where a reply to `original` goes: back to the sender principal. An agent
   *  sender is reached at its session when that session still exists, else at
   *  its issue; superagent/operator/system replies queue as operator rows (the
   *  superagent thread/UI inbox picks them up — stage 6). */
  replyTarget(original: MessageRow): { kind: 'issue' | 'session' | 'operator'; id?: string } {
    if (original.fromKind === 'agent') {
      if (
        original.fromSession &&
        this.deps.listSessions().some((s) => s.sessionId === original.fromSession)
      ) {
        return { kind: 'session', id: original.fromSession }
      }
      // Harden against legacy ref-string senders (#463): rows migrated by 016
      // held `issue:#N` in from_issue; anything that doesn't resolve to a real
      // issue must NOT reach the issue_messages mirror's FK — fall through.
      if (original.fromIssue) {
        const id = this.resolveIssueIdSafe(original.fromIssue)
        if (id) return { kind: 'issue', id }
      }
      if (original.fromSession) return { kind: 'session', id: original.fromSession }
    }
    return { kind: 'operator' }
  }

  /** Resolve an issue ref/id to a VERIFIED existing issue id, or null. Accepts
   *  a legacy `issue:#N` sender ref (#463) as well as `#N` / `iss_…`; an
   *  ambiguous or unknown ref returns null instead of throwing. */
  private resolveIssueIdSafe(ref: string): string | null {
    const issues = this.deps.issues
    const bare = ref.startsWith('issue:') ? ref.slice('issue:'.length) : ref
    try {
      const id = issues.resolveRef(bare)
      return issues.has(id) ? id : null
    } catch {
      return null
    }
  }

  /** Reply to a message: the recipient is computed server-side from the
   *  original's sender (never caller-supplied). Default kind 'ack' — writing it
   *  stamps acked_by on the original in the same transaction (see send).
   *
   *  A response is PULL-delivered [POD-835 §04b]: the default urgency is `fyi`, so
   *  the reply lands in the requester's mailbox and surfaces at its next natural
   *  stop — it is NEVER pushed as a next-turn that starts a fresh turn (an ack is
   *  never itself ackable, and every ack used to burn a recipient turn). */
  sendReply(
    from: MessageSender,
    input: {
      inReplyTo: string
      body: string
      kind?: MessageKind
      urgency?: MessageUrgency
      lifecycle?: MessageLifecycle
    },
  ): MessageSendResult {
    const original = this.deps.messages.getMessage(input.inReplyTo)
    if (!original) throw new Error(`unknown message ${input.inReplyTo}`)
    return this.deps.send(from, {
      to: this.replyTarget(original),
      body: input.body,
      kind: input.kind ?? 'ack',
      inReplyTo: original.id,
      threadId: original.threadId,
      urgency: input.urgency ?? 'fyi',
      lifecycle: input.lifecycle ?? 'wait',
    })
  }

  /** Delivered-but-unacked (unexpired) messages awaiting `sessionId`'s reply. */
  deliveredUnacked(sessionId: SessionId): MessageRow[] {
    return this.deps.messages.listDeliveredUnacked(sessionId, this.deps.now())
  }

  /** The messages that would produce a settle notice for `sessionId` right now
   *  (#468): asked-for-something + not-already-notified. The relay guard uses it
   *  to skip the git-log stitch work when nothing is notifiable. */
  settleNotifiable(sessionId: SessionId): MessageRow[] {
    return this.deps.messages.listSettleNotifiable(sessionId, this.deps.now())
  }

  /**
   * The stop-hook's single-reminder set: delivered-but-unfulfilled messages that
   * REQUESTED a response [POD-835 §04b] (expects_response — the store gates it;
   * urgency no longer decides, since a `--expect-response fyi` note still owes a
   * reply), never reminded about before. Marking happens here — each message earns
   * exactly ONE reminder, persisted, then the steward fallback owns it. Returns
   * render-ready rows for the daemon's block reason.
   */
  pendingReminders(sessionId: SessionId): { id: string; from: string; body: string }[] {
    const at = this.deps.now()
    const out: { id: string; from: string; body: string }[] = []
    for (const m of this.deps.messages.listDeliveredUnacked(sessionId, at)) {
      if (!this.deps.messages.markReminded(m.id, at)) continue
      out.push({ id: m.id, from: this.deps.fromLabel(m), body: m.body })
    }
    return out
  }

  /**
   * Deterministic settle fallback [spec:SP-bf44] [spec:SP-34d7 acks]: the target
   * session settled (finished/errored) leaving a REQUESTED response unfulfilled
   * (expects_response, not stamped by any in-thread reply). One system-kind
   * notification per such message, stitched with issue stage + last commit, routed
   * like a reply. Suppression is the acked_by null-check — a genuine reply from the
   * recipient that landed first empties the query; one racing after this produces
   * duplicate information, never lost information. This notice is itself a
   * `kind:'notification'` and can never stamp acked_by, so it never masks its own
   * target's unanswered state. System clamps (next-turn/wait) apply.
   */
  systemAckFallback(
    sessionId: SessionId,
    context: {
      outcome: string
      issueSeq?: number
      issueStage?: string
      lastCommit?: string
      /** #285 pass-through: the settled session's assigned workflow step, when
       *  one was stamped at spawn — the notice flags it as unresolved. */
      workflowStepId?: string
      /** Fact claimed by the steward for this notification emission. */
      notificationFact?: { factKey: string; target: string }
    },
  ): void {
    // #468 / [POD-835]: only messages that REQUESTED a response (expects_response)
    // and have not already produced a settle notice. The store gates it (an ordinary
    // message owes no reply) and the once-per-message rule (a prior notification is
    // the marker). One notice PER MESSAGE — not per sender-group — so every message
    // carries its own in_reply_to marker; a group notice referencing only the latest
    // would leave the others unmarked and re-fire them on the next settle (the loop
    // that sent one message 7 notices in 33 minutes).
    const rows = this.deps.messages.listSettleNotifiable(sessionId, this.deps.now())
    if (rows.length === 0) return
    const stitch = [
      context.issueSeq != null
        ? `issue #${context.issueSeq}${context.issueStage ? ` stage=${context.issueStage}` : ''}`
        : null,
      context.lastCommit ? `last commit: ${context.lastCommit}` : null,
      context.workflowStepId
        ? `workflow step ${context.workflowStepId} unresolved (no report from the worker)`
        : null,
    ].filter(Boolean)
    for (const m of rows) {
      this.deps.send(
        { kind: 'system', name: 'steward' },
        {
          to: this.replyTarget(m),
          kind: 'notification',
          inReplyTo: m.id,
          // System caps are next-turn/wait; ask for the cap so a settle notice
          // lands as the sender's immediate next turn (clamp matrix enforces).
          urgency: 'next-turn',
          lifecycle: 'wait',
          body:
            `Session ${sessionId} ${context.outcome} without responding to your message ${m.id} ` +
            `(you sent it --expect-response).` +
            (stitch.length ? ` ${stitch.join(' · ')}.` : '') +
            ` Use the read toolkit (podium session status/read) if you need more.`,
          ...(context.notificationFact ? { notificationFact: context.notificationFact } : {}),
        },
      )
    }
  }

  /** Message lookup for the read surfaces (gate/CLI). */
  message(id: string): MessageRow | null {
    return this.deps.messages.getMessage(id)
  }

  /** The per-issue / per-session delivery ledger (#237) [spec:SP-34d7 web] —
   *  a pure read (never consumes queued status). */
  ledger(q: { issueId?: string; sessionId?: string; limit?: number }): MessageRow[] {
    return this.deps.messages.listLedger(q)
  }

  /**
   * Bounded wait for a message's ack [spec:SP-34d7 read-toolkit tier 4]: poll
   * `acked_by` until the deadline; returns the ack row or null ("no answer
   * yet"). NEVER hangs — the same every-wait-bounded rule as agent await.
   * Shared by the seance (`podium session ask`) across gate + superagent.
   */
  async awaitAck(
    messageId: string,
    opts: { timeoutMs: number; pollMs?: number; sleep?(ms: number): Promise<void> },
  ): Promise<MessageRow | null> {
    const pollMs = opts.pollMs ?? 500
    const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)))
    const deadline = Date.now() + opts.timeoutMs
    for (;;) {
      const m = this.deps.messages.getMessage(messageId)
      if (m?.ackedBy) return this.deps.messages.getMessage(m.ackedBy)
      if (Date.now() >= deadline) return null
      await sleep(Math.min(pollMs, Math.max(1, deadline - Date.now())))
    }
  }

  /**
   * Bounded wait for a pushed message to be CONFIRMED [spec:SP-cb9f] [POD-854]:
   * poll the ledger until the row leaves `queued` — `delivered` (transcript echo
   * or turn boundary observed it), `read` (recipient pulled its inbox), or a
   * terminal `dead_letter`/`expired`/`cancelled` — or the deadline passes. Returns
   * the row in whatever state it reached (still `queued` on a budget expiry — the
   * sender is TOLD it is not yet confirmed, never left guessing), or null for an
   * unknown id. NEVER hangs — the every-wait-bounded rule shared with `awaitAck`.
   * This is the primitive urgency-gated blocking send builds on: `queued` means
   * only "handed to the harness input queue", and a harness-queued message can
   * still be Esc-cancelled or draft-held, so only a non-`queued` status is trusted.
   * `now`/`sleep` are injectable so tests drive a deterministic clock (no timers).
   */
  async awaitDelivered(
    messageId: string,
    opts: {
      timeoutMs: number
      pollMs?: number
      sleep?(ms: number): Promise<void>
      now?(): number
    },
  ): Promise<MessageRow | null> {
    const pollMs = opts.pollMs ?? 250
    const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)))
    const now = opts.now ?? (() => Date.now())
    const deadline = now() + opts.timeoutMs
    for (;;) {
      const m = this.deps.messages.getMessage(messageId)
      if (m && m.status !== 'queued') return m
      if (now() >= deadline) return m ?? null
      await sleep(Math.min(pollMs, Math.max(1, deadline - now())))
    }
  }

  /**
   * Urgency-gated blocking send [spec:SP-cb9f] [POD-854]: the agent/CLI send
   * surface (the gate) calls this instead of `send()` so the sender waits for the
   * trustworthy outcome instead of a bare `queued` that provably vanished. Internal
   * sends (steward auto-ack, self-suppress, dead-letter notice) keep calling `send`
   * and never block. Runs the synchronous `send()`, then blocks by the EFFECTIVE
   * (post-clamp) urgency of the resulting row. `opts` threads the caller's injectable
   * clock/sleep straight to `awaitDelivered` (production: real timers).
   */
  async sendAndConfirm(
    from: MessageSender,
    input: MessageSendInput,
    opts?: { pollMs?: number; sleep?(ms: number): Promise<void>; now?(): number },
  ): Promise<MessageSendResult> {
    const r = this.deps.send(from, input)
    return { ...r, disposition: await this.blockForDelivery(r, opts) }
  }

  /** Block by urgency until the send's outcome is trustworthy [spec:SP-cb9f]. Only a
   *  `queued` push to a live target has an imminent turn to observe — `delivered`
   *  (already confirmed-on-injection), `held` (no live session), `spawning` (a boot)
   *  and `dead_letter` (gone) have nothing to wait on and pass straight through.
   *  `fyi` confirms at queued (never blocks); an operator-addressed row is confirmed
   *  by a HUMAN inbox read, not a turn boundary, so blocking would always time out —
   *  it returns immediately too. `interrupt` blocks up to the hang-guard ceiling,
   *  `next-turn` up to the shorter budget; either, on expiry with the row still
   *  queued (busy / composer-draft-held / lost echo), returns `accepted` — durably
   *  captured, not yet confirmed — never a bare `queued` and never an infinite block. */
  private async blockForDelivery(
    r: MessageSendResult,
    opts?: { pollMs?: number; sleep?(ms: number): Promise<void>; now?(): number },
  ): Promise<SendDisposition> {
    if (r.disposition !== 'queued') return r.disposition
    // A push that FAILED at the transport (ok:false — the daemon dropped offline
    // mid-send) put no bytes on screen, so no echo / turn boundary can confirm it
    // within the budget; the row is durably queued and the sweep retries it. Return
    // the honest `accepted` now instead of blocking the whole budget for a
    // confirmation that provably cannot arrive.
    if (!r.ok) return 'accepted'
    const { urgency, toKind } = r.message
    if (urgency === 'fyi' || toKind === 'operator') return r.disposition
    const timeoutMs =
      urgency === 'interrupt' ? INTERRUPT_DELIVERY_CEILING_MS : NEXT_TURN_DELIVERY_BUDGET_MS
    const row = await this.awaitDelivered(r.message.id, {
      timeoutMs,
      ...(opts?.pollMs !== undefined ? { pollMs: opts.pollMs } : {}),
      ...(opts?.sleep ? { sleep: opts.sleep } : {}),
      ...(opts?.now ? { now: opts.now } : {}),
    })
    if (row?.status === 'delivered' || row?.status === 'read') return 'delivered'
    // `accepted` is the honest "durably queued, not yet confirmed — query mail
    // status" ONLY while the row is still queued at the budget expiry. Any other
    // outcome is terminal-undelivered — dead-lettered, expired past its TTL, or
    // cancelled — and reporting the pending `accepted` for it would lie [POD-854].
    if (row?.status === 'queued') return 'accepted'
    return 'dead_letter'
  }

  /** Inbox listing for a set of recipient principals, oldest first. */
  inbox(
    principals: { kind: 'issue' | 'session' | 'operator'; id?: string | null }[],
    opts?: { limit?: number },
  ): MessageRow[] {
    const rows = principals.flatMap((p) =>
      this.deps.messages.listMessagesFor(p, { limit: opts?.limit ?? 50 }),
    )
    rows.sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id))
    return rows.slice(-(opts?.limit ?? 50))
  }

  /**
   * Inbox read for `podium mail inbox`. When `consume` is set (the RECIPIENT is
   * reading its own box) the returned rows are marked `read` — the PULL-path
   * confirmation, distinct from a pushed `delivered` [POD-834 §04d] — with the
   * legacy issue_messages mirror kept in step so the stop-hook/prime pending
   * counts stop nagging on either surface. A row already pushed (delivered) is
   * still promoted to read when the recipient opens it.
   */
  readInbox(
    principals: { kind: 'issue' | 'session' | 'operator'; id?: string | null }[],
    opts?: { consume?: SessionId | null; limit?: number },
  ): MessageRow[] {
    const rows = this.inbox(principals, opts?.limit !== undefined ? { limit: opts.limit } : {})
    if (opts?.consume === undefined) return rows
    const at = this.deps.now()
    return rows.map((m) => {
      // Per-READER receipt first [POD-1379]: this session has now been shown the
      // row whatever a peer on the same issue mailbox already did to the shared
      // delivery ledger — otherwise a message a peer consumed keeps nagging.
      if (opts.consume) this.deps.messages.recordRead(m.id, opts.consume, at)
      if ((m.status !== 'queued' && m.status !== 'delivered') || m.toKind === 'operator') return m
      if (!this.deps.messages.markRead(m.id, opts.consume ?? null, at)) return m
      this.retireNotificationFact(m, at)
      if (m.toKind === 'issue' && m.toId) {
        try {
          this.deps.mirrorMarkIssueMailRead?.(m.toId, [m.id])
        } catch {}
      }
      const read = {
        ...m,
        status: 'read' as const,
        readAt: at,
        deliveredTo: m.deliveredTo ?? opts.consume ?? null,
      }
      this.deps.emitTransition(read, 'message.read')
      return read
    })
  }

  /** Explicitly clear one recipient-owned message without opening the inbox.
   * Reuses `read`, the existing cleared terminal state [spec:SP-ba61]. */
  dismiss(messageId: string, consume: string | null): MessageRow {
    const message = this.deps.messages.getMessage(messageId)
    if (!message) throw new Error('unknown message ' + messageId)
    const at = this.deps.now()
    // Clearing it is seeing it, for this reader [POD-1379].
    if (consume) this.deps.messages.recordRead(message.id, consume, at)
    if (message.status === 'queued' || message.status === 'delivered') {
      this.deps.messages.markRead(message.id, consume, at)
      if (message.toKind === 'issue' && message.toId) {
        try {
          this.deps.mirrorMarkIssueMailRead?.(message.toId, [message.id])
        } catch {}
      }
    }
    const dismissed = this.deps.messages.getMessage(messageId) ?? message
    if (dismissed.status === 'read' && message.status !== 'read') {
      this.deps.emitTransition(dismissed, 'message.read')
    }
    this.retireNotificationFact(message, at)
    return dismissed
  }

  private retireNotificationFact(message: MessageRow, at: string): void {
    if (!message.factKey || !message.factTarget) return
    this.deps.notificationArbiter.retire(message.factKey, message.factTarget, at)
  }
}
