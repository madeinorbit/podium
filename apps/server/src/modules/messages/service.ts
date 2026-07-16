/**
 * Unified agent messaging (#237) [spec:SP-34d7] — MessageDeliveryService, the
 * ONE send path every surface (issue mail, session send, superagent
 * send_to_agent, chat UI) goes through:
 *
 *  - the sender is stamped SERVER-SIDE from the authenticated caller
 *    (mailIdentity pattern) — callers never pass sender fields;
 *  - the row is durable before any delivery attempt; every status transition
 *    emits a podium_events row (steward visibility, human audit);
 *  - delivery resolves the recipient AT DELIVERY TIME (TOCTOU-safe) and acts
 *    on the session's state now, per the urgency × lifecycle table:
 *        running   fyi → surface at next pause (stop-hook/prime pending)
 *                  next-turn → queueText (immediate next turn, FIFO)
 *                  interrupt → ESC + inject (sessions.interruptText)
 *        idle      inject now (sendText)
 *        parked    wait → stay queued (drain-on-idle / stop-hook / sweep)
 *                  wake → durable queue + resurrect; unresumable → spawn seam
 *  - the clamp matrix downgrades (never rejects) requests above the sender's
 *    cap; downgrades are recorded on the row (clamped_from) + event-ledgered;
 *  - containment brakes: wake cooldown 1/10min per (sender, target-issue),
 *    spawn budget 3/day per issue, hop counter clamping chains past depth 5;
 *  - the envelope is server-rendered at delivery — only the server writes
 *    frames, so a fake envelope inside a body stays visibly quoted INSIDE the
 *    real frame. Operator-principal messages are never enveloped (unwrapped =
 *    operator is an invariant).
 */

import { randomUUID } from 'node:crypto'
import type { SessionMeta } from '@podium/protocol'
import { selectMailNudgeSession, sessionsForIssue } from '../../issue-util'
import type {
  IssueMessageRow,
  MessageKind,
  MessageLifecycle,
  MessageRow,
  MessageUrgency,
} from '../../store'
import type { EventsRepository } from '../../store/events'
import type { MessagesRepository } from '../../store/messages'
import type { IssueService } from '../issues/service'

/** Chain depth past which lifecycle clamps to wait (brake 3). */
export const HOP_LIMIT = 5
/** One wake per (sender, target-issue) per this window (brake 1). */
export const WAKE_COOLDOWN_MS = 10 * 60_000
/** Message-triggered spawns per issue per UTC day (brake 2). */
export const SPAWN_BUDGET_PER_DAY = 10
/** Bodies past this render as a pointer, not inline (issue-addressed only —
 *  they are readable via `podium issue mail inbox`). */
export const INLINE_BODY_MAX = 6_000

/** The authenticated sender principal — derived by the SURFACE from its caller
 *  identity (capability / in-process authority), never from client input. */
export type MessageSender =
  | { kind: 'operator' }
  | { kind: 'superagent' }
  | { kind: 'system'; name?: string }
  | { kind: 'agent'; issueId?: string; sessionId?: string }

export interface MessageSendInput {
  to: { kind: 'issue' | 'session' | 'operator'; id?: string }
  body: string
  kind?: MessageKind
  urgency?: MessageUrgency
  lifecycle?: MessageLifecycle
  threadId?: string
  inReplyTo?: string
  expiresAt?: string
}

export interface MessageSendResult {
  message: MessageRow
  /** sendText/queueText-compatible outcome (existing CLI/tool wire shapes). */
  ok: boolean
  queued?: boolean
  reason?: string
  /** The legacy issue_messages mirror row (issue-addressed sends only) — keeps
   *  mail inbox/claim/pending working until those readers migrate. */
  legacy?: IssueMessageRow
}

/** Spawn-on-unresumable-wake seam [spec:SP-34d7 decision 4]. Actual agent
 *  spawning is wired in a later stage (TODO: wire to SessionsService.spawn with
 *  the message as the first prompt after prime); the default (absent) marks the
 *  ledger and surfaces needs-attention instead. */
export interface SpawnOnWake {
  spawn(input: { issueId: string | null; message: MessageRow }): {
    ok: boolean
    sessionId?: string
    reason?: string
  }
}

export interface MessageDeliveryDeps {
  messages: MessagesRepository
  events: EventsRepository
  issues(): IssueService
  sessions(): {
    listSessions(): SessionMeta[]
    sendText(input: { sessionId: string; text: string }): {
      ok: boolean
      queued?: boolean
      reason?: string
    }
    queueText(input: { sessionId: string; text: string }): {
      ok: boolean
      queued?: boolean
      reason?: string
    }
    /** ESC + queue-as-next-turn (#237 hard interrupt). */
    interruptText(input: { sessionId: string; text: string }): {
      ok: boolean
      queued?: boolean
      reason?: string
    }
  }
  /** Legacy mailbox mirror (store.issues.addIssueMessage) — issue-addressed
   *  sends dual-write so inbox/claim/pending keep working (drop with the table). */
  mirrorIssueMail?(row: IssueMessageRow): void
  /** Legacy mirror read-marking (store.issues.markIssueMessagesRead): a
   *  substrate inbox read must consume the mirror row's unread status too, or
   *  mailPending's legacy fallback keeps nagging. Drop with the table. */
  mirrorMarkIssueMailRead?(issueId: string, ids: string[]): void
  /** Spawn-on-wake seam; absent = unresumable wakes surface needs-attention. */
  spawnOnWake?: SpawnOnWake
  /** Transaction seam (store.transact): an ack's row insert + acked_by stamp on
   *  the original commit atomically. Absent (tests) = plain sequential writes. */
  transact?<T>(fn: () => T): T
  /** Existing notify path for needs-attention surfacing (best-effort). */
  notifyOperator?(input: { messageId: string; reason: string; body: string }): void
  /** Human-readable machine name for cross-machine provenance [POD-658];
   *  absent (tests) = raw machine id. */
  machineName?(id: string): string
  now(): string
}

