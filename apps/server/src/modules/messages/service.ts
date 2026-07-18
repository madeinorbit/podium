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
import type { AgentPhase, SessionMeta } from '@podium/protocol'
import { selectMailNudgeSession, sessionsForIssue } from '../../issue-util'
import type {
  IssueMessageRow,
  MessageKind,
  MessageLifecycle,
  MessageRow,
  MessageUrgency,
} from '../../store'
import type { EventsRepository } from '../../store/events'
import type { MessagePageCursor, MessagesRepository } from '../../store/messages'
import type { NotificationFactsRepository } from '../../store/notification-facts'
import { NotificationArbiter } from '../../store/notification-facts'
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
/** Implicit expiry for wait-lifecycle queued rows with no explicit expires_at
 *  [POD-817]: without one, undeliverable issue mail queues forever and the
 *  sweep re-attempts every row every minute. Expired rows stay readable in the
 *  inbox/ledger — expiry only stops redelivery. */
export const QUEUED_WAIT_TTL_MS = 7 * 24 * 60 * 60_000
/** A pushed message becomes `delivered` only when its envelope echoes back as a
 *  turn in the target's transcript [POD-834 §04d]. If no echo confirms within
 *  this window the push was lost (drain refused, session died, an ESC ate it) and
 *  the sweep auto-requeues it. Comfortably exceeds the 25s queue-drain deadline
 *  plus the ~1s transcript-tail latency so a slow-but-live drain is never
 *  mistaken for a loss. */
export const ECHO_CONFIRM_WINDOW_MS = 90_000
/** How many lost-echo requeues a pushed row gets before the sweep stops
 *  re-injecting and degrades it to delivered-at-last-push [POD-853 stopgap]:
 *  a mid-turn injection never echoes as a user turn, and an uncapped requeue
 *  loop re-delivers the same message forever (observed live 2026-07-17). */
export const MAX_ECHO_REQUEUES = 2
/** Extracts every podium-message id an echoed transcript turn carries — the
 *  server-rendered envelope frames the body with `[podium message <id> …]` and
 *  `[end podium message <id>]`, so a user turn that pasted a delivered message
 *  reflects the id back verbatim (transcript-echo confirmation, [POD-834]). */
export const ECHO_ID_RE = /\bpodium message (msg_[0-9a-f-]+)\b/gi

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

/** What actually happened to a send, surfaced to the sender so a message that
 *  reached no one is never a bare success [POD-834 §04b]:
 *   - `delivered`   CONFIRMED in the target's transcript (echo or turn boundary),
 *                   or injection-is-delivery for an unwrapped operator body;
 *   - `queued`      handed to the harness input queue (or held for a live target's
 *                   next boundary) — NOT yet transcript-observed [spec:SP-cb9f];
 *   - `accepted`    a blocking send's budget expired with the row still queued
 *                   (busy / composer-draft-held / lost echo) — durably captured,
 *                   not yet confirmed; the sender queries `podium mail status`;
 *   - `held`        issue-addressed, issue live but NO live session — held for
 *                   the issue's next session (delivered at its next boundary);
 *   - `spawning`    a wake spawned a fresh agent to receive it;
 *   - `dead_letter` the target was gone; NOT delivered. */
export type SendDisposition =
  | 'delivered'
  | 'queued'
  | 'accepted'
  | 'held'
  | 'spawning'
  | 'dead_letter'

/** How a rendered message is confirmed as reaching the agent [POD-834]:
 *   - `echo`      enveloped body carrying the msg id → confirmed by transcript echo;
 *   - `pointer`   a coalesced "you have mail" nudge (fyi / oversized issue mail) →
 *                 the body isn't shown inline, so it is confirmed by an inbox READ,
 *                 never echo — and is never auto-requeued (no re-nudge storm);
 *   - `unwrapped` an operator's byte-faithful body (no envelope, no id) → no echo
 *                 is possible, so injection itself is the confirmation. */
type DeliveryMode = 'echo' | 'pointer' | 'unwrapped'

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
  /** Opt into a reply [POD-835 §04b]: `--expect-response`. Only then does the
   *  system expect (and, on settle, nag about) a response. A `question` implies it;
   *  an `ack`/`notification` can never set it. Omitted = false (receipt-only). */
  expectsResponse?: boolean
  /** Internal-only arbiter identity for message-backed notifications. */
  notificationFact?: { factKey: string; target: string }
}

export interface MessageSendResult {
  message: MessageRow
  /** sendText/queueText-compatible outcome (existing CLI/tool wire shapes). */
  ok: boolean
  queued?: boolean
  reason?: string
  /** The honest, sender-facing outcome [POD-834]: what happened to the message,
   *  so `held` and `dead_letter` are never a silent success. */
  disposition: SendDisposition
  /** The legacy issue_messages mirror row (issue-addressed sends only) — keeps
   *  mail inbox/claim/pending working until those readers migrate. */
  legacy?: IssueMessageRow
}

/** attemptDelivery's result: the transport outcome plus the sender-facing
 *  disposition [POD-834]. */