/**
 * SUBSTRATE-boundary body sanitizer: message bodies are typed into the target
 * agent's PTY inside a bracketed paste (ESC[200~ … ESC[201~), so a body
 * containing the paste-END marker would terminate the paste early and
 * everything after it would run as raw keystrokes — command injection into
 * another agent session. Strip every C0/C1 control character except newline
 * and tab (killing ESC neutralizes ESC[201~ and all other escape sequences).
 * Applied at rendering/delivery ONLY — typeText itself stays byte-faithful for
 * operator/UI direct typing.
 */
export function sanitizeBody(body: string): string {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: stripping control chars is the point
  return body.replace(/[\u0000-\u0008\u000b-\u001f\u007f\u0080-\u009f]/g, '')
}

/** Render the delivery envelope. Server-only: bodies never carry frames of
 *  their own — a spoofed "[podium message …]" inside `body` lands INSIDE the
 *  real frame and reads as quoted text. */
export function renderEnvelope(
  m: MessageRow,
  fromLabel: string,
  toLabel: string,
  note?: string,
): string {
  // The seance constraint [spec:SP-34d7 read-toolkit tier 4]: a question's
  // frame binds the receiver — answer from existing context, reply, then
  // RESUME. Server-rendered like the rest of the frame, never client text.
  const questionRule =
    m.kind === 'question'
      ? `[this is a question: answer it from your existing context with \`podium mail reply ${m.id}\`, ` +
        `then RETURN TO WHAT YOU WERE DOING — do not take up new work because of it]\n`
      : ''
  return (
    `[podium message ${m.id} · from ${fromLabel} · to ${toLabel} · reply: podium mail reply ${m.id}]\n` +
    `${m.body}\n` +
    (note ? `${note}\n` : '') +
    questionRule +
    `[end podium message ${m.id}]`
  )
}

/** Derive the sender principal from an authz capability (the relay/registry
 *  caller identity). ONLY the unconstrained scope ('all') is the operator —
 *  "unwrapped = the human" is an invariant the receiver's prime rules trust,
 *  so an issueless agent session (scope 'none' + actorSessionId) must stamp
 *  as an agent (enveloped, peer-clamped, cooldown-subject), never operator.
 *  Server-side only — the mailIdentity() pattern, structured. */
export function senderFromCapability(capability: {
  scope: { kind: string; rootId?: string }
  actorSessionId?: string
}): MessageSender {
  if (capability.scope.kind === 'all') return { kind: 'operator' }
  if (capability.scope.kind === 'subtree' && capability.scope.rootId) {
    return {
      kind: 'agent',
      issueId: capability.scope.rootId,
      ...(capability.actorSessionId ? { sessionId: capability.actorSessionId } : {}),
    }
  }
  return {
    kind: 'agent',
    ...(capability.actorSessionId ? { sessionId: capability.actorSessionId } : {}),
  }
}

/** How the target session presents at delivery time. */
type TargetState = 'idle' | 'running' | 'parked'

type ClampNote = { urgency?: MessageUrgency; lifecycle?: MessageLifecycle; reason: string }

const URGENCY_ORDER: MessageUrgency[] = ['fyi', 'next-turn', 'interrupt']

function capUrgency(requested: MessageUrgency, max: MessageUrgency): MessageUrgency {
  return URGENCY_ORDER.indexOf(requested) > URGENCY_ORDER.indexOf(max) ? max : requested
}

export class MessageDeliveryService {
  /** hop of the message that triggered the CURRENT turn per session — set at
   *  delivery, cleared when the session goes idle (turn ended). Messages the
   *  session sends within that turn carry hop + 1 (brake 3). */
  private readonly turnHop = new Map<string, number>()
  /** last wake timestamp (ms) per `${senderKey}|${issueKey}` (brake 1) — a
   *  write-through cache over the durable rows: a cold key falls back to the
   *  delivered wake rows in `messages`, so a server restart (this repo
   *  redeploys on every main commit) never resets the cooldown. */
  private readonly lastWakeAt = new Map<string, number>()
  /** message-triggered spawns per issue for the current UTC day (brake 2) — a
   *  cache over the `message.spawned` event ledger (restart-proof). */
  private readonly spawnCount = new Map<string, { day: string; count: number }>()
  /** needs-attention already emitted per `${messageId}|${reason}` — the sweep
   *  re-attempts every 60s and must not spam the event log / notify path. */
  private readonly attentionEmitted = new Set<string>()

  constructor(private readonly deps: MessageDeliveryDeps) {}

  /**
   * Persist + attempt delivery of one message. `from` is the surface's
   * server-derived principal; `input` is the (validated) client payload —
   * any sender-shaped fields a client smuggles in are simply not read.
   * Clamps/brakes downgrade the axes BEFORE the row is written, so the row
   * always holds the effective values and `clamped_from` the requested ones.
   */
  send(from: MessageSender, input: MessageSendInput): MessageSendResult {
    const issues = this.deps.issues()
    // Resolve an issue recipient ref (#N / seq / id) to the canonical id up
    // front so the stored to_id is stable.
    const toId =
      input.to.kind === 'issue'
        ? issues.resolveRef(input.to.id ?? '')
        : input.to.kind === 'session'
          ? (input.to.id ?? null)
          : null
    if (input.to.kind === 'session' && !toId) throw new Error('session recipient needs an id')

    const targetSession =
      input.to.kind === 'session'
        ? this.deps
            .sessions()
            .listSessions()
            .find((s) => s.sessionId === toId)
        : undefined

    // v1 defaults: mail stays fyi+wait; session sends declare next-turn.
    const requested = {
      urgency: input.urgency ?? 'fyi',
      lifecycle: input.lifecycle ?? 'wait',
    }
    const clamps: ClampNote[] = []
    let { urgency, lifecycle } = requested

    // Clamp matrix [spec:SP-34d7]: downgrade-never-reject. --outside-scope
    // only ever confirms scope-crossing at the authz layer — it never reaches
    // here, so it can never elevate past these caps.
    const caps = this.capsFor(from, targetSession)
    if (capUrgency(urgency, caps.maxUrgency) !== urgency) {
      clamps.push({ urgency, reason: `sender cap (${this.relationship(from, targetSession)})` })
      urgency = caps.maxUrgency
    }
    if (lifecycle === 'wake' && caps.maxLifecycle === 'wait') {
      clamps.push({ lifecycle, reason: `sender cap (${this.relationship(from, targetSession)})` })
      lifecycle = 'wait'
    }

    // Brake 3 — chain depth: a message sent from a message-triggered turn
    // inherits hop + 1; past the limit lifecycle clamps to wait and the thread
    // surfaces to the human (ping-pong loops die out, nothing is dropped).
    let hop = 0
    if (from.kind === 'agent' && from.sessionId !== undefined) {
      const triggerHop = this.turnHop.get(from.sessionId)
      if (triggerHop !== undefined) hop = triggerHop + 1
    }
    let hopClamped = false
    if (hop > HOP_LIMIT && lifecycle === 'wake') {
      clamps.push({ lifecycle, reason: `hop limit (depth ${hop} > ${HOP_LIMIT})` })
      lifecycle = 'wait'
      hopClamped = true
    }

    // Brake 1 — wake cooldown per (sender, target issue). Operator intent is
    // never braked. Checked at send; the sweep also honours it on retries.
    if (lifecycle === 'wake' && from.kind !== 'operator') {
      const issueKey =
        input.to.kind === 'issue' ? (toId ?? '') : this.issueForSession(targetSession)
      const key = `${this.senderKey(from)}|${issueKey ?? toId ?? ''}`
      if (this.wakeCooldownHot(key)) {
        clamps.push({ lifecycle, reason: 'wake cooldown (1 per 10min per sender+issue)' })
        lifecycle = 'wait'
      }
    }

    // Acks [spec:SP-34d7 acks]: kind 'ack' requires in_reply_to; the write
    // below also stamps acked_by on the original in the same transaction.
    // Replies (any kind) inherit the original's thread.
    const original = input.inReplyTo ? this.deps.messages.getMessage(input.inReplyTo) : null
    if (input.kind === 'ack') {
      if (!input.inReplyTo) throw new Error('an ack needs in_reply_to')
      if (!original) throw new Error(`unknown message ${input.inReplyTo}`)
    }

    const id = `msg_${randomUUID()}`
    const message: MessageRow = {
      id,
      threadId: input.threadId ?? original?.threadId ?? id,
      inReplyTo: input.inReplyTo ?? null,
      fromKind: from.kind,
      fromSession: from.kind === 'agent' ? (from.sessionId ?? null) : null,
      fromName: from.kind === 'system' ? (from.name ?? null) : null,
      fromIssue: from.kind === 'agent' ? (from.issueId ?? null) : null,
      toKind: input.to.kind,
      toId,
      kind: input.kind ?? 'message',
      urgency,
      lifecycle,
      body: input.body,
      expiresAt: input.expiresAt ?? null,
      createdAt: this.deps.now(),
      status: 'queued',
      deliveredAt: null,
      deliveredTo: null,
      ackedBy: null,
      hop,
      clampedFrom: clamps.length
        ? JSON.stringify({
            urgency: requested.urgency,
            lifecycle: requested.lifecycle,
            reasons: clamps.map((c) => c.reason),
          })
        : null,
      remindedAt: null,
    }
    // The ack row and the acked_by stamp on the original commit atomically —
    // the steward's suppression check can never observe one without the other.
    const write = (): void => {
      this.deps.messages.addMessage(message)
      if (message.kind === 'ack' && message.inReplyTo) {
        this.deps.messages.markAcked(message.inReplyTo, id)
      }
    }
    if (this.deps.transact) this.deps.transact(write)
    else write()
    if (message.kind === 'ack' && original) {
      this.emitTransition({ ...original, ackedBy: id }, 'message.acked')
    }
    this.emitTransition(message, 'message.queued')
    if (message.clampedFrom) {
      this.emitTransition(message, 'message.clamped')
    }
    if (hopClamped) {
      this.needsAttention(
        message,
        `message chain exceeded depth ${HOP_LIMIT}; wake degraded to wait`,
      )
    }

    // Legacy mailbox mirror (same id, so `podium issue mail claim <id>` works
    // on either surface).
    // Belt-and-braces (#463): only mirror when toId is a REAL issue id — an
    // unresolved ref must surface as an undeliverable message, never as a raw
    // SQLite FOREIGN KEY error out of the mirror insert.
    let legacy: IssueMessageRow | undefined
    if (message.toKind === 'issue' && toId && issues.get(toId)) {
      legacy = {
        id,
        issueId: toId,
        fromAuthor: this.legacyAuthor(from),
        body: input.body,
        createdAt: message.createdAt,
        status: 'unread',
        claimedBy: null,
        readAt: null,
        claimedAt: null,
      }
      this.deps.mirrorIssueMail?.(legacy)
    }

    const outcome = this.attemptDelivery(message)
    return { message: this.deps.messages.getMessage(id) ?? message, ...outcome, legacy }
  }