interface DeliveryOutcome {
  ok: boolean
  queued?: boolean
  reason?: string
  disposition: SendDisposition
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
  notificationFacts: NotificationFactsRepository
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
  // A --expect-response message [spec:SP-bf44] carries the same reply directive a
  // question does, minus the answer-then-resume binding: the sender wants a reply
  // (else the steward will nag them that none came), but it is not a seance. A
  // question already gets its own, stronger rule above, so this is question-exempt.
  const responseRule =
    m.expectsResponse && m.kind !== 'question'
      ? `[a response was requested: reply within this thread (\`podium mail reply ${m.id}\`) ` +
        `when you have handled it — any substantive reply satisfies it]\n`
      : ''
  return (
    `[podium message ${m.id} · from ${fromLabel} · to ${toLabel} · reply: podium mail reply ${m.id}]\n` +
    `${m.body}\n` +
    (note ? `${note}\n` : '') +
    questionRule +
    responseRule +
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

type DeliveryTarget = { kind: 'session' | 'issue'; id: string }

/** The low-frequency sweep remains a bounded safety net while event coverage is
 * proven. One pass never revisits an unbounded historical queue. [spec:SP-c29e] */
export const DELIVERY_RETRY_BACKSTOP_LIMIT = 100
/** Five minutes: event triggers are primary; this only heals a missed edge. */
export const DELIVERY_RETRY_BACKSTOP_MS = 5 * 60_000

interface DeliveryTargetWork {
  target: DeliveryTarget
  after?: MessagePageCursor
  preferred?: SessionMeta
  enqueuedAt: number
}

export interface MessageDeliveryStats {
  pendingTargetCount: number
  coalescedTriggerCount: number
  oldestJobAgeMs: number
  retryPageCursor: MessagePageCursor | null
  retryPagesProcessed: number
  triggerFailures: number
}

const DELIVERY_TARGET_PAGE_LIMIT = 200
const DELIVERY_RECONCILE_PAGE_LIMIT = 100

function cursorOf(message: MessageRow): MessagePageCursor {
  return {
    createdAt: message.createdAt,
    id: message.id,
  }
}

const deliveryTargetKey = (target: DeliveryTarget): string => `${target.kind}:${target.id}`

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
  /** Lost-echo requeues per message id [POD-853 stopgap]; in-memory is fine —
   *  a restart resets the count and the row simply earns its cap again. */
  private readonly requeueCounts = new Map<string, number>()
  /** Last wake timestamp per sender+resolved-target brake key. This is a
   * write-through cache over message_wake_cooldowns; cold reads are keyed. */
  private readonly lastWakeAt = new Map<string, number>()
  /** message-triggered spawns per issue for the current UTC day (brake 2) — a
   *  cache over the `message.spawned` event ledger (restart-proof). */
  private readonly spawnCount = new Map<string, { day: string; count: number }>()
  /** needs-attention already emitted per `${messageId}|${reason}` — the sweep
   *  re-attempts every 60s and must not spam the event log / notify path. */
  private readonly attentionEmitted = new Set<string>()

  private readonly notificationArbiter: NotificationArbiter

  constructor(private readonly deps: MessageDeliveryDeps) {
    this.notificationArbiter = new NotificationArbiter(deps.notificationFacts, deps.now)
  }

  /** Bounded delivery jobs coalesce by durable recipient principal. */
  private readonly pendingDeliveryTargets = new Map<string, DeliveryTargetWork>()
  private deliveryTriggerTimer: ReturnType<typeof setTimeout> | null = null
  private reconcileTimer: ReturnType<typeof setTimeout> | null = null
  private retryBackstopTimer: ReturnType<typeof setTimeout> | null = null
  private retryBackstopCursor: MessagePageCursor | null = null
  private retryPassStartedAt: number | null = null
  private retryPagesProcessed = 0
  private coalescedTriggerCount = 0
  private triggerFailures = 0
  /** Last resolved issue per session. This is the before-state needed for detach,
   * reassignment, inferred-cwd movement, and remove events. */
  private readonly sessionIssueTargets = new Map<string, string>()
  /** One restart-recoverable wake-cooldown timer per sender+target brake key. */
  private readonly wakeCooldownTimers = new Map<
    string,
    {
      deadline: number
      timer: ReturnType<typeof setTimeout>
      targets: Map<string, DeliveryTarget>
    }
  >()

  /** Queue the session principal plus both sides of its issue-resolution change. */
  onSessionEligibilityChanged(
    sessionId: string,
    changed?: SessionMeta,
    opts?: { preferThisIdleSession?: boolean },
  ): void {
    const session =
      changed ??
      this.deps
        .sessions()
        .listSessions()
        .find((candidate) => candidate.sessionId === sessionId)
    const previousIssueId = this.sessionIssueTargets.get(sessionId)
    const nextIssueId = this.issueForSession(session)
    if (nextIssueId) this.sessionIssueTargets.set(sessionId, nextIssueId)
    else this.sessionIssueTargets.delete(sessionId)

    const preferred =
      opts?.preferThisIdleSession && session && this.stateOf(session) === 'idle'
        ? session
        : undefined
    this.queueDeliveryTarget({ kind: 'session', id: sessionId }, preferred)
    if (previousIssueId && previousIssueId !== nextIssueId) {
      this.queueDeliveryTarget({ kind: 'issue', id: previousIssueId })
    }
    if (nextIssueId) this.queueDeliveryTarget({ kind: 'issue', id: nextIssueId }, preferred)
  }

  /** Issue-side target changes can alter inferred session membership and the
   * cooldown key of session-addressed wakes. Recompute affected sessions and
   * queue their principals plus both old/new issues. */
  onIssueEligibilityChanged(issueId: string): void {
    this.queueDeliveryTarget({ kind: 'issue', id: issueId })
    for (const session of this.deps.sessions().listSessions()) {
      const previousIssueId = this.sessionIssueTargets.get(session.sessionId)
      const nextIssueId = this.issueForSession(session)
      if (
        previousIssueId === issueId ||
        nextIssueId === issueId ||
        previousIssueId !== nextIssueId
      ) {
        this.onSessionEligibilityChanged(session.sessionId, session)
      }
    }
  }

  /** Begin a bounded startup walk. Each page schedules the next macrotask so
   * every durable principal is enumerated without one unbounded boot turn. */
  reconcileQueued(): void {
    const sessions = this.deps.sessions().listSessions()
    if (this.deps.messages.countQueued() === 0) {
      // Preserve the before-state needed by detach/reassign events without
      // issuing two principal COUNTs per live session on the overwhelmingly
      // common empty-queue boot path.
      for (const session of sessions) {
        const issueId = this.issueForSession(session)
        if (issueId) this.sessionIssueTargets.set(session.sessionId, issueId)
      }
      return
    }
    for (const session of sessions) {
      this.onSessionEligibilityChanged(session.sessionId, session)
    }
    this.runReconcilePage()
  }

  private runReconcilePage(after?: MessagePageCursor): void {
    this.reconcileTimer = null
    let page: MessageRow[]
    try {
      page = this.deps.messages.listQueuedPage({
        ...(after ? { after } : {}),
        limit: DELIVERY_RECONCILE_PAGE_LIMIT,
      })
    } catch (error) {
      this.recordTriggerFailure('startup page query', error)
      return
    }
    for (const message of page) {
      const target = this.deliveryTargetOf(message)
      if (target) this.queueDeliveryTarget(target)
    }
    this.flushDeliveryTriggers()
    if (page.length < DELIVERY_RECONCILE_PAGE_LIMIT) return
    const next = cursorOf(page.at(-1)!)
    this.reconcileTimer = setTimeout(() => this.runReconcilePage(next), 0)
    this.reconcileTimer.unref?.()
  }

  /** Deterministic test/shutdown seam for one bounded coalesced turn. */
  flushDeliveryTriggers(): void {
    if (this.deliveryTriggerTimer) {
      clearTimeout(this.deliveryTriggerTimer)
      this.deliveryTriggerTimer = null
    }
    if (this.pendingDeliveryTargets.size === 0) return
    const works = [...this.pendingDeliveryTargets.values()]
    this.pendingDeliveryTargets.clear()
    const selected = new Map<string, MessageRow>()
    const preferredGroups = new Map<
      string,
      { session: SessionMeta; messages: Map<string, MessageRow> }
    >()

    for (const work of works) {
      let page: MessageRow[]
      try {
        page = this.deps.messages.pendingForPage(work.target, {
          ...(work.after ? { after: work.after } : {}),
          limit: DELIVERY_TARGET_PAGE_LIMIT,
        })
      } catch (error) {
        this.recordTriggerFailure(`target page ${deliveryTargetKey(work.target)}`, error)
        continue
      }
      if (page.length === DELIVERY_TARGET_PAGE_LIMIT) {
        this.queueDeliveryTarget(work.target, work.preferred, cursorOf(page.at(-1)!))
      }
      for (const message of page) {
        selected.set(message.id, message)
        if (!work.preferred) continue
        let group = preferredGroups.get(work.preferred.sessionId)
        if (!group) {
          group = { session: work.preferred, messages: new Map() }
          preferredGroups.set(work.preferred.sessionId, group)
        }
        group.messages.set(message.id, message)
      }
    }

    if (selected.size === 0) return
    const all = this.deps.sessions().listSessions()
    const nowMs = this.nowMs()
    const handled = new Set<string>()
    for (const group of preferredGroups.values()) {
      const session = group.session
      if (this.stateOf(session) !== 'idle') continue
      const messages = [...group.messages.values()]
      for (const message of messages) handled.add(message.id)
      if (this.draftHoldActive(session)) continue
      const eligible = messages.filter((message) => this.prepareQueuedAttemptSafely(message, nowMs))
      eligible.sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id))
      try {
        this.deliverBatch(session, eligible)
        for (const message of eligible) this.scheduleQueuedWakeRetry(message)
      } catch (error) {
        this.recordTriggerFailure(`preferred session ${session.sessionId}`, error)
      }
    }
    for (const message of selected.values()) {
      if (handled.has(message.id)) continue
      if (!this.prepareQueuedAttemptSafely(message, nowMs)) continue
      try {
        this.attemptDelivery(message, all, { viaSweep: true })
        this.scheduleQueuedWakeRetry(message)
      } catch (error) {
        this.recordTriggerFailure(`message ${message.id}`, error)
      }
    }
  }

  deliveryStats(): MessageDeliveryStats {
    const now = this.nowMs()
    let oldest = this.retryPassStartedAt
    for (const work of this.pendingDeliveryTargets.values()) {
      oldest = oldest === null ? work.enqueuedAt : Math.min(oldest, work.enqueuedAt)
    }
    return {
      pendingTargetCount: this.pendingDeliveryTargets.size,
      coalescedTriggerCount: this.coalescedTriggerCount,
      oldestJobAgeMs: oldest === null ? 0 : Math.max(0, now - oldest),
      retryPageCursor: this.retryBackstopCursor,
      retryPagesProcessed: this.retryPagesProcessed,
      triggerFailures: this.triggerFailures,
    }
  }

  dispose(): void {
    if (this.deliveryTriggerTimer) clearTimeout(this.deliveryTriggerTimer)
    if (this.reconcileTimer) clearTimeout(this.reconcileTimer)
    if (this.retryBackstopTimer) clearTimeout(this.retryBackstopTimer)
    this.deliveryTriggerTimer = null
    this.reconcileTimer = null
    this.retryBackstopTimer = null
    for (const pending of this.wakeCooldownTimers.values()) clearTimeout(pending.timer)
    this.wakeCooldownTimers.clear()
    this.pendingDeliveryTargets.clear()
    this.sessionIssueTargets.clear()
  }

  private queueDeliveryTarget(
    target: DeliveryTarget,
    preferred?: SessionMeta,
    after?: MessagePageCursor,
  ): void {
    try {
      if (this.deps.messages.countPending(target) === 0) return
    } catch (error) {
      this.recordTriggerFailure(`target count ${deliveryTargetKey(target)}`, error)
      return
    }

    const key = deliveryTargetKey(target)
    const existing = this.pendingDeliveryTargets.get(key)
    if (existing) {
      this.coalescedTriggerCount += 1
      if (!after) existing.after = undefined
      else if (existing.after && this.compareCursor(after, existing.after) < 0)
        existing.after = after
      if (preferred) existing.preferred = preferred
    } else {
      this.pendingDeliveryTargets.set(key, {
        target,
        ...(after ? { after } : {}),
        ...(preferred ? { preferred } : {}),
        enqueuedAt: this.nowMs(),
      })
    }
    this.scheduleDeliveryFlush()
  }

  private scheduleDeliveryFlush(): void {
    if (this.deliveryTriggerTimer) return
    this.deliveryTriggerTimer = setTimeout(() => {
      this.deliveryTriggerTimer = null
      try {
        this.flushDeliveryTriggers()
      } catch (error) {
        this.recordTriggerFailure('coalesced delivery flush', error)
      }
    }, 0)
    this.deliveryTriggerTimer.unref?.()
  }

  private compareCursor(a: MessagePageCursor, b: MessagePageCursor): number {
    return a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id)
  }

  private prepareQueuedAttemptSafely(message: MessageRow, nowMs: number): boolean {
    try {
      return this.prepareQueuedAttempt(message, nowMs)
    } catch (error) {
      this.recordTriggerFailure(`prepare message ${message.id}`, error)
      return false
    }
  }

  private recordTriggerFailure(context: string, error: unknown): void {
    this.triggerFailures += 1
    console.warn(`[podium] message delivery trigger failed (${context})`, error)
  }

  private deliveryTargetOf(message: MessageRow): DeliveryTarget | null {
    if (message.toKind === 'operator' || !message.toId) return null
    return { kind: message.toKind, id: message.toId }
  }

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

    // A response is OPT-IN [spec:SP-bf44] [POD-835 §04b]: a plain message owes no reply —
    // receipt is proven mechanically by the ledger (POD-834), no ack traffic. Only an
    // explicit `--expect-response` (or a `question`, which always wants an answer)
    // arms the stop-hook reminder + steward settle-nag. An `ack`/`notification` can
    // never expect one — an ack is never itself ackable (kills the 243 ack-of-acks).
    const kind = input.kind ?? 'message'
    const expectsResponse =
      kind === 'question'
        ? true
        : kind === 'ack' || kind === 'notification'
          ? false
          : (input.expectsResponse ?? false)

    // Semantic-reply-as-ack [spec:SP-bf44] [POD-835 §04b]: a reply back to the
    // requester within the thread SATISFIES a requested response — not only a
    // `kind:'ack'`. So a thorough substantive reply clears the nag (the 36 false
    // "finished without acking" notices came from treating such a reply as "no ack").
    // But ONLY a genuine reply FROM THE PARTY THAT WAS ASKED fulfils it: the
    // steward's own settle-nag (`kind:'notification'`, in_reply_to the original,
    // from system:steward) must NOT count — it fires precisely BECAUSE the recipient
    // finished without responding, so letting it stamp acked_by would report the
    // request answered and release awaitAck by the nag itself (POD-835 review). Two
    // guards: a notification is structurally never a response, and the responder
    // must be the original's recipient (which also excludes a third party and the
    // requester itself, so !sameSenderAs is subsumed but kept for clarity).
    const respondsToRequest =
      !!original &&
      original.expectsResponse === true &&
      kind !== 'notification' &&
      !this.sameSenderAs(from, original) &&
      this.isRecipientOf(from, original)
    const stampsAck = (kind === 'ack' || respondsToRequest) && !!input.inReplyTo

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
      kind,
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
      factKey: input.notificationFact?.factKey ?? null,
      factTarget: input.notificationFact?.target ?? null,
      expectsResponse,
    }
    // The reply row and the acked_by stamp on the original commit atomically —
    // the steward's suppression check can never observe one without the other.
    const write = (): void => {
      this.deps.messages.addMessage(message)
      if (stampsAck && message.inReplyTo) {
        this.deps.messages.markAcked(message.inReplyTo, id)
      }
    }
    if (this.deps.transact) this.deps.transact(write)
    else write()
    if (stampsAck && original) {
      this.emitTransition({ ...original, ackedBy: id }, 'message.acked')
      // A reply PROVES the recipient received the original — a stronger signal than
      // a transcript echo. Confirm it delivered so a missed echo never keeps the
      // sweep re-injecting an already-answered message [POD-834 review]. Guarded
      // on status='queued' in the store, so a already-delivered original is a
      // no-op; deliveredTo is always set once a row was injected.
      if (original.status === 'queued' && original.deliveredTo) {
        this.markDelivered(original, original.deliveredTo, 'ack')
      }
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
    if (message.toKind === 'issue' && toId && issues.has(toId)) {
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
    this.scheduleQueuedWakeRetry(message)
    return { message: this.deps.messages.getMessage(id) ?? message, ...outcome, legacy }
  }

  // ---- delivery resolution (state × axis table) ----

  /**
   * Resolve the recipient to a concrete session NOW (TOCTOU-safe — nothing was
   * decided at send time) and act per the delivery table. Undeliverable
   * messages stay `queued`; retriggers: session-goes-idle drain (onSessionIdle),
   * the daemon stop-hook (mailPending), and the slow sweep().
   */
  /** `allSessions` lets the sweep share one listing across its whole pass
   *  [POD-817] — a per-call listSessions() builds a full wire meta for every
   *  session. Within-pass staleness is fine: agent-state updates already lag
   *  sendText, so a fresh list would race the same way. */
  private attemptDelivery(
    message: MessageRow,
    allSessions?: SessionMeta[],
    opts?: { viaSweep?: boolean },
  ): DeliveryOutcome {
    // A dead-letter found at SEND time returns synchronously to a watching sender
    // (no async notice); one found LATER (sweep) must tell the sender once.
    const notifySender = opts?.viaSweep === true
    if (message.toKind === 'operator') {
      // Escalation to the human: stays queued, kind-tagged for UI pickup (ledger
      // view). Its "delivery" is the operator reading their inbox, not a black hole.
      return { ok: true, queued: true, disposition: 'queued' }
    }
    const sessions = this.deps.sessions()
    const all = allSessions ?? sessions.listSessions()

    let target: SessionMeta | undefined
    if (message.toKind === 'session') {
      // Self-delivery suppression [spec:SP-a4ba] (§09-H, POD-836): a message must never be
      // surfaced back to the session that sent it (the POD-279 15× self-echo
      // loop). A session-addressed self-send has no other recipient — ledger-only.
      if (message.fromSession && message.toId === message.fromSession) {
        return this.suppressSelf(message)
      }
      target = all.find((s) => s.sessionId === message.toId)
      if (!target) {
        // The session row is GONE (not merely parked — parked sessions still
        // list). A session-addressed row records no issue to re-route to, so
        // dead-letter it: never silently queue to a session that will never exist
        // again — the 70 POD-279 losses included exactly this [POD-834 §05].
        return this.deadLetter(message, 'session no longer exists', { notifySender })
      }
    } else {
      // Full wire is intentional: recipient selection consumes issue-derived
      // membership. Share the sweep's session listing with the wire build too
      // [POD-817]: get() otherwise defaults to a fresh listSessions() inside
      // toWire — the second per-row O(sessions) cost hiding behind the first.
      const issue = this.deps.issues().get(message.toId ?? '', all)
      if (!issue) return this.deadLetter(message, 'issue no longer exists', { notifySender })
      // A closed-and-archived issue is GONE — no future session will prime on it,
      // so holding is a black hole. Dead-letter it [POD-834 §05]. A merely open
      // (or done-but-live) issue with no session is HELD, below.
      if (issue.archived)
        return this.deadLetter(message, `issue #${issue.seq} is archived`, { notifySender })
      const allMembers = sessionsForIssue(issue.worktreePath ?? null, all, issue.id)
      // Self-delivery suppression [spec:SP-a4ba] (§09-H, POD-836): exclude the sender's own
      // session from issue-recipient resolution, so an agent mailing its own
      // issue never picks itself. selectMailNudgeSession picks the single live
      // idle member, which would otherwise BE the sender.
      const members = allMembers.filter((s) => s.sessionId !== message.fromSession)
      // Prefer the issue's designated coordinator for ACTIONABLE (non-fyi) mail
      // when that session is live (docs/agent-comms-target.html §05 q1). fyi /
      // broadcast routing is unchanged — still selectMailNudgeSession. If the
      // coordinator is unset, gone, or not live, fall back to today's heuristic.
      // Bare session id on the wire (same format as humanQuestionAskedBy).
      const preferCoordinator =
        message.urgency !== 'fyi' && typeof issue.coordinatorSessionId === 'string'
      const coordinatorLive = preferCoordinator
        ? members.find(
            (s) =>
              s.sessionId === issue.coordinatorSessionId &&
              s.agentKind !== 'shell' &&
              s.status === 'live',
          )
        : undefined
      if (coordinatorLive) {
        target = coordinatorLive
      } else {
        const live = selectMailNudgeSession(members)
        target = live
          ? members.find((s) => s.sessionId === live.sessionId)
          : // No live member: a wake picks the most recent parked agent to resurrect.
            [...members]
              .filter((s) => s.agentKind !== 'shell')
              .sort((a, b) => (b.lastActiveAt ?? '').localeCompare(a.lastActiveAt ?? ''))
              .at(0)
      }
      if (!target) {
        // The sender was the only member: ledger-only, not queued — otherwise
        // it lingers and the stop-hook nags the sender about its own note. It
        // must also never spawn a fresh agent to receive the sender's own mail.
        if (message.fromSession && allMembers.some((s) => s.sessionId === message.fromSession)) {
          return this.suppressSelf(message)
        }
        if (message.lifecycle === 'wake') return this.trySpawn(message, message.toId)
        // Issue is live but has NO session — HOLD for its next session. Delivered
        // at that session's next turn boundary (onSessionIdle) / the sweep. The
        // sender is TOLD it is held; it is not a silent drop [POD-834 §05].
        return { ok: true, queued: true, disposition: 'held' }
      }
    }

    // Composer-draft delivery guard [spec:SP-d716] [POD-865]: the human has a half-typed
    // composer/native-prompt line on this session — injecting now merges the
    // envelope into their input (and a trailing CR submits it). HOLD exactly
    // like the busy-turn state, for EVERY urgency including interrupt:
    // corrupting a human's live input is never acceptable. The row stays
    // queued; onSessionIdle / the sweep deliver once the draft clears.
    // `draftUpdatedAt` is the in-memory presence signal (set per keystroke,
    // cleared the instant the draft empties or submits — fresher than the
    // debounced session_drafts row), so presence ⇔ non-empty draft and the
    // design's "updated within 10s" clause is subsumed: no timestamp survives
    // a clear, and a non-empty draft holds regardless of age.
    if (this.draftHoldActive(target)) {
      return { ok: true, queued: true, disposition: 'queued' }
    }

    const state = this.stateOf(target)
    if (state === 'idle') {
      // idle/live: inject now, every urgency.
      return this.injectAndMark('now', message, target.sessionId, 'delivered')
    }
    if (state === 'running') {
      if (message.urgency === 'fyi') {
        // Surfaces at the next pause: stop-hook / prime pending query.
        return { ok: true, queued: true, disposition: 'queued' }
      }
      if (message.urgency === 'interrupt') {
        // The intended mid-turn path. interruptText sends ESC first, which
        // visibly cancels an open AskUserQuestion menu before the text lands.
        return this.injectAndMark('interrupt', message, target.sessionId, 'delivered')
      }
      // next-turn. A 'starting' session has no turn in flight and nothing on
      // screen — ride the durable boot queue; it types once the agent binds.
      if (target.status === 'starting') {
        return this.injectAndMark('queue', message, target.sessionId, 'queued')
      }
      // Busy live agent: HOLD for the turn boundary. queueText's immediate
      // drain types mid-turn (#471), and its submitting CR auto-answers an
      // on-screen AskUserQuestion menu (#473 P0). onSessionIdle delivers when
      // the phase reaches idle; sweep() is the backstop. A valid, reachable,
      // live target — the sender gets certainty of landing (queued), not a drop.
      return { ok: true, queued: true, disposition: 'queued' }
    }
    // parked (hibernated/exited)
    if (message.lifecycle === 'wait') {
      return { ok: true, queued: true, disposition: 'queued' }
    }
    // wake: durable queue + resurrect (queueText resurrects parked sessions);
    // record the wake against the cooldown window.
    this.recordWake(message, target)
    const injected = this.injectAndMark('queue', message, target.sessionId, 'queued')
    if (injected.ok) return injected
    if (injected.reason === 'no resume ref') {
      return this.trySpawn(message, this.issueForSession(target) ?? message.toId)
    }
    return injected
  }

  /**
   * The ONE place a push toward a live PTY records its ledger state [POD-834].
   * `via` picks the transport; `okDisposition` is what a successful dispatch means
   * to the sender. Crucially it marks the row `injected` (bytes dispatched,
   * awaiting the transcript echo), NOT `delivered` — except an unwrapped operator
   * body, which carries no id to echo and so is confirmed on injection. This is
   * the fix for the POD-495 defect-B lie: an enqueue is no longer a delivery.
   */
  private injectAndMark(
    via: 'now' | 'queue' | 'interrupt',
    message: MessageRow,
    sessionId: string,
    okDisposition: SendDisposition,
  ): DeliveryOutcome {
    const sessions = this.deps.sessions()
    const text = this.renderFor(message, sessionId)
    const r =
      via === 'now'
        ? sessions.sendText({ sessionId, text })
        : via === 'interrupt'
          ? sessions.interruptText({ sessionId, text })
          : sessions.queueText({ sessionId, text })
    // Transport rejected the push (e.g. the daemon dropped offline mid-send). The
    // row was still captured + durably queued, so the SWEEP will re-attempt it —
    // `disposition: 'queued'` describes that row position, while `ok: false`
    // reports THIS push attempt failed. The one caller whose ok:false carries a
    // recoverable path — a parked 'no resume ref' — is intercepted upstream and
    // routed to trySpawn, so it never surfaces this mixed signal to a sender.
    if (!r.ok) return { ...r, disposition: 'queued' }
    const confirmed = this.confirmedOnInjection(message)
    if (confirmed) {
      // No echo will ever come (unwrapped operator body has no id), or chasing one
      // is pure loop risk (a best-effort ack/notification) — the injection IS the
      // delivery [POD-834, POD-853].
      this.markDelivered(message, sessionId, 'injection')
    } else {
      // Enveloped (echo) or a coalesced pointer (read): record the push and wait
      // for the agent's own signal (transcript echo → delivered, inbox → read).
      this.markInjected(message, sessionId)
    }
    // Honest sync disposition [spec:SP-cb9f] [POD-854]. The optimistic `delivered`
    // disposition is only ever passed for a LIVE-PTY push (via 'now' / 'interrupt',
    // sendText/interruptText) — the bytes are on screen now — so it is honest only
    // when the push is confirmed-on-injection (unwrapped operator body / best-effort
    // ack). An enveloped echo is merely in the harness input queue, not yet
    // transcript-observed, so it downgrades to `queued`; the blocking send surface
    // upgrades it to `delivered` only when the echo / turn boundary confirms it. A
    // durable boot-queue push ('queue') keeps its `queued`/`spawning` disposition
    // untouched — the message rides the resume queue, delivered when the session binds.
    if (okDisposition === 'delivered') {
      return { ...r, disposition: confirmed ? 'delivered' : 'queued' }
    }
    return { ...r, disposition: okDisposition }
  }

  /** Brake 2 + the spawn seam: unresumable wake → spawn a fresh agent on the
   *  target issue (deferred wiring) within the per-issue daily budget; no seam
   *  or budget exhausted → ledger + needs-attention, row stays queued. */
  private trySpawn(message: MessageRow, issueId: string | null): DeliveryOutcome {
    const key = issueId ?? 'no-issue'
    const day = this.deps.now().slice(0, 10)
    const count = this.spawnCountFor(key, day)
    if (count >= SPAWN_BUDGET_PER_DAY) {
      this.emitTransition(message, 'message.spawn_budget_exhausted')
      this.needsAttention(
        message,
        `spawn budget exhausted for issue ${key} (${SPAWN_BUDGET_PER_DAY}/day); message stays queued`,
      )
      return { ok: true, queued: true, reason: 'spawn budget exhausted', disposition: 'held' }
    }
    if (!this.deps.spawnOnWake) {
      // TODO(#237 stage 4/5): wire spawnOnWake to SessionsService.spawn — the
      // message becomes the first prompt after prime.
      this.needsAttention(message, 'wake target is unresumable and spawn-on-wake is not wired')
      return { ok: true, queued: true, reason: 'unresumable', disposition: 'held' }
    }
    this.spawnCount.set(key, { day, count: count + 1 })
    // A spawn attempt IS a wake — record it against the cooldown so the sweep
    // does not re-run the spawn seam every 60s.
    if (message.fromKind !== 'operator') {
      this.recordWakeKey(`${this.senderKeyOfRow(message)}|${issueId ?? ''}`)
    }
    const r = this.deps.spawnOnWake.spawn({ issueId, message })
    if (r.ok && r.sessionId) {
      // spawnIssue rides the event so the budget survives restarts (see
      // spawnCountFor) — it can differ from toId for session-addressed wakes.
      this.emitTransition(message, 'message.spawned', { spawnIssue: key })
      const injected = this.injectAndMark('queue', message, r.sessionId, 'spawning')
      if (injected.ok) return injected
      return injected
    }
    this.needsAttention(message, `spawn-on-wake failed: ${r.reason ?? 'unknown'}`)
    return { ok: true, queued: true, reason: r.reason ?? 'spawn failed', disposition: 'held' }
  }

  // ---- retriggers ----

  /**
   * Drain trigger: a session's turn ended (phase → idle). Confirms delivery of
   * anything the just-ended turn consumed (turn-boundary backstop), clears the hop
   * context for the finished turn, then delivers what queued up while it was
   * busy/parked — its session-addressed rows plus its issue's rows, FIFO, with fyi
   * batches coalesced into one inbox pointer. `priorPhase` is the phase the session
   * left to become idle; an `errored` turn did not complete, so it must not confirm.
   */
  onSessionIdle(session: SessionMeta, opts?: { priorPhase?: AgentPhase }): void {
    const issueId = this.issueForSession(session)
    // Turn-boundary confirmation [POD-853]: the turn that just reached idle
    // consumed every echo-mode row already pushed into THIS session's PTY — flip
    // them delivered even though their envelope never echoed as a clean role=user
    // turn. A mid-turn/busy injection is recorded isMeta:true / promptSource:
    // system (both dropped by the transcript parser) or folded into a tool_result
    // record, so ECHO_ID_RE never sees the id and the sweep would re-inject past
    // the echo window = duplicate. The turn boundary is the RELIABLE backstop:
    // no text matching, and it cannot duplicate. Transcript-echo stays the ~1s
    // fast path. This runs BEFORE deliverBatch (which stamps injected_at=now on
    // fresh pushes), so any injected_at present here is from a PRIOR turn — never
    // one we push in this same idle. Pointer/pull-path rows are excluded (an
    // inbox READ confirms those, not a turn boundary), and only rows pushed to
    // THIS session (deliveredTo match) are confirmed — never a sibling session's
    // in-flight push. An ERRORED turn (API 529 &c) did NOT complete — it may not
    // have consumed its injected rows — and errored→idle still fires here, so gate
    // the confirm on a clean turn: an errored turn leaves the rows queued and the
    // sweep re-queues them for a retry [coordinator caution POD-833].
    if (opts?.priorPhase !== 'errored') {
      const targets: DeliveryTarget[] = [{ kind: 'session', id: session.sessionId }]
      if (issueId) targets.push({ kind: 'issue', id: issueId })
      for (const target of targets) {
        let after: MessagePageCursor | undefined
        while (true) {
          const page = this.deps.messages.pendingForPage(target, {
            ...(after ? { after } : {}),
            limit: DELIVERY_TARGET_PAGE_LIMIT,
          })
          for (const message of page) {
            if (!message.injectedAt || message.deliveredTo !== session.sessionId) continue
            if (this.deliveryMode(message) === 'pointer') continue
            this.markDelivered(message, session.sessionId, 'boundary')
          }
          if (page.length < DELIVERY_TARGET_PAGE_LIMIT) break
          after = cursorOf(page.at(-1)!)
        }
      }
    }
    // Clear the finished turn's hop context AFTER the confirm loop: markDelivered
    // re-stamps turnHop (right for the echo path, which fires DURING the
    // processing turn), but at a turn boundary that turn is over — anything the
    // session sends next belongs to a fresh turn and must not inherit the hop.
    // deliverBatch below re-stamps turnHop for genuinely new pushes, which is
    // correct (those trigger the session's NEXT turn).
    this.turnHop.delete(session.sessionId)
    // Idle is one eligibility transition among bind/resume/membership/startup:
    // enqueue the same durable target keys and synchronously flush so existing
    // turn-boundary ordering remains exact. The keyed gate handles confirmation,
    // draft holds, FIFO/pointer batching, cooldown, and duplicate events.
    this.onSessionEligibilityChanged(session.sessionId, session, {
      preferThisIdleSession: true,
    })
    do {
      this.flushDeliveryTriggers()
      // A live idle boundary is a one-shot eligibility edge. Consume every
      // bounded keyset continuation carrying that preferred session before the
      // first injection can start its next turn and make the snapshot stale.
    } while (
      [...this.pendingDeliveryTargets.values()].some(
        (work) => work.preferred?.sessionId === session.sessionId,
      )
    )
  }

  /** Composer-draft delivery guard [spec:SP-d716] [POD-865]: true while the session's human
   *  has a non-empty composer/native-prompt draft (`draftUpdatedAt` present ⇔
   *  non-empty text; cleared immediately on empty/submit). While true, nothing
   *  is injected into the session's PTY — any urgency, any transport. */
  private draftHoldActive(target: SessionMeta): boolean {
    return target.draftUpdatedAt !== undefined
  }

  /** A queued row already pushed and awaiting its own confirmation must not be
   *  re-delivered [POD-834]: a pointer nudge waits for the inbox read (never
   *  re-nudged); an echo-mode push waits for its transcript echo until the window
   *  passes (after which the sweep re-pushes it as a lost push). */
  private awaitingConfirmation(m: MessageRow, nowMs: number): boolean {
    if (!m.injectedAt) return false
    if (this.deliveryMode(m) === 'pointer') return true
    return nowMs - Date.parse(m.injectedAt) < ECHO_CONFIRM_WINDOW_MS
  }

  /** Shared idempotency/cooldown gate for every event-triggered or sweep retry.
   *  Duplicate eligibility events cannot re-push an injected row, and a queued
   *  wake gets a one-shot retry at the exact durable cooldown boundary. */
  private prepareQueuedAttempt(message: MessageRow, nowMs: number): boolean {
    if (message.toKind === 'operator') return false
    if (message.injectedAt) {
      if (this.awaitingConfirmation(message, nowMs)) return false
      const requeues = this.requeueCounts.get(message.id) ?? 0
      if (requeues >= MAX_ECHO_REQUEUES && message.deliveredTo) {
        this.emitTransition(message, 'message.echo_capped')
        this.markDelivered(message, message.deliveredTo, 'injection')
        return false
      }
      if (this.deps.messages.clearInjected(message.id)) {
        this.requeueCounts.set(message.id, requeues + 1)
        this.emitTransition(message, 'message.requeued')
      }
    }
    if (message.lifecycle === 'wake' && message.fromKind !== 'operator') {
      const key = this.wakeKeyOfRow(message)
      if (this.wakeCooldownHot(key)) {
        this.scheduleWakeCooldown(key, message)
        return false
      }
    }
    return true
  }

  /** If an attempted wake remains durable and un-injected, arm its next allowed
   *  attempt. Successful queue/spawn paths carry injectedAt and need no timer. */
  private scheduleQueuedWakeRetry(message: MessageRow): void {
    if (message.lifecycle !== 'wake' || message.fromKind === 'operator') return
    const current = this.deps.messages.getMessage(message.id)
    if (!current || current.status !== 'queued' || current.injectedAt) return
    const key = this.wakeKeyOfRow(current)
    if (this.wakeCooldownHot(key)) this.scheduleWakeCooldown(key, current)
  }

  /** Slow sweep: expire what has expired, then re-attempt every queued row
   *  (delivery is state-resolved, so this is idempotent and cheap). */
  sweep(): void {
    const now = this.deps.now()
    const waitImplicitCutoff = new Date(Date.parse(now) - QUEUED_WAIT_TTL_MS).toISOString()
    for (const expired of this.deps.messages.expireQueued(now, { waitImplicitCutoff })) {
      this.emitTransition(expired, 'message.expired')
    }
    if (this.retryBackstopTimer) return
    this.retryBackstopCursor = null
    this.retryPassStartedAt = Date.parse(now)
    this.runRetryBackstopPage()
  }

  private runRetryBackstopPage(after?: MessagePageCursor): void {
    this.retryBackstopTimer = null
    let page: MessageRow[]
    try {
      page = this.deps.messages.listQueuedPage({
        ...(after ? { after } : {}),
        limit: DELIVERY_RETRY_BACKSTOP_LIMIT,
      })
    } catch (error) {
      this.recordTriggerFailure('retry page query', error)
      this.retryBackstopCursor = null
      this.retryPassStartedAt = null
      return
    }

    const all = this.deps.sessions().listSessions()
    const nowMs = this.nowMs()
    for (const message of page) {
      if (!this.prepareQueuedAttemptSafely(message, nowMs)) continue
      try {
        this.attemptDelivery(message, all, { viaSweep: true })
        this.scheduleQueuedWakeRetry(message)
      } catch (error) {
        this.recordTriggerFailure(`retry message ${message.id}`, error)
      }
    }
    this.retryPagesProcessed += 1

    if (page.length < DELIVERY_RETRY_BACKSTOP_LIMIT) {
      this.retryBackstopCursor = null
      this.retryPassStartedAt = null
      return
    }
    const next = cursorOf(page.at(-1)!)
    this.retryBackstopCursor = next
    this.retryBackstopTimer = setTimeout(() => this.runRetryBackstopPage(next), 0)
    this.retryBackstopTimer.unref?.()
  }

  /** Deliver a pending batch into an idle session. Inline rows go FIFO; fyi
   *  issue-addressed rows past one coalesce into a single pointer
   *  ("N messages from X, Y — run 'podium issue mail inbox'"). */
  private deliverBatch(session: SessionMeta, batch: MessageRow[]): void {
    const sessions = this.deps.sessions()
    // Self-delivery suppression [spec:SP-a4ba] (§09-H, POD-836): the idle drain pulls this
    // session's issue-pending rows, which can include a note it sent to its own
    // issue while another member was busy — never deliver those back to the
    // sender. They stay queued for their real recipient's own idle drain.
    const rows = batch.filter((m) => m.fromSession !== session.sessionId)
    if (rows.length === 0) return
    const pointerRows = rows.filter(
      (m) => m.toKind === 'issue' && (m.urgency === 'fyi' || m.body.length > INLINE_BODY_MAX),
    )
    const inlineRows = rows.filter((m) => !pointerRows.includes(m))
    for (const m of inlineRows) {
      const r = sessions.sendText({
        sessionId: session.sessionId,
        text: this.renderFor(m, session.sessionId),
      })
      if (r.ok) this.recordPush(m, session.sessionId)
    }
    if (pointerRows.length === 1 && pointerRows[0]!.body.length <= INLINE_BODY_MAX) {
      // One short fyi delivers inline with its full envelope (id present) — the
      // echo can still confirm it; record a push and let the echo/read follow.
      const m = pointerRows[0]!
      const r = sessions.sendText({
        sessionId: session.sessionId,
        text: this.renderFor(m, session.sessionId),
      })
      if (r.ok) this.recordPush(m, session.sessionId)
    } else if (pointerRows.length > 0) {
      // Coalesced nudge: the bodies (and ids) are NOT in the transcript, so these
      // can only be confirmed by an inbox READ. Record the push (injected) and
      // wait — the sweep never re-nudges a pointer row [POD-834].
      const r = sessions.sendText({
        sessionId: session.sessionId,
        text: this.pointerText(pointerRows),
      })
      if (r.ok) for (const m of pointerRows) this.markInjected(m, session.sessionId)
    }
  }

  /** Record an INLINE push whose body (and id) went into the transcript: an
   *  unwrapped operator body can never echo and a best-effort ack/notification is
   *  never chased, so both are confirmed now; everything else is injected and
   *  awaits its echo (or its turn boundary) [POD-834, POD-853]. */
  private recordPush(message: MessageRow, sessionId: string): void {
    if (this.confirmedOnInjection(message)) this.markDelivered(message, sessionId, 'injection')
    else this.markInjected(message, sessionId)
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
    return this.send(from, {
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
   * The stop-hook's single-reminder set: delivered-but-unfulfilled messages that
   * REQUESTED a response [POD-835 §04b] (expects_response — the store gates it;
   * urgency no longer decides, since a `--expect-response fyi` note still owes a
   * reply), never reminded about before. Marking happens here — each message earns
   * exactly ONE reminder, persisted, then the steward fallback owns it. Returns
   * render-ready rows for the daemon's block reason.
   */
  pendingReminders(sessionId: string): { id: string; from: string; body: string }[] {
    const at = this.deps.now()
    const out: { id: string; from: string; body: string }[] = []
    for (const m of this.deps.messages.listDeliveredUnacked(sessionId, at)) {
      if (!this.deps.messages.markReminded(m.id, at)) continue
      out.push({ id: m.id, from: this.fromLabel(m), body: m.body })
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
    sessionId: string,
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
    const r = this.send(from, input)
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
    opts?: { consume?: string | null; limit?: number },
  ): MessageRow[] {
    const rows = this.inbox(principals, opts?.limit !== undefined ? { limit: opts.limit } : {})
    if (opts?.consume === undefined) return rows
    const at = this.deps.now()
    return rows.map((m) => {
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
      this.emitTransition(read, 'message.read')
      return read
    })
  }

  /** Explicitly clear one recipient-owned message without opening the inbox.
   * Reuses `read`, the existing cleared terminal state [spec:SP-ba61]. */
  dismiss(messageId: string, consume: string | null): MessageRow {
    const message = this.deps.messages.getMessage(messageId)
    if (!message) throw new Error('unknown message ' + messageId)
    const at = this.deps.now()
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
      this.emitTransition(dismissed, 'message.read')
    }
    this.retireNotificationFact(message, at)
    return dismissed
  }

  private retireNotificationFact(message: MessageRow, at: string): void {
    if (!message.factKey || !message.factTarget) return
    this.notificationArbiter.retire(message.factKey, message.factTarget, at)
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

  /** Whether `from` is the same principal that sent `original` — guards
   *  semantic-reply-as-ack [POD-835] so a requester can never satisfy its OWN
   *  requested response (only the other party's reply fulfils it). */
  private sameSenderAs(from: MessageSender, original: MessageRow): boolean {
    return this.senderKey(from) === this.senderKeyOfRow(original)
  }

  /** Whether `from` is the party the `original` was addressed to — the ONLY
   *  principal whose reply fulfils a requested response [spec:SP-bf44]. A
   *  session-addressed original is answered by that session (or whichever session
   *  it was actually pushed to, `delivered_to` — covers a resumed/spawned target);
   *  an issue-addressed one by any member of that issue (or the delivered session);
   *  an operator-addressed one by the operator. Excludes system/steward and any
   *  third party, so the settle-nag can never stamp its own target's request. */
  private isRecipientOf(from: MessageSender, original: MessageRow): boolean {
    if (original.toKind === 'operator') return from.kind === 'operator'
    if (from.kind !== 'agent') return false
    if (original.toKind === 'session') {
      return (
        from.sessionId !== undefined &&
        (from.sessionId === original.toId || from.sessionId === original.deliveredTo)
      )
    }
    // issue-addressed: a member of the issue, or the session it was delivered to.
    return (
      (from.issueId !== undefined && from.issueId === original.toId) ||
      (from.sessionId !== undefined &&
        original.deliveredTo !== null &&
        from.sessionId === original.deliveredTo)
    )
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
    if (last !== undefined) return last > cutoff
    const attemptedAt = this.deps.messages.getWakeCooldown(key)
    const parsed = attemptedAt ? Date.parse(attemptedAt) : 0
    const derived = Number.isFinite(parsed) ? parsed : 0
    this.lastWakeAt.set(key, derived)
    return derived > cutoff
  }

  /** Arm one timer for every queued target sharing a sender+issue cooldown key.
   *  The deadline comes from lastWakeAt, whose cold-path value is reconstructed
   *  from durable message rows, so reconcileQueued() restores this after restart. */
  private scheduleWakeCooldown(key: string, message: MessageRow): void {
    const target = this.deliveryTargetOf(message)
    if (!target) return
    const last = this.lastWakeAt.get(key)
    if (last === undefined) return
    const deadline = last + WAKE_COOLDOWN_MS
    const existing = this.wakeCooldownTimers.get(key)
    if (existing && existing.deadline === deadline) {
      existing.targets.set(deliveryTargetKey(target), target)
      return
    }
    if (existing) clearTimeout(existing.timer)
    const targets = existing?.targets ?? new Map<string, DeliveryTarget>()
    targets.set(deliveryTargetKey(target), target)
    const timer = setTimeout(
      () => {
        const pending = this.wakeCooldownTimers.get(key)
        if (!pending || pending.deadline !== deadline) return
        this.wakeCooldownTimers.delete(key)
        for (const retryTarget of pending.targets.values()) {
          this.queueDeliveryTarget(retryTarget)
        }
      },
      Math.max(1, deadline - this.nowMs()),
    )
    timer.unref?.()
    this.wakeCooldownTimers.set(key, { deadline, timer, targets })
  }

  private recordWake(message: MessageRow, target: SessionMeta | undefined): void {
    if (message.fromKind === 'operator') return
    const issueKey = message.toKind === 'issue' ? message.toId : this.issueForSession(target)
    this.recordWakeKey(`${this.senderKeyOfRow(message)}|${issueKey ?? message.toId ?? ''}`)
  }

  /** Durable write happens before queueText/spawn, so a crash or transport
   * failure cannot erase the cooldown attempt. */
  private recordWakeKey(key: string): void {
    const attemptedAt = this.deps.now()
    this.deps.messages.recordWakeCooldown(key, attemptedAt)
    const parsed = Date.parse(attemptedAt)
    this.lastWakeAt.set(key, Number.isFinite(parsed) ? parsed : this.nowMs())
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
        const issue = this.deps.issues().getMeta(message.fromIssue)
        return issue ? `issue:#${issue.seq}` : message.fromIssue
      }
      if (message.fromSession) return `session:${message.fromSession}`
      return 'agent'
    }
    if (message.fromKind === 'system')
      return `system${message.fromName ? `:${message.fromName}` : ''}`
    return message.fromKind // superagent
  }

  private toLabel(message: MessageRow): string {
    if (message.toKind === 'issue') {
      const issue = this.deps.issues().getMeta(message.toId ?? '')
      return issue ? `your issue #${issue.seq}` : `your issue ${message.toId}`
    }
    if (message.toKind === 'session') return 'your session'
    return 'the operator'
  }

  /** How a message reaches the agent, deciding how (and whether) its delivery is
   *  confirmed [POD-834]. Kept in lockstep with `deliverBatch`'s pointer filter
   *  and `renderFor`: an issue-addressed fyi / oversized body is a pull-path
   *  nudge (confirmed by an inbox read); an operator's byte-faithful body carries
   *  no id and is confirmed on injection; everything else echoes back its id. */
  private deliveryMode(message: MessageRow): DeliveryMode {
    if (
      message.toKind === 'issue' &&
      (message.urgency === 'fyi' || message.body.length > INLINE_BODY_MAX)
    ) {
      return 'pointer'
    }
    if (message.fromKind === 'operator' && message.kind !== 'question') return 'unwrapped'
    return 'echo'
  }

  /** A message whose push into the PTY is itself the confirmation — no transcript
   *  echo is awaited and the sweep never re-injects it [POD-853]. Two cases: an
   *  unwrapped operator body (no id to echo), and a best-effort ack/notification.
   *  Pointer/pull-path rows are NOT confirmed on injection (an inbox read confirms
   *  those), so best-effort applies only to inline echo-mode rows. */
  private confirmedOnInjection(message: MessageRow): boolean {
    const mode = this.deliveryMode(message)
    return mode === 'unwrapped' || (mode === 'echo' && this.isBestEffort(message))
  }

  /** Fire-and-forget kinds [POD-853, spec:SP-34d7 acks & notifications]: an ack is
   *  never itself acked and its ack-confirms-original side effect fires at send
   *  time regardless; a steward/subscription notification never expects an ack.
   *  Chasing their transcript echo only risks the mid-turn re-inject loop, so they
   *  are delivered once (injection = confirmation) and never auto-requeued. */
  private isBestEffort(message: MessageRow): boolean {
    return message.kind === 'ack' || message.kind === 'notification'
  }

  /** Record a push toward a live PTY without claiming the agent saw it: stamps
   *  injected_at + delivered_to, keeps status `queued` [POD-834]. The transcript
   *  echo (`markDelivered`) or an inbox read (`markRead`) makes the honest claim
   *  later; the sweep re-pushes an echo-mode row whose echo never came. */
  private markInjected(message: MessageRow, sessionId: string): void {
    const at = this.deps.now()
    if (this.deps.messages.markInjected(message.id, sessionId, at)) {
      // The injected message triggers the receiver's next turn — anything it
      // sends within that turn chains at hop + 1 (cleared when it goes idle).
      this.turnHop.set(sessionId, message.hop)
      this.emitTransition(
        { ...message, deliveredTo: sessionId, injectedAt: at },
        'message.injected',
      )
    }
  }

  /** queued → delivered: the PUSH is confirmed [POD-834]. `via` records HOW it was
   *  confirmed so the ledger can tell an echo-confirmed row from one confirmed at a
   *  turn boundary / on injection / by an ack — invaluable when debugging delivery
   *  [POD-853]: 'echo' (transcript), 'boundary' (turn ended), 'injection' (unwrapped
   *  or best-effort — the push IS the confirmation), 'ack' (an ack proves the
   *  original was received). */
  private markDelivered(
    message: MessageRow,
    sessionId: string,
    via: 'echo' | 'boundary' | 'injection' | 'ack',
  ): void {
    const at = this.deps.now()
    this.requeueCounts.delete(message.id)
    if (this.deps.messages.markDelivered(message.id, sessionId, at)) {
      // Delivery consumes the legacy issue_messages mirror row too, or
      // mailPending's legacy fallback keeps the stop-hook nagging ("You have
      // mail") until the agent runs `podium issue mail inbox`.
      if (message.toKind === 'issue' && message.toId) {
        try {
          this.deps.mirrorMarkIssueMailRead?.(message.toId, [message.id])
        } catch {}
      }
      this.turnHop.set(sessionId, message.hop)
      this.emitTransition(
        { ...message, status: 'delivered', deliveredAt: at, deliveredTo: sessionId },
        'message.delivered',
        { confirmedVia: via },
      )
    }
  }

  /** Self-delivery suppression [spec:SP-a4ba] (§09-H, POD-836): a message whose only resolved
   *  recipient is its own sender is consumed straight to the ledger —
   *  delivered-to-nobody, legacy mirror marked read — so it never re-surfaces
   *  via the sweep or the stop-hook, while the row stays visible in inbox
   *  history. "The sender already knows it sent it." Reports `delivered` to the
   *  sender [POD-834]: it is recorded, not dropped — there is no one else to reach. */
  private suppressSelf(message: MessageRow): DeliveryOutcome {
    const at = this.deps.now()
    if (this.deps.messages.markDelivered(message.id, null, at)) {
      if (message.toKind === 'issue' && message.toId) {
        try {
          this.deps.mirrorMarkIssueMailRead?.(message.toId, [message.id])
        } catch {}
      }
      this.emitTransition(
        { ...message, status: 'delivered', deliveredAt: at, deliveredTo: null },
        'message.self_suppressed',
      )
    }
    return { ok: true, queued: false, disposition: 'delivered' }
  }

  /**
   * Transcript-echo confirmation [POD-834 §04d]: the daemon tails each session's
   * transcript and streams new turns up as `transcript.delta`. A message the
   * substrate typed into a PTY reappears as a user turn carrying its server-
   * rendered `[podium message <id> …]` frame — seeing that id echoed back is
   * proof the agent has it in context, so the row flips queued → delivered.
   * Best-effort and idempotent: a late/duplicate echo is a no-op (markDelivered
   * is guarded on status='queued').
   */
  onTranscriptDelta(sessionId: string, items: { role?: string; text?: string }[]): void {
    for (const item of items) {
      // Only a user turn echoes a pasted prompt; assistant/tool text quoting the
      // id must never self-confirm a message the agent merely referenced.
      if (item.role !== 'user' || !item.text) continue
      ECHO_ID_RE.lastIndex = 0
      for (const m of item.text.matchAll(ECHO_ID_RE)) {
        const id = m[1]
        if (!id) continue
        const row = this.deps.messages.getMessage(id)
        if (!row || row.status !== 'queued') continue
        // Confirm ONLY a push WE made to THIS session. A row we never injected
        // (injectedAt null — e.g. a HELD issue message with no live session, or
        // one waiting for a boundary) has deliveredTo null; some OTHER session's
        // transcript merely quoting its id (an operator pasting it into a
        // different agent) must NOT flip it delivered-to-the-wrong-place and
        // silently strand the real target — the exact silent-drop class this
        // branch kills [POD-834 review]. injectedAt always co-sets deliveredTo,
        // so requiring the push target to match closes the loophole.
        if (!row.injectedAt || row.deliveredTo !== sessionId) continue
        this.markDelivered(row, sessionId, 'echo')
      }
    }
  }

  /** Dead-letter a message whose target was gone [POD-834 §05]: mark it terminal,
   *  ledger the transition, and — for a row discovered gone LATER (sweep), when
   *  the sender isn't watching a synchronous return — tell the sender once. A
   *  send-time dead-letter skips the notice (the sender gets the outcome inline).
   *  Returns the `dead_letter` disposition for the delivery path. */
  private deadLetter(
    message: MessageRow,
    reason: string,
    opts?: { notifySender?: boolean },
  ): DeliveryOutcome {
    const at = this.deps.now()
    const first = this.deps.messages.markDeadLetter(message.id, at)
    if (first) {
      this.emitTransition(
        { ...message, status: 'dead_letter', deadLetteredAt: at },
        'message.dead_letter',
      )
      if (opts?.notifySender) this.notifyDeadLetter(message, reason)
    }
    return { ok: false, reason: `dead-lettered: ${reason}`, disposition: 'dead_letter' }
  }

  /** Tell the sender, exactly once, that their message could not be delivered —
   *  routed back to the sender principal like a reply. Never for a system/steward
   *  sender (no one to tell, and it would loop). */
  private notifyDeadLetter(message: MessageRow, reason: string): void {
    if (message.fromKind === 'system') return
    const to = this.replyTarget(message)
    try {
      this.send(
        { kind: 'system', name: 'steward' },
        {
          to,
          kind: 'notification',
          urgency: 'next-turn',
          lifecycle: 'wait',
          body:
            `Your message ${message.id} could not be delivered — ${reason}. ` +
            `It was dead-lettered (not dropped); it stays readable in the ledger.`,
        },
      )
    } catch {}
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
          const issue = this.deps.issues().getMeta(from.issueId)
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