  // ---- delivery resolution (state × axis table) ----

  /**
   * Resolve the recipient to a concrete session NOW (TOCTOU-safe — nothing was
   * decided at send time) and act per the delivery table. Undeliverable
   * messages stay `queued`; retriggers: session-goes-idle drain (onSessionIdle),
   * the daemon stop-hook (mailPending), and the slow sweep().
   */
  private attemptDelivery(message: MessageRow): {
    ok: boolean
    queued?: boolean
    reason?: string
  } {
    if (message.toKind === 'operator') {
      // Stays queued, kind-tagged for UI pickup (ledger view, stage 6).
      return { ok: true, queued: true }
    }
    const sessions = this.deps.sessions()
    const all = sessions.listSessions()

    let target: SessionMeta | undefined
    if (message.toKind === 'session') {
      target = all.find((s) => s.sessionId === message.toId)
      if (!target) return { ok: false, reason: 'unknown session' }
    } else {
      const issue = this.deps.issues().get(message.toId ?? '')
      if (!issue) return { ok: false, reason: 'unknown issue' }
      const members = sessionsForIssue(issue.worktreePath ?? null, all, issue.id)
      const live = selectMailNudgeSession(members)
      target = live
        ? members.find((s) => s.sessionId === live.sessionId)
        : // No live member: a wake picks the most recent parked agent to resurrect.
          [...members]
            .filter((s) => s.agentKind !== 'shell')
            .sort((a, b) => (b.lastActiveAt ?? '').localeCompare(a.lastActiveAt ?? ''))
            .at(0)
      if (!target) {
        if (message.lifecycle === 'wake') return this.trySpawn(message, message.toId)
        return { ok: true, queued: true }
      }
    }

    const state = this.stateOf(target)
    if (state === 'idle') {
      // idle/live: inject now, every urgency.
      const r = sessions.sendText({ sessionId: target.sessionId, text: this.renderFor(message, target.sessionId) })
      if (r.ok) this.markDelivered(message, target.sessionId)
      return r
    }
    if (state === 'running') {
      if (message.urgency === 'fyi') {
        // Surfaces at the next pause: stop-hook / prime pending query.
        return { ok: true, queued: true }
      }
      if (message.urgency === 'interrupt') {
        // The intended mid-turn path. interruptText sends ESC first, which
        // visibly cancels an open AskUserQuestion menu before the text lands.
        const r = sessions.interruptText({
          sessionId: target.sessionId,
          text: this.renderFor(message, target.sessionId),
        })
        if (r.ok) this.markDelivered(message, target.sessionId)
        return r
      }
      // next-turn. A 'starting' session has no turn in flight and nothing on
      // screen — ride the durable boot queue; it types once the agent binds.
      if (target.status === 'starting') {
        const r = sessions.queueText({
          sessionId: target.sessionId,
          text: this.renderFor(message, target.sessionId),
        })
        if (r.ok) this.markDelivered(message, target.sessionId)
        return r
      }
      // Busy live agent: HOLD for the turn boundary. queueText's immediate
      // drain types mid-turn (#471), and its submitting CR auto-answers an
      // on-screen AskUserQuestion menu (#473 P0). onSessionIdle delivers when
      // the phase reaches idle; sweep() is the backstop.
      return { ok: true, queued: true }
    }
    // parked (hibernated/exited)
    if (message.lifecycle === 'wait') {
      return { ok: true, queued: true }
    }
    // wake: durable queue + resurrect (queueText resurrects parked sessions);
    // record the wake against the cooldown window.
    this.recordWake(message, target)
    const r = sessions.queueText({ sessionId: target.sessionId, text: this.renderFor(message, target.sessionId) })
    if (r.ok) {
      this.markDelivered(message, target.sessionId)
      return r
    }
    if (r.reason === 'no resume ref') {
      return this.trySpawn(message, this.issueForSession(target) ?? message.toId)
    }
    return r
  }

  /** Brake 2 + the spawn seam: unresumable wake → spawn a fresh agent on the
   *  target issue (deferred wiring) within the per-issue daily budget; no seam
   *  or budget exhausted → ledger + needs-attention, row stays queued. */
  private trySpawn(
    message: MessageRow,
    issueId: string | null,
  ): { ok: boolean; queued?: boolean; reason?: string } {
    const key = issueId ?? 'no-issue'
    const day = this.deps.now().slice(0, 10)
    const count = this.spawnCountFor(key, day)
    if (count >= SPAWN_BUDGET_PER_DAY) {
      this.emitTransition(message, 'message.spawn_budget_exhausted')
      this.needsAttention(
        message,
        `spawn budget exhausted for issue ${key} (${SPAWN_BUDGET_PER_DAY}/day); message stays queued`,
      )
      return { ok: true, queued: true, reason: 'spawn budget exhausted' }
    }
    if (!this.deps.spawnOnWake) {
      // TODO(#237 stage 4/5): wire spawnOnWake to SessionsService.spawn — the
      // message becomes the first prompt after prime.
      this.needsAttention(message, 'wake target is unresumable and spawn-on-wake is not wired')
      return { ok: true, queued: true, reason: 'unresumable' }
    }
    this.spawnCount.set(key, { day, count: count + 1 })
    // A spawn attempt IS a wake — record it against the cooldown so the sweep
    // does not re-run the spawn seam every 60s.
    if (message.fromKind !== 'operator') {
      this.lastWakeAt.set(`${this.senderKeyOfRow(message)}|${issueId ?? ''}`, this.nowMs())
    }
    const r = this.deps.spawnOnWake.spawn({ issueId, message })
    if (r.ok && r.sessionId) {
      // spawnIssue rides the event so the budget survives restarts (see
      // spawnCountFor) — it can differ from toId for session-addressed wakes.
      this.emitTransition(message, 'message.spawned', { spawnIssue: key })
      const q = this.deps
        .sessions()
        .queueText({ sessionId: r.sessionId, text: this.renderFor(message, r.sessionId) })
      if (q.ok) this.markDelivered(message, r.sessionId)
      return q
    }
    this.needsAttention(message, `spawn-on-wake failed: ${r.reason ?? 'unknown'}`)
    return { ok: true, queued: true, reason: r.reason ?? 'spawn failed' }
  }

  // ---- retriggers ----

  /**
   * Drain trigger: a session's turn ended (phase → idle). Clears the hop
   * context for the finished turn, then delivers what queued up while it was
   * busy/parked — its session-addressed rows plus its issue's rows, FIFO, with
   * fyi batches coalesced into one inbox pointer.
   */
  onSessionIdle(session: SessionMeta): void {
    this.turnHop.delete(session.sessionId)
    const pending = [...this.deps.messages.pendingFor({ kind: 'session', id: session.sessionId })]
    const issueId = this.issueForSession(session)
    if (issueId) pending.push(...this.deps.messages.pendingFor({ kind: 'issue', id: issueId }))
    if (pending.length === 0) return
    pending.sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id))
    this.deliverBatch(session, pending)
  }

  /** Slow sweep: expire what has expired, then re-attempt every queued row
   *  (delivery is state-resolved, so this is idempotent and cheap). */
  sweep(): void {
    for (const expired of this.deps.messages.expireQueued(this.deps.now())) {
      this.emitTransition(expired, 'message.expired')
    }
    for (const m of this.deps.messages.listQueued()) {
      if (m.toKind === 'operator') continue
      // Cooldown-degraded wakes retry as wakes next window; skip while hot.
      // The key MUST match recordWake's (session targets resolve to their
      // issue) or session-addressed wakes re-attempt every sweep, burning the
      // spawn budget within minutes.
      if (m.lifecycle === 'wake' && m.fromKind !== 'operator') {
        if (this.wakeCooldownHot(this.wakeKeyOfRow(m))) continue
      }
      this.attemptDelivery(m)
    }
  }

  /** Deliver a pending batch into an idle session. Inline rows go FIFO; fyi
   *  issue-addressed rows past one coalesce into a single pointer
   *  ("N messages from X, Y — run 'podium issue mail inbox'"). */
  private deliverBatch(session: SessionMeta, rows: MessageRow[]): void {
    const sessions = this.deps.sessions()
    const pointerRows = rows.filter(
      (m) => m.toKind === 'issue' && (m.urgency === 'fyi' || m.body.length > INLINE_BODY_MAX),
    )
    const inlineRows = rows.filter((m) => !pointerRows.includes(m))
    for (const m of inlineRows) {
      const r = sessions.sendText({ sessionId: session.sessionId, text: this.renderFor(m, session.sessionId) })
      if (r.ok) this.markDelivered(m, session.sessionId)
    }
    if (pointerRows.length === 1 && pointerRows[0]!.body.length <= INLINE_BODY_MAX) {
      const m = pointerRows[0]!
      const r = sessions.sendText({ sessionId: session.sessionId, text: this.renderFor(m, session.sessionId) })
      if (r.ok) this.markDelivered(m, session.sessionId)
    } else if (pointerRows.length > 0) {
      const r = sessions.sendText({
        sessionId: session.sessionId,
        text: this.pointerText(pointerRows),
      })
      if (r.ok) for (const m of pointerRows) this.markDelivered(m, session.sessionId)
    }
  }

  /** The coalesced pointer rendering (also used for oversized bodies). */
  pointerText(rows: MessageRow[]): string {
    const senders = [...new Set(rows.map((m) => this.fromLabel(m)))]
    return (
      `[podium] ${rows.length} message(s) from ${senders.join(', ')} — ` +
      `run 'podium issue mail inbox' to read them`
    )
  }

  // ---- acks & reads (#237 phase 3) [spec:SP-34d7 acks] ----

  /** Where a reply to `original` goes: back to the sender principal. An agent
   *  sender is reached at its session when that session still exists, else at
   *  its issue; superagent/operator/system replies queue as operator rows (the
   *  superagent thread/UI inbox picks them up — stage 6). */
  replyTarget(original: MessageRow): { kind: 'issue' | 'session' | 'operator'; id?: string } {
    if (original.fromKind === 'agent') {
      if (
        original.fromSession &&
        this.deps
          .sessions()
          .listSessions()
          .some((s) => s.sessionId === original.fromSession)
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
    const issues = this.deps.issues()
    const bare = ref.startsWith('issue:') ? ref.slice('issue:'.length) : ref
    try {
      const id = issues.resolveRef(bare)
      return issues.get(id) ? id : null
    } catch {
      return null
    }
  }

  /** Reply to a message: the recipient is computed server-side from the
   *  original's sender (never caller-supplied). Default kind 'ack' — writing it
   *  stamps acked_by on the original in the same transaction (see send). */
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
    return this.send(from, {
      to: this.replyTarget(original),
      body: input.body,
      kind: input.kind ?? 'ack',
      inReplyTo: original.id,
      threadId: original.threadId,
      urgency: input.urgency ?? 'next-turn',
      lifecycle: input.lifecycle ?? 'wait',
    })
  }

  /** Delivered-but-unacked (unexpired) messages awaiting `sessionId`'s reply. */
  deliveredUnacked(sessionId: string): MessageRow[] {
    return this.deps.messages.listDeliveredUnacked(sessionId, this.deps.now())
  }

  /** The messages that would produce a settle notice for `sessionId` right now
   *  (#468): asked-for-something + not-already-notified. The relay guard uses it
   *  to skip the git-log stitch work when nothing is notifiable. */
  settleNotifiable(sessionId: string): MessageRow[] {
    return this.deps.messages.listSettleNotifiable(sessionId, this.deps.now())
  }

  /**
   * The stop-hook's single-reminder set: delivered-but-unacked NON-fyi messages
   * this session has never been reminded about. Marking happens here — each
   * message earns exactly ONE reminder, persisted, then the steward fallback
   * owns it. Returns render-ready rows for the daemon's block reason.
   */
  pendingReminders(sessionId: string): { id: string; from: string; body: string }[] {
    const at = this.deps.now()
    const out: { id: string; from: string; body: string }[] = []
    for (const m of this.deps.messages.listDeliveredUnacked(sessionId, at)) {
      if (m.urgency === 'fyi') continue
      if (!this.deps.messages.markReminded(m.id, at)) continue
      out.push({ id: m.id, from: this.fromLabel(m), body: m.body })
    }
    return out
  }

  /**
   * Deterministic ack fallback [spec:SP-34d7 acks]: the target session settled
   * (finished/errored) with delivered-but-unacked messages. One system-kind
   * notification per sender, stitched with issue stage + last commit, routed
   * like a reply. Suppression is the acked_by null-check — an agent ack that
   * landed first empties the query; an ack racing after this produces duplicate
   * information, never lost information. System clamps (next-turn/wait) apply.
   */
  systemAckFallback(
    sessionId: string,
    context: {
      outcome: string
      issueSeq?: number
      issueStage?: string
      lastCommit?: string
      /** #285 pass-through: the settled session's assigned workflow step, when
       *  one was stamped at spawn — the notice flags it as unresolved. */
      workflowStepId?: string
    },
  ): void {
    // #468: only messages that actually asked for something and have not already
    // produced a settle notice. The store guards fyi (courtesy notes never demand
    // an ack) and the once-per-message rule (a prior notification is the marker).
    // One notice PER MESSAGE — not per sender-group — so every message carries its
    // own in_reply_to marker; a group notice referencing only the latest would
    // leave the others unmarked and re-fire them on the next settle (the loop that
    // sent one message 7 notices in 33 minutes).
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
      this.send(
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
            `Session ${sessionId} ${context.outcome} without acking your message ${m.id}.` +
            (stitch.length ? ` ${stitch.join(' · ')}.` : '') +
            ` Use the read toolkit (podium session status/read) if you need more.`,
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
   * reading its own box) the returned queued rows are marked delivered — read =
   * received — with the legacy issue_messages mirror kept in step so the
   * stop-hook/prime pending counts stop nagging on either surface.
   */
  readInbox(
    principals: { kind: 'issue' | 'session' | 'operator'; id?: string | null }[],
    opts?: { consume?: string | null; limit?: number },
  ): MessageRow[] {
    const rows = this.inbox(principals, opts?.limit !== undefined ? { limit: opts.limit } : {})
    if (opts?.consume === undefined) return rows
    const at = this.deps.now()
    return rows.map((m) => {
      if (m.status !== 'queued' || m.toKind === 'operator') return m
      if (!this.deps.messages.markDelivered(m.id, opts.consume ?? null, at)) return m
      if (m.toKind === 'issue' && m.toId) {
        try {
          this.deps.mirrorMarkIssueMailRead?.(m.toId, [m.id])
        } catch {}
      }
      const delivered = {
        ...m,
        status: 'delivered' as const,
        deliveredAt: at,
        deliveredTo: opts.consume ?? null,
      }
      this.emitTransition(delivered, 'message.delivered')
      return delivered
    })
  }

  // ---- clamp matrix / relationships ----

  private relationship(
    from: MessageSender,
    target: SessionMeta | undefined,
  ): 'operator' | 'superagent' | 'parent' | 'peer' | 'system' {
    if (from.kind === 'operator') return 'operator'
    if (from.kind === 'superagent') return 'superagent'
    if (from.kind === 'system') return 'system'
    // Parent → child: the sender spawned the target (spawnedBy provenance —
    // 'session:<id>' for session spawns, 'issue:<id>' for issue-agent spawns).
    if (target?.spawnedBy) {
      if (from.sessionId && target.spawnedBy === `session:${from.sessionId}`) return 'parent'
      if (from.issueId && target.spawnedBy === `issue:${from.issueId}`) return 'parent'
    }
    return 'peer'
  }

  private capsFor(
    from: MessageSender,
    target: SessionMeta | undefined,
  ): { maxUrgency: MessageUrgency; maxLifecycle: MessageLifecycle } {
    switch (this.relationship(from, target)) {
      case 'operator':
      case 'superagent':
      case 'parent':
        return { maxUrgency: 'interrupt', maxLifecycle: 'wake' }
      case 'peer':
        return { maxUrgency: 'next-turn', maxLifecycle: 'wake' }
      case 'system':
        return { maxUrgency: 'next-turn', maxLifecycle: 'wait' }
    }
  }

  // ---- state helpers ----

  private stateOf(s: SessionMeta): TargetState {
    if (s.status === 'hibernated' || s.status === 'exited') return 'parked'
    if (
      s.status === 'live' &&
      (s.queuedMessageCount ?? 0) === 0 &&
      (s.agentState === undefined ? !s.busy : s.agentState.phase === 'idle')
    ) {
      return 'idle'
    }
    return 'running'
  }

  private issueForSession(s: SessionMeta | undefined): string | null {
    if (!s) return null
    if (s.issueId) return s.issueId
    try {
      return this.deps.issues().issueForCwd(s.cwd) ?? null
    } catch {
      return null
    }
  }

  private senderKey(from: MessageSender): string {
    if (from.kind === 'agent') return `agent:${from.sessionId ?? from.issueId ?? '?'}`
    if (from.kind === 'system') return `system:${from.name ?? '?'}`
    return from.kind
  }

  private senderKeyOfRow(m: MessageRow): string {
    if (m.fromKind === 'agent') return `agent:${m.fromSession ?? m.fromIssue ?? '?'}`
    if (m.fromKind === 'system') return `system:${m.fromName ?? '?'}`
    return m.fromKind
  }

  private nowMs(): number {
    return Date.parse(this.deps.now())
  }

  /** Today's spawn count for an issue key — in-memory cache over the durable
   *  event ledger (`message.spawned` from the wake seam, plus `agent.spawned`
   *  rows that carry `budgetIssue` — the gate's budgeted agent spawns), so a
   *  restart never resets brake 2. */
  private spawnCountFor(key: string, day: string): number {
    const entry = this.spawnCount.get(key)
    if (entry?.day === day) return entry.count
    let count = 0
    try {
      for (const e of this.deps.events.listEventsSince(0, {
        kinds: ['message.spawned', 'agent.spawned'],
        limit: 5000,
      })) {
        const p = e.payload as { spawnIssue?: string; budgetIssue?: string } | null
        // agent.spawned rows only count when budgeted (operator spawns are free).
        const k = e.kind === 'agent.spawned' ? p?.budgetIssue : (p?.spawnIssue ?? 'no-issue')
        if (k !== undefined && e.ts.slice(0, 10) === day && k === key) count++
      }
    } catch {}
    this.spawnCount.set(key, { day, count })
    return count
  }

  /** Brake 2 for DIRECT agent spawns (`podium agent spawn`) — the gate shares
   *  the same per-issue daily budget as the spawn-on-wake seam, or a looping
   *  agent could fork-bomb the host with full PTY sessions the wake budget
   *  never sees [spec:SP-34d7 containment]. Consumes one unit when available. */
  takeSpawnBudget(issueId: string | null): { ok: boolean; count: number } {
    const key = issueId ?? 'no-issue'
    const day = this.deps.now().slice(0, 10)
    const count = this.spawnCountFor(key, day)
    if (count >= SPAWN_BUDGET_PER_DAY) return { ok: false, count }
    this.spawnCount.set(key, { day, count: count + 1 })
    return { ok: true, count: count + 1 }
  }

  /** The cooldown key of a stored row — MUST mirror recordWake/send: session
   *  targets resolve to their issue. */
  private wakeKeyOfRow(m: MessageRow): string {
    const target =
      m.toKind === 'session'
        ? this.deps
            .sessions()
            .listSessions()
            .find((s) => s.sessionId === m.toId)
        : undefined
    const issueKey = m.toKind === 'issue' ? m.toId : this.issueForSession(target)
    return `${this.senderKeyOfRow(m)}|${issueKey ?? m.toId ?? ''}`
  }

  private wakeCooldownHot(key: string): boolean {
    const cutoff = this.nowMs() - WAKE_COOLDOWN_MS
    const last = this.lastWakeAt.get(key)
    if (last !== undefined) return last >= cutoff
    // Cold key (fresh process): derive from the durable rows so a restart
    // never resets the brake, then cache the answer.
    let derived = 0
    try {
      for (const m of this.deps.messages.listRecentWakes(new Date(cutoff).toISOString())) {
        if (this.wakeKeyOfRow(m) !== key) continue
        const at = Date.parse(m.deliveredAt ?? m.createdAt)
        if (Number.isFinite(at)) derived = Math.max(derived, at)
      }
    } catch {}
    this.lastWakeAt.set(key, derived)
    return derived >= cutoff
  }

  private recordWake(message: MessageRow, target: SessionMeta | undefined): void {
    if (message.fromKind === 'operator') return
    const issueKey = message.toKind === 'issue' ? message.toId : this.issueForSession(target)
    this.lastWakeAt.set(
      `${this.senderKeyOfRow(message)}|${issueKey ?? message.toId ?? ''}`,
      this.nowMs(),
    )
  }

  // ---- rendering ----

  /** The exact text the receiver sees: enveloped for every principal EXCEPT the
   *  operator — only the human's own words land unwrapped. Oversized
   *  issue-addressed bodies render as an inbox pointer instead of inline. */
  renderFor(message: MessageRow, receiverSessionId?: string): string {
    if (message.toKind === 'issue' && message.body.length > INLINE_BODY_MAX) {
      return this.pointerText([message])
    }
    // Operator bodies are BYTE-FAITHFUL: the human's bytes are their own —
    // they can already type anything directly into their own terminal, so
    // there is no escalation to prevent. Unwrapped AND unsanitized. The ONE
    // exception is a question [spec:SP-34d7 read-toolkit tier 4]: the ask
    // round-trip needs the reply frame (message id + `podium mail reply`) or
    // the target can never ack and awaitAck always times out — so operator
    // questions render the frame around the still-byte-faithful body.
    if (message.fromKind === 'operator') {
      if (message.kind !== 'question') return message.body
      return renderEnvelope(message, 'the operator', this.toLabel(message))
    }
    // Substrate boundary: every NON-operator delivered body is control-stripped
    // so it can never break out of the bracketed paste (ESC[201~) in typeText.
    const body = sanitizeBody(message.body)
    return renderEnvelope(
      { ...message, body },
      this.fromLabel(message),
      this.toLabel(message),
      this.crossMachineNote(message, receiverSessionId),
    )
  }

  /** Cross-machine provenance [spec:SP-6d57]: when the sending session runs on a
   *  DIFFERENT machine than the receiver, say so and how to inspect its working
   *  state — built only from what podium already knows (session machineIds),
   *  zero storage. */
  private crossMachineNote(message: MessageRow, receiverSessionId?: string): string | undefined {
    if (!receiverSessionId || message.fromKind !== 'agent' || !message.fromSession) return undefined
    const sessions = this.deps.sessions().listSessions()
    const senderMachine = sessions.find((s) => s.sessionId === message.fromSession)?.machineId
    const receiverMachine = sessions.find((s) => s.sessionId === receiverSessionId)?.machineId
    if (!senderMachine || !receiverMachine || senderMachine === receiverMachine) return undefined
    const name = this.deps.machineName?.(senderMachine) ?? senderMachine
    return `[this agent runs on machine "${name}" — inspect its working tree with: podium workspace fetch ${message.fromSession}]`
  }

  private fromLabel(message: MessageRow): string {
    if (message.fromKind === 'agent') {
      if (message.fromIssue) {
        const issue = this.deps.issues().get(message.fromIssue)
        return issue ? `issue:#${issue.seq}` : message.fromIssue
      }
      if (message.fromSession) return `session:${message.fromSession}`
      return 'agent'
    }
    if (message.fromKind === 'system') return `system${message.fromName ? `:${message.fromName}` : ''}`
    return message.fromKind // superagent
  }

  private toLabel(message: MessageRow): string {
    if (message.toKind === 'issue') {
      const issue = this.deps.issues().get(message.toId ?? '')
      return issue ? `your issue #${issue.seq}` : `your issue ${message.toId}`
    }
    if (message.toKind === 'session') return 'your session'
    return 'the operator'
  }

  private markDelivered(message: MessageRow, sessionId: string): void {
    const at = this.deps.now()
    if (this.deps.messages.markDelivered(message.id, sessionId, at)) {
      // Inline delivery consumes the legacy issue_messages mirror row too, or
      // mailPending's legacy fallback keeps the stop-hook nagging ("You have
      // mail") until the agent runs `podium issue mail inbox`.
      if (message.toKind === 'issue' && message.toId) {
        try {
          this.deps.mirrorMarkIssueMailRead?.(message.toId, [message.id])
        } catch {}
      }
      // The delivered message triggers the receiver's next turn — anything it
      // sends within that turn chains at hop + 1 (cleared when it goes idle).
      this.turnHop.set(sessionId, message.hop)
      this.emitTransition(
        { ...message, status: 'delivered', deliveredAt: at, deliveredTo: sessionId },
        'message.delivered',
      )
    }
  }

  private legacyAuthor(from: MessageSender): string {
    switch (from.kind) {
      case 'operator':
        return 'operator'
      case 'superagent':
        return 'superagent'
      case 'system':
        return from.name ?? 'system'
      case 'agent': {
        if (from.issueId) {
          const issue = this.deps.issues().get(from.issueId)
          if (issue) return `issue:#${issue.seq}`
        }
        return from.sessionId ? `session:${from.sessionId}` : 'agent'
      }
    }
  }

  /** Needs-attention surfacing: durable event + existing notify path (both
   *  best-effort — the row itself stays queued, nothing is dropped). */
  private needsAttention(message: MessageRow, reason: string): void {
    // Once per (message, reason): the sweep retries every 60s and must not
    // re-emit the same alarm each pass (event-log + notify spam).
    const dedupe = `${message.id}|${reason}`
    if (this.attentionEmitted.has(dedupe)) return
    this.attentionEmitted.add(dedupe)
    this.emitTransition(message, 'message.needs_attention')
    try {
      this.deps.notifyOperator?.({ messageId: message.id, reason, body: message.body })
    } catch {}
  }

  /** One podium_events row per ledger transition (steward visibility, audit). */
  private emitTransition(message: MessageRow, kind: string, extra?: Record<string, unknown>): void {
    try {
      this.deps.events.appendEvent({
        ts: this.deps.now(),
        kind,
        subject: message.id,
        payload: {
          messageId: message.id,
          threadId: message.threadId,
          fromKind: message.fromKind,
          ...(message.fromName ? { fromName: message.fromName } : {}),
          ...(message.fromIssue ? { fromIssue: message.fromIssue } : {}),
          ...(message.fromSession ? { fromSession: message.fromSession } : {}),
          toKind: message.toKind,
          ...(message.toId ? { toId: message.toId } : {}),
          kind: message.kind,
          urgency: message.urgency,
          lifecycle: message.lifecycle,
          status: message.status,
          ...(message.hop ? { hop: message.hop } : {}),
          ...(message.clampedFrom ? { clampedFrom: message.clampedFrom } : {}),
          ...(message.deliveredTo ? { deliveredTo: message.deliveredTo } : {}),
          ...extra,
        },
      })
    } catch {}
  }
}
