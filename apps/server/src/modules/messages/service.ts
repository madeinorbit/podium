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

import { isSpawnedBy } from '@podium/model'
import { randomUUID } from 'node:crypto'
import {
  exemptFromBrakes,
  type MailSenderPrincipal,
  type PlacementDecision,
  senderBrakeKey,
} from '@podium/commands'
import {
  type AgentPhase,
  type Attribution,
  actorAgent,
  actorSystem,
  actorUser,
  asAgentIdentityId,
  asIssueId,
  FIRST_ADMIN_USER_ID,
  type IssueScope,
  type SessionId,
  type SessionMeta,
} from '@podium/model'
import { asDelegationRef } from '@podium/protocol'
import type { CommandPrincipal } from '../../command-principal'
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
import type { InboxPrincipalReference } from '../sessions/inbox'
import { DeliveryBrakes, SPAWN_BUDGET_PER_DAY } from './brakes'
import { MessageMailbox } from './mailbox'
import { INLINE_BODY_MAX, MessageRenderer, principalOfRow } from './render'
import { type DeliveryRunner, DeliveryScheduler, type MessageDeliveryStats } from './scheduler'
import type { MessageSender, MessageSendInput, MessageSendResult, SendDisposition } from './types'

export { INTERRUPT_DELIVERY_CEILING_MS, NEXT_TURN_DELIVERY_BUDGET_MS } from './mailbox'

export type {
  MessageSender,
  MessageSenderIdentity,
  MessageSendInput,
  MessageSendResult,
  SendDisposition,
} from './types'

import {
  cursorOf,
  DELIVERY_TARGET_PAGE_LIMIT,
  type DeliveryTarget,
  deliveryTargetKey,
} from './targets'

/** Chain depth past which lifecycle clamps to wait (brake 3). */
export const HOP_LIMIT = 5
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

/**
 * The L1 principal projection of a sender, for the policy functions in
 * `@podium/commands`.
 *
 * `user` is `null` on BOTH sides on purpose. The re-keyed brake bucket
 * (`operator:<user>`) needs the human at the root of the delegation chain, and a
 * `MessageRow` has no column to hold one until POD-1075 lands the User
 * aggregate. Stamping the sender side alone would be worse than not stamping it:
 * `senderKey(from)` is compared against `senderKeyOfRow(row)` by the cooldown and
 * by the same-sender guard, so an asymmetric key silently disables both. So the
 * POLICY lands here as one function with its per-user behaviour tested at L1, and
 * the value arrives with the column.
 */
const principalOf = (from: MessageSender): MailSenderPrincipal =>
  ({ ...from, user: from.attribution?.onBehalfOf ?? null }) as MailSenderPrincipal

/** attemptDelivery's result: the transport outcome plus the sender-facing
 *  disposition [POD-834]. */
interface DeliveryOutcome {
  ok: boolean
  queued?: boolean
  reason?: string
  disposition: SendDisposition
}

/** Spawn-on-unresumable-wake seam [spec:SP-34d7 decision 4]. Actual agent
 *  spawning is wired in a later stage (TODO: wire to SessionLifecycle.spawn with
 *  the message as the first prompt after prime); the default (absent) marks the
 *  ledger and surfaces needs-attention instead. */
export interface SpawnOnWake {
  spawn(input: { issueId: string | null; message: MessageRow }): {
    ok: boolean
    sessionId?: SessionId
    reason?: string
  }
}

interface InboxDeliveryInput {
  sessionId: SessionId
  text: string
  inputOrigin?: 'mail'
  principal: InboxPrincipalReference
  sourceMessageId: string
}

export interface MessageDeliveryDeps {
  messages: MessagesRepository
  notificationFacts: NotificationFactsRepository
  events: EventsRepository
  issues: IssueService
  sessions: {
    listSessions(): SessionMeta[]
    sendText(input: InboxDeliveryInput): {
      ok: boolean
      queued?: boolean
      reason?: string
    }
    queueText(input: InboxDeliveryInput): {
      ok: boolean
      queued?: boolean
      reason?: string
    }
    /** ESC + queue-as-next-turn (#237 hard interrupt). */
    interruptText(input: InboxDeliveryInput): {
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
  /**
   * APPLY-TIME RE-AUTHORIZATION (ADR 3 D8 / Amendment 1 D16, POD-728).
   *
   * Mail is durable-queued: a row accepted while its sender was authorized can
   * sit in the queue until the recipient wakes, and by then the sender's rights
   * may have changed. D8 re-authorizes on every apply, and under readiness
   * §3.1.3 A1 that means RE-RESOLVING the delegation chain live rather than
   * reading a capability snapshotted at accept — which is the whole reason the
   * snapshot was refused.
   *
   * Called on every delivery attempt (the synchronous one at send, and every
   * sweep pass thereafter), plus once before the legacy mirror write. A refusal
   * DEAD-LETTERS the row with the returned reason: never silently dropped
   * (ADR 3 D9), never applied. Found at send time it returns synchronously to
   * the watching sender; found later it notifies the sender once, which is what
   * "surfaced to its sender" means.
   *
   * The reason string is the port's to choose, and the choice is policy:
   *  - a sender who NEVER had access must get a reason indistinguishable from
   *    "no such issue" (Amendment 1 D20.2 — otherwise the queue is an existence
   *    oracle one step removed);
   *  - a sender whose access was REVOKED mid-queue may be told so, because they
   *    already knew the target existed and nothing new leaks.
   *
   * Absent (single-user today, and in partial test harnesses) = allow. That is
   * the honest statement of the current fact rather than a disabled check: with
   * one human there is nothing to revoke. POD-1075/POD-1079 wire the real port.
   */
  authorizeAtApply?(message: MessageRow): { ok: true } | { ok: false; reason: string }
  /**
   * WAKE-PATH MACHINE USE (POD-1193 / readiness §3.1.4 M2).
   *
   * A wake resumes a parked session or spawns one — code execution on the
   * TARGET SESSION's (or, for bare spawn-on-wake, the issue's) machine. The
   * contracts declare `machineVerb: 'use'`; this port is the runtime refusal
   * that declaration alone did not provide.
   *
   * Called only on the wake path (parked + lifecycle wake, or unresumable →
   * trySpawn), never for inject into an already-live PTY. Returns the same
   * {@link PlacementDecision} `placementDecision` produces so the composition
   * root can reuse the gate's MachineAccess without a second ACL.
   *
   * ERROR RULE (mail.send / mail.ask, D20.2): unauthorized and unreachable
   * collapse into ONE denial — the caller named a session or issue, not a
   * machine, so machine-specific wording would be an existence oracle over
   * someone else's fleet. spawnAgent keeps M5 (distinguishable) on its own
   * handler path; do not collapse those.
   *
   * Absent = allow. Same honest single-user default as authorizeAtApply.
   */
  placementAtWake?(message: MessageRow, machineId: string): PlacementDecision
  now(): string
}

/**
 * Wake placement refused under the mail error rule (D20.2): unauthorized and
 * unreachable are the SAME reason, and the reason names neither a machine nor
 * a grant. The address oracle for issues/sessions is a different axis; this
 * string only covers the machine half of a wake.
 */
export const WAKE_PLACEMENT_DENIED_REASON = 'target is not available'

/** Derive the sender principal from an authz capability (the relay/registry
 *  caller identity). ONLY the unconstrained scope ('all') is the operator —
 *  "unwrapped = the human" is an invariant the receiver's prime rules trust,
 *  so an issueless agent session (scope 'none' + actorSessionId) must stamp
 *  as an agent (enveloped, peer-clamped, cooldown-subject), never operator.
 *  Server-side only — the mailIdentity() pattern, structured. */
export function senderFromCapability(capability: {
  // COMPOSED, was a restated `{ kind: string; rootId?: string }` (POD-362): the
  // local shape re-erased the brands `IssueScope` carries.
  scope: IssueScope
  actorSessionId?: SessionId
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
/** Stamp both attribution halves from the resolved transport principal. */
export function senderFromPrincipal(principal: CommandPrincipal): MessageSender {
  if (principal.kind === 'user') {
    return {
      kind: 'operator',
      attribution: { actor: actorUser(principal.user), onBehalfOf: principal.user },
      delegationRef: null,
    }
  }
  if (principal.kind === 'system') {
    return {
      kind: 'system',
      name: principal.job,
      attribution: { actor: actorSystem(principal.job), onBehalfOf: null },
      delegationRef: null,
    }
  }
  return {
    ...senderFromCapability(principal.capability),
    attribution: {
      actor: actorAgent(asAgentIdentityId(principal.agentSessionId)),
      onBehalfOf: principal.onBehalfOf,
    },
    delegationRef: principal.agentSessionId,
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
  /** Lost-echo requeues per message id [POD-853 stopgap]; in-memory is fine —
   *  a restart resets the count and the row simply earns its cap again. */
  private readonly requeueCounts = new Map<string, number>()
  /** needs-attention already emitted per `${messageId}|${reason}` — the sweep
   *  re-attempts every 60s and must not spam the event log / notify path. */
  private readonly attentionEmitted = new Set<string>()

  private readonly notificationArbiter: NotificationArbiter
  /** Envelope/pointer rendering and the confirmation mode that follows from it
   *  (POD-1397). Holds no state; owned rather than injected because its deps are
   *  a narrowing of this service's own. */
  private readonly render: MessageRenderer
  /** Containment brakes 1 (wake cooldown) and 2 (spawn budget) — POD-1397.
   *  Owns their state and their timers outright; this service supplies only the
   *  keys it is the one able to resolve, and disposes it. */
  private readonly brakes: DeliveryBrakes
  /** WHEN a delivery is attempted — the coalesced trigger queue, the boot
   *  reconcile walk and the slow retry backstop, with the eleven fields that
   *  answer for them and all three of their timers (POD-1397). */
  private readonly scheduler: DeliveryScheduler
  /** The PULL path: replies, acks, inbox reads, dismissals and the bounded
   *  waits a sender uses to learn what became of its send (POD-1397). */
  private readonly mailbox: MessageMailbox

  constructor(private readonly deps: MessageDeliveryDeps) {
    this.notificationArbiter = new NotificationArbiter(deps.notificationFacts, deps.now)
    this.brakes = new DeliveryBrakes({
      messages: deps.messages,
      events: deps.events,
      now: deps.now,
      onCooldownElapsed: (targets) => {
        for (const target of targets) this.queueDeliveryTarget(target)
      },
    })
    this.scheduler = new DeliveryScheduler({
      messages: deps.messages,
      now: deps.now,
      runner: this.deliveryRunner(),
    })
    this.mailbox = new MessageMailbox({
      messages: deps.messages,
      issues: deps.issues,
      notificationArbiter: this.notificationArbiter,
      listSessions: () => deps.sessions.listSessions(),
      now: deps.now,
      ...(deps.mirrorMarkIssueMailRead
        ? {
            mirrorMarkIssueMailRead: (issueId: string, ids: string[]) =>
              deps.mirrorMarkIssueMailRead?.(issueId, ids),
          }
        : {}),
      send: (from, input) => this.send(from, input),
      emitTransition: (message, kind, extra) => this.emitTransition(message, kind, extra),
      fromLabel: (message) => this.render.fromLabel(message),
    })
    this.render = new MessageRenderer({
      issues: deps.issues,
      listSessions: () => deps.sessions.listSessions(),
      ...(deps.machineName ? { machineName: (id: string) => deps.machineName!(id) } : {}),
    })
  }

  /** The exact text a receiver would see — the delivery service's own view of
   *  its renderer, kept public because callers ask this service, not its parts. */
  renderFor(message: MessageRow, receiverSessionId?: string): string {
    return this.render.renderFor(message, receiverSessionId)
  }

  /** Last resolved issue per session. This is the before-state needed for detach,
   * reassignment, inferred-cwd movement, and remove events. */
  private readonly sessionIssueTargets = new Map<string, string>()

  /** Queue the session principal plus both sides of its issue-resolution change. */
  onSessionEligibilityChanged(
    sessionId: SessionId,
    changed?: SessionMeta,
    opts?: {
      preferThisIdleSession?: boolean
      boundaryThrough?: ReadonlyMap<string, MessagePageCursor>
    },
  ): void {
    const session =
      changed ??
      this.deps.sessions
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
    const queue = (target: DeliveryTarget, targetPreferred?: SessionMeta) =>
      this.queueDeliveryTarget(
        target,
        targetPreferred,
        undefined,
        opts?.boundaryThrough?.get(deliveryTargetKey(target)),
      )
    queue({ kind: 'session', id: sessionId }, preferred)
    if (previousIssueId && previousIssueId !== nextIssueId) {
      queue({ kind: 'issue', id: previousIssueId })
    }
    // Session-addressed mail above is preferred to this session unconditionally —
    // it names this session. ISSUE-addressed mail does not, and routing already
    // chose a recipient for it by ROLE [POD-1365]. Handing the issue's pending
    // rows to whichever member happens to reach a turn boundary first DISCARDS
    // that decision, and it is not a race the coordinator merely loses sometimes:
    // a fan-out coordinator is mid-turn by definition, so it queues (no recipient
    // recorded) and a peer that idles often takes it every time. Measured on
    // POD-279: three consecutive sends to the same wrong session while the
    // coordinator was set and live.
    if (nextIssueId) {
      queue({ kind: 'issue', id: nextIssueId }, this.mayDrainIssueMail(nextIssueId, preferred))
    }
  }

  /** Whether `session` may take an issue's pending mail at its turn boundary
   *  [POD-1365] [POD-1371]. The coordinator owns its issue's mail by ROLE while
   *  it still exists as a non-exited member: peers hold, and the row waits for
   *  the coordinator's OWN next boundary (or a lifecycle=wake send that routes
   *  through the parked wake path). Deliberate second-order choice: ownership
   *  survives hibernation — a resting fan-out lead must not lose mail to a live
   *  worker. Only when the coordinator is gone or exited may any member drain,
   *  so a departed coordinator can never strand its issue's mail. Undefined
   *  preference = no preference, which is the caller's "let attemptDelivery
   *  decide" path. */
  private mayDrainIssueMail(issueId: string, session?: SessionMeta): SessionMeta | undefined {
    if (!session) return undefined
    const coordinatorId = this.deps.issues().get(issueId)?.coordinatorSessionId
    if (typeof coordinatorId !== 'string' || coordinatorId === session.sessionId) return session
    const coordinatorOwns = this.deps
      .sessions()
      .listSessions()
      .some(
        (s) =>
          s.sessionId === coordinatorId &&
          s.agentKind !== 'shell' &&
          s.status !== 'exited',
      )
    return coordinatorOwns ? undefined : session
  }

  /** Issue-side target changes can alter inferred session membership and the
   * cooldown key of session-addressed wakes. Recompute affected sessions and
   * queue their principals plus both old/new issues. */
  onIssueEligibilityChanged(issueId: string): void {
    this.queueDeliveryTarget({ kind: 'issue', id: issueId })
    for (const session of this.deps.sessions.listSessions()) {
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

  /**
   * The delivery reasoning the scheduler calls back through. Built once, in the
   * constructor: the scheduler decides WHEN, these methods decide WHAT, and
   * neither reaches into the other's state.
   */
  private deliveryRunner(): DeliveryRunner {
    return {
      targetOf: (message) => this.deliveryTargetOf(message),
      listSessions: () => this.deps.sessions.listSessions(),
      nowMs: () => this.nowMs(),
      drainPreferred: (session, messages, nowMs) => this.drainPreferred(session, messages, nowMs),
      attemptOne: (message, allSessions, nowMs) => {
        if (!this.prepareQueuedAttemptSafely(message, nowMs)) return
        this.attemptDelivery(message, [...allSessions], { viaSweep: true })
        this.scheduleQueuedWakeRetry(message)
      },
    }
  }

  /**
   * The idle drain for ONE preferred session. Total by contract — see
   * {@link DeliveryRunner.drainPreferred}: it reports its own failure and still
   * returns the ids it took, because a row that falls out of the handled set is
   * a row delivered twice.
   */
  private drainPreferred(
    session: SessionMeta,
    messages: readonly MessageRow[],
    nowMs: number,
  ): readonly string[] {
    if (this.stateOf(session) !== 'idle') return []
    const handled = messages.map((message) => message.id)
    if (this.draftHoldActive(session)) return handled
    const eligible = messages.filter((message) => this.prepareQueuedAttemptSafely(message, nowMs))
    eligible.sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id))
    try {
      this.deliverBatch(session, eligible)
      for (const message of eligible) this.scheduleQueuedWakeRetry(message)
    } catch (error) {
      this.scheduler.recordTriggerFailure(`preferred session ${session.sessionId}`, error)
    }
    return handled
  }

  /** Begin a bounded startup walk. The session→issue before-state is this
   *  service's to restore; the walk itself is the scheduler's. */
  reconcileQueued(): void {
    const sessions = this.deps.sessions.listSessions()
    if (this.scheduler.queueIsEmpty()) {
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
    this.scheduler.reconcile()
  }

  /** Deterministic test/shutdown seam for one bounded coalesced turn. */
  flushDeliveryTriggers(onlyPreferredSessionId?: string): void {
    this.scheduler.flushDeliveryTriggers(onlyPreferredSessionId)
  }

  /** Slow delivery backstop [spec:SP-c29e]. */
  sweep(): void {
    this.scheduler.sweep()
  }

  deliveryStats(): MessageDeliveryStats {
    return this.scheduler.deliveryStats()
  }

  dispose(): void {
    this.scheduler.dispose()
    this.brakes.dispose()
    this.sessionIssueTargets.clear()
  }

  private queueDeliveryTarget(
    target: DeliveryTarget,
    preferred?: SessionMeta,
    after?: MessagePageCursor,
    through?: MessagePageCursor,
  ): void {
    this.scheduler.queueDeliveryTarget(target, preferred, after, through)
  }

  private prepareQueuedAttemptSafely(message: MessageRow, nowMs: number): boolean {
    try {
      return this.prepareQueuedAttempt(message, nowMs)
    } catch (error) {
      this.scheduler.recordTriggerFailure(`prepare message ${message.id}`, error)
      return false
    }
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
    const issues = this.deps.issues
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
        ? this.deps.sessions
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
    if (lifecycle === 'wake' && !exemptFromBrakes(principalOf(from))) {
      const issueKey =
        input.to.kind === 'issue' ? (toId ?? '') : this.issueForSession(targetSession)
      const key = `${this.senderKey(from)}|${issueKey ?? toId ?? ''}`
      if (this.brakes.isWakeHot(key)) {
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
    const authority = this.authorityOf(from)
    const message: MessageRow = {
      id,
      threadId: input.threadId ?? original?.threadId ?? id,
      inReplyTo: input.inReplyTo ?? null,
      fromKind: from.kind,
      fromSession: from.kind === 'agent' ? (from.sessionId ?? null) : null,
      fromName: from.kind === 'system' ? (from.name ?? null) : null,
      fromIssue: from.kind === 'agent' ? (from.issueId ?? null) : null,
      attribution: authority.attribution,
      delegationRef: authority.delegationRef,
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
    // The apply-time gate runs BEFORE the mirror, not only before delivery.
    // Otherwise a caller who addressed the literal internal id of an issue
    // beyond its human's visibility would land a row in that issue's legacy
    // mailbox even though delivery later refuses it — a write into a workspace
    // the principal cannot see, which is the injection §3.1.5 exists to prevent.
    if (message.toKind === 'issue' && toId && issues.has(toId) && this.applyAuth(message).ok) {
      legacy = {
        id,
        // `toId` is polymorphic by `toKind` (see the MessageRow field's note), so
        // the brand is recovered HERE, inside the branch that decides the id
        // space — and only after `issues.has(toId)` confirms the row exists.
        issueId: asIssueId(toId),
        fromAuthor: this.legacyAuthor(from),
        body: input.body,
        createdAt: message.createdAt,
        status: 'unread',
        claimedBy: null,
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
    // ADR 3 D8: re-authorize on EVERY apply. A queued send whose principal lost
    // access before the drain is rejected here and surfaced to its sender —
    // not silently dropped, not applied.
    const auth = this.applyAuth(message)
    if (!auth.ok) return this.deadLetter(message, auth.reason, { notifySender })
    if (message.toKind === 'operator') {
      // Escalation to the human: stays queued, kind-tagged for UI pickup (ledger
      // view). Its "delivery" is the operator reading their inbox, not a black hole.
      return { ok: true, queued: true, disposition: 'queued' }
    }
    const sessions = this.deps.sessions
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
      const issue = this.deps.issues.get(message.toId ?? '')
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
      // Prefer the issue's designated coordinator by ROLE (docs/agent-comms-target.html
      // §05 q1), for EVERY urgency [POD-1365] and every non-exited session status
      // [POD-1371]. Routing is by ROLE; urgency and lifecycle govern only HOW the
      // message surfaces (inject now / ride the turn boundary / interrupt / hold /
      // wake), decided below after the target is chosen. They must not decide WHO
      // receives it: worker status reports to a coordinator are correctly 'fyi' —
      // they expect no reply — so gating on live status skipped the coordinator
      // between fan-out waves (when it is normally hibernated) and the fallback
      // below then picked the most-recently-active member, systematically a live
      // worker. `members` already excludes the sender, so a coordinator mailing
      // its own issue still never receives its own message [spec:SP-a4ba].
      //
      // HOLD vs wake for a parked coordinator [POD-1371]: default lifecycle is
      // `wait`, so fyi (and other wait mail) is HELD for the coordinator's next
      // turn — the parked branch below returns queued without queueText/trySpawn.
      // That is deliberate: every fyi must not spawn a process. lifecycle=wake
      // still rides the existing parked wake path (recordWake + queueText, then
      // trySpawn on 'no resume ref'). Only an exited (or unset/gone) coordinator
      // falls through to today's heuristic. Bare session id on the wire (same
      // format as humanQuestionAskedBy).
      const coordinator =
        typeof issue.coordinatorSessionId === 'string'
          ? members.find(
              (s) =>
                s.sessionId === issue.coordinatorSessionId &&
                s.agentKind !== 'shell' &&
                s.status !== 'exited',
            )
          : undefined
      if (coordinator) {
        target = coordinator
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
        if (message.lifecycle === 'wake') {
          // Bare spawn-on-wake places work on the ISSUE's machine (makeSpawnOnWake
          // copies issue.machineId). Gate it before trySpawn, same M2 boundary.
          const denied = this.refuseWakeUnlessUsable(
            message,
            issue.machineId,
            opts?.viaSweep === true,
          )
          if (denied) return denied
          return this.trySpawn(message, message.toId)
        }
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
    // parked (hibernated/exited). lifecycle=wait HOLDS the row for this target's
    // next turn (drain-on-idle / stop-hook / sweep) — including a hibernated
    // coordinator preferred by role [POD-1371]. Do not wake on every fyi.
    if (message.lifecycle === 'wait') {
      return { ok: true, queued: true, disposition: 'queued' }
    }
    // wake: durable queue + resurrect (queueText resurrects parked sessions).
    // A parked coordinator chosen above rides this same path — no second wake
    // mechanism. Code execution on the TARGET SESSION's machine — readiness
    // §3.1.4 M2 / POD-1193. Refuse before recordWake so a denied caller neither
    // starts a process nor burns the wake cooldown.
    {
      const denied = this.refuseWakeUnlessUsable(
        message,
        target.machineId,
        opts?.viaSweep === true,
      )
      if (denied) return denied
    }
    // record the wake against the cooldown window.
    this.recordWake(message, target)
    const injected = this.injectAndMark('queue', message, target.sessionId, 'queued')
    if (injected.ok) return injected
    if (injected.reason === 'no resume ref') {
      // Unresumable → spawn-on-wake. The resume attempt was already gated on
      // the parked session's machine; the spawn may land on the ISSUE's machine
      // instead (issue.machineId), so re-check against that placement target.
      const issueId = this.issueForSession(target) ?? message.toId
      const issueMachine = issueId ? this.deps.issues.get(issueId)?.machineId : undefined
      if (issueMachine && issueMachine !== target.machineId) {
        const denied = this.refuseWakeUnlessUsable(message, issueMachine, opts?.viaSweep === true)
        if (denied) return denied
      }
      return this.trySpawn(message, issueId)
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
    sessionId: SessionId,
    okDisposition: SendDisposition,
  ): DeliveryOutcome {
    const sessions = this.deps.sessions
    const principal = this.inboxPrincipal(message)
    const text = this.render.renderFor(message, sessionId)
    const input = {
      sessionId,
      text,
      inputOrigin: 'mail' as const,
      principal,
      sourceMessageId: message.id,
    }
    const r =
      via === 'now'
        ? sessions.sendText(input)
        : via === 'interrupt'
          ? sessions.interruptText(input)
          : sessions.queueText(input)
    // Transport rejected the push (e.g. the daemon dropped offline mid-send). The
    // row was still captured + durably queued, so the SWEEP will re-attempt it —
    // `disposition: 'queued'` describes that row position, while `ok: false`
    // reports THIS push attempt failed. The one caller whose ok:false carries a
    // recoverable path — a parked 'no resume ref' — is intercepted upstream and
    // routed to trySpawn, so it never surfaces this mixed signal to a sender.
    if (!r.ok) return { ...r, disposition: 'queued' }
    const confirmed = this.render.confirmedOnInjection(message)
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
    const count = this.brakes.spawnCountFor(key, day)
    if (count >= SPAWN_BUDGET_PER_DAY) {
      this.emitTransition(message, 'message.spawn_budget_exhausted')
      this.needsAttention(
        message,
        `spawn budget exhausted for issue ${key} (${SPAWN_BUDGET_PER_DAY}/day); message stays queued`,
      )
      return { ok: true, queued: true, reason: 'spawn budget exhausted', disposition: 'held' }
    }
    if (!this.deps.spawnOnWake) {
      // TODO(#237 stage 4/5): wire spawnOnWake to SessionLifecycle.spawn — the
      // message becomes the first prompt after prime.
      this.needsAttention(message, 'wake target is unresumable and spawn-on-wake is not wired')
      return { ok: true, queued: true, reason: 'unresumable', disposition: 'held' }
    }
    this.brakes.chargeSpawn(key, day, count + 1)
    // A spawn attempt IS a wake — record it against the cooldown so the sweep
    // does not re-run the spawn seam every 60s.
    if (message.fromKind !== 'operator') {
      this.brakes.recordWake(`${this.senderKeyOfRow(message)}|${issueId ?? ''}`)
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
    const targets: DeliveryTarget[] = [{ kind: 'session', id: session.sessionId }]
    if (issueId) targets.push({ kind: 'issue', id: issueId })
    const boundaryThrough = new Map<string, MessagePageCursor>()
    for (const target of targets) {
      const highWater = this.deps.messages.pendingHighWater(target)
      if (highWater) boundaryThrough.set(deliveryTargetKey(target), highWater)
    }
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
      for (const target of targets) {
        const through = boundaryThrough.get(deliveryTargetKey(target))
        if (!through) continue
        let after: MessagePageCursor | undefined
        while (true) {
          const page = this.deps.messages.pendingForPage(target, {
            ...(after ? { after } : {}),
            through,
            limit: DELIVERY_TARGET_PAGE_LIMIT,
          })
          for (const message of page) {
            if (!message.injectedAt || message.deliveredTo !== session.sessionId) continue
            if (this.render.isPointer(message)) continue
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
    this.scheduler.runBoundaryDrain([...boundaryThrough.keys()], session.sessionId, () => {
      this.onSessionEligibilityChanged(session.sessionId, session, {
        preferThisIdleSession: true,
        boundaryThrough,
      })
    })
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
    if (this.render.isPointer(m)) return true
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
    if (message.lifecycle === 'wake' && !exemptFromBrakes(principalOfRow(message))) {
      const key = this.wakeKeyOfRow(message)
      if (this.brakes.isWakeHot(key)) {
        this.scheduleWakeRetry(key, message)
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
    if (this.brakes.isWakeHot(key)) this.scheduleWakeRetry(key, current)
  }

  /** Deliver a pending batch into an idle session. Inline rows go FIFO; fyi
   *  issue-addressed rows past one coalesce into a single pointer
   *  ("N messages from X, Y — run 'podium issue mail inbox'"). */
  private deliverBatch(session: SessionMeta, batch: MessageRow[]): void {
    const sessions = this.deps.sessions
    // Self-delivery suppression [spec:SP-a4ba] (§09-H, POD-836): the idle drain pulls this
    // session's issue-pending rows, which can include a note it sent to its own
    // issue while another member was busy — never deliver those back to the
    // sender. They stay queued for their real recipient's own idle drain.
    const rows = batch.filter((m) => m.fromSession !== session.sessionId)
    if (rows.length === 0) return
    const pointerRows = rows.filter((m) => this.render.isPointer(m))
    const inlineRows = rows.filter((m) => !pointerRows.includes(m))
    for (const m of inlineRows) {
      const r = sessions.sendText({
        sessionId: session.sessionId,
        text: this.render.renderFor(m, session.sessionId),
        inputOrigin: 'mail',
        principal: this.inboxPrincipal(m),
        sourceMessageId: m.id,
      })
      if (r.ok) this.recordPush(m, session.sessionId)
    }
    if (pointerRows.length === 1 && pointerRows[0]!.body.length <= INLINE_BODY_MAX) {
      // One short fyi delivers inline with its full envelope (id present) — the
      // echo can still confirm it; record a push and let the echo/read follow.
      const m = pointerRows[0]!
      const r = sessions.sendText({
        sessionId: session.sessionId,
        text: this.render.renderFor(m, session.sessionId),
        inputOrigin: 'mail',
        principal: this.inboxPrincipal(m),
        sourceMessageId: m.id,
      })
      if (r.ok) this.recordPush(m, session.sessionId)
    } else if (pointerRows.length > 0) {
      // Coalesced nudge: the bodies (and ids) are NOT in the transcript, so these
      // can only be confirmed by an inbox READ. Record the push (injected) and
      // wait — the sweep never re-nudges a pointer row [POD-834].
      const r = sessions.sendText({
        sessionId: session.sessionId,
        text: this.render.pointerText(pointerRows),
        inputOrigin: 'mail',
        principal: {
          kind: 'system',
          attribution: { actor: actorSystem('message-pointer'), onBehalfOf: null },
          principalRef: 'message-pointer',
          delegation: null,
        },
        sourceMessageId: pointerRows[0]!.id,
      })
      if (r.ok) for (const m of pointerRows) this.markInjected(m, session.sessionId)
    }
  }

  /** Record an INLINE push whose body (and id) went into the transcript: an
   *  unwrapped operator body can never echo and a best-effort ack/notification is
   *  never chased, so both are confirmed now; everything else is injected and
   *  awaits its echo (or its turn boundary) [POD-834, POD-853]. */
  private recordPush(message: MessageRow, sessionId: SessionId): void {
    if (this.render.confirmedOnInjection(message))
      this.markDelivered(message, sessionId, 'injection')
    else this.markInjected(message, sessionId)
  }

  // ---- acks & reads (#237 phase 3) [spec:SP-34d7 acks] ----
  //
  // The pull path is its own capability (POD-1397, mailbox.ts). What follows is
  // the facade: callers ask this service, not its parts, exactly as the issue
  // service fronts its POD-320 capability modules.

  /** Where a reply to `original` goes: back to the sender principal. */
  replyTarget(original: MessageRow): { kind: 'issue' | 'session' | 'operator'; id?: string } {
    return this.mailbox.replyTarget(original)
  }

  /** Reply to a message: the recipient is computed server-side from the
   *  original's sender (never caller-supplied). */
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
    return this.mailbox.sendReply(from, input)
  }

  /** Delivered-but-unacked (unexpired) messages awaiting `sessionId`'s reply. */
  deliveredUnacked(sessionId: SessionId): MessageRow[] {
    return this.mailbox.deliveredUnacked(sessionId)
  }

  /** The messages that would produce a settle notice for `sessionId` right now (#468). */
  settleNotifiable(sessionId: SessionId): MessageRow[] {
    return this.mailbox.settleNotifiable(sessionId)
  }

  /** The stop-hook's single-reminder set [POD-835 §04b]. */
  pendingReminders(sessionId: SessionId): { id: string; from: string; body: string }[] {
    return this.mailbox.pendingReminders(sessionId)
  }

  /** Deterministic settle fallback [spec:SP-bf44] [spec:SP-34d7 acks]. */
  systemAckFallback(
    sessionId: SessionId,
    context: {
      outcome: string
      issueSeq?: number
      issueStage?: string
      lastCommit?: string
      workflowStepId?: string
      notificationFact?: { factKey: string; target: string }
    },
  ): void {
    this.mailbox.systemAckFallback(sessionId, context)
  }

  /** Message lookup for the read surfaces (gate/CLI). */
  message(id: string): MessageRow | null {
    return this.mailbox.message(id)
  }

  /** The per-issue / per-session delivery ledger (#237) — a pure read. */
  ledger(q: { issueId?: string; sessionId?: string; limit?: number }): MessageRow[] {
    return this.mailbox.ledger(q)
  }

  /** Bounded wait for a message's ack [spec:SP-34d7 read-toolkit tier 4]. */
  awaitAck(
    messageId: string,
    opts: { timeoutMs: number; pollMs?: number; sleep?(ms: number): Promise<void> },
  ): Promise<MessageRow | null> {
    return this.mailbox.awaitAck(messageId, opts)
  }

  /** Bounded wait for a pushed message to be CONFIRMED [spec:SP-cb9f] [POD-854]. */
  awaitDelivered(
    messageId: string,
    opts: {
      timeoutMs: number
      pollMs?: number
      sleep?(ms: number): Promise<void>
      now?(): number
    },
  ): Promise<MessageRow | null> {
    return this.mailbox.awaitDelivered(messageId, opts)
  }

  /** Urgency-gated blocking send [spec:SP-cb9f] [POD-854]. */
  sendAndConfirm(
    from: MessageSender,
    input: MessageSendInput,
    opts?: { pollMs?: number; sleep?(ms: number): Promise<void>; now?(): number },
  ): Promise<MessageSendResult> {
    return this.mailbox.sendAndConfirm(from, input, opts)
  }

  /** Inbox listing for a set of recipient principals, oldest first. */
  inbox(
    principals: { kind: 'issue' | 'session' | 'operator'; id?: string | null }[],
    opts?: { limit?: number },
  ): MessageRow[] {
    return this.mailbox.inbox(principals, opts)
  }

  /** Inbox read for `podium mail inbox` — the PULL-path confirmation [POD-834 §04d]. */
  readInbox(
    principals: { kind: 'issue' | 'session' | 'operator'; id?: string | null }[],
    opts?: { consume?: SessionId | null; limit?: number },
  ): MessageRow[] {
    return this.mailbox.readInbox(principals, opts)
  }

  /** Explicitly clear one recipient-owned message without opening the inbox. */
  dismiss(messageId: string, consume: string | null): MessageRow {
    return this.mailbox.dismiss(messageId, consume)
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
      if (from.sessionId && isSpawnedBy(target.spawnedBy, { kind: 'session', id: from.sessionId }))
        return 'parent'
      if (from.issueId && isSpawnedBy(target.spawnedBy, { kind: 'issue', id: from.issueId }))
        return 'parent'
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
      return this.deps.issues.issueForCwd(s.cwd) ?? null
    } catch {
      return null
    }
  }

  /** ONE definition of the brake bucket, in `@podium/commands` — see
   *  {@link senderBrakeKey} for why `operator`/`superagent` must be re-keyed per
   *  user and why the bare kind is still the right answer today. */
  private senderKey(from: MessageSender): string {
    const authority = this.authorityOf(from)
    return senderBrakeKey(
      principalOf({
        ...from,
        attribution: authority.attribution,
        delegationRef: authority.delegationRef,
      }),
    )
  }

  private senderKeyOfRow(m: MessageRow): string {
    return senderBrakeKey(principalOfRow(m))
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

  /** Brake 2 for DIRECT agent spawns (`podium agent spawn`) — the gate shares
   *  the same per-issue daily budget as the spawn-on-wake seam. Delegated: the
   *  budget lives with the brake that enforces it, but the seam is on this
   *  service because that is what the gate holds. */
  takeSpawnBudget(issueId: string | null): { ok: boolean; count: number } {
    return this.brakes.takeSpawnBudget(issueId)
  }

  /** The cooldown key of a stored row — MUST mirror recordWake/send: session
   *  targets resolve to their issue. Derived HERE, never inside the brake: this
   *  service owns the session→issue resolution, and a key written by one
   *  derivation and checked by another silently disables the brake. */
  private wakeKeyOfRow(m: MessageRow): string {
    const target =
      m.toKind === 'session'
        ? this.deps.sessions
            .listSessions()
            .find((s) => s.sessionId === m.toId)
        : undefined
    const issueKey = m.toKind === 'issue' ? m.toId : this.issueForSession(target)
    return `${this.senderKeyOfRow(m)}|${issueKey ?? m.toId ?? ''}`
  }

  /** Arm the brake's retry for this row's durable target. Resolving the row to
   *  a target is this service's job; arming the timer is the brake's. */
  private scheduleWakeRetry(key: string, message: MessageRow): void {
    const target = this.deliveryTargetOf(message)
    if (!target) return
    this.brakes.scheduleWakeRetry(key, target)
  }

  private recordWake(message: MessageRow, target: SessionMeta | undefined): void {
    if (exemptFromBrakes(principalOfRow(message))) return
    const issueKey = message.toKind === 'issue' ? message.toId : this.issueForSession(target)
    this.brakes.recordWake(`${this.senderKeyOfRow(message)}|${issueKey ?? message.toId ?? ''}`)
  }

  /** Record a push toward a live PTY without claiming the agent saw it: stamps
   *  injected_at + delivered_to, keeps status `queued` [POD-834]. The transcript
   *  echo (`markDelivered`) or an inbox read (`markRead`) makes the honest claim
   *  later; the sweep re-pushes an echo-mode row whose echo never came. */
  private markInjected(message: MessageRow, sessionId: SessionId): void {
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
    sessionId: SessionId,
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
  onTranscriptDelta(sessionId: SessionId, items: { role?: string; text?: string }[]): void {
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

  /**
   * The ceiling object this service's apply-time port was built from, or
   * `undefined` when no port is wired (the single-user default).
   *
   * Exists so `MessageGate` can REFUSE AT BOOT to be composed against a
   * different ceiling than the one delivery enforces — POD-728 asked for that
   * pairing and could only document it. Reading the tag rather than comparing
   * behaviour is deliberate: two ceilings that happen to agree today are still
   * two ceilings, and identity is the property the invariant is about.
   */
  get appliedPolicy(): 'dynamic' | 'static' | undefined {
    const port = this.deps.authorizeAtApply as { dynamic?: boolean; ceiling?: unknown } | undefined
    if (!port) return undefined
    return port.dynamic === true ? 'dynamic' : 'static'
  }

  get appliedCeiling(): unknown {
    return (this.deps.authorizeAtApply as { ceiling?: unknown } | undefined)?.ceiling
  }

  /**
   * Whether the wake-path machine-use port is wired (POD-1193).
   *
   * Absent = allow is the deliberate single-user default — the same shape as
   * `authorizeAtApply`. A multi-user composition that FORGETS the port is
   * indistinguishable from that default at the decision site (`if (!port)
   * return null`), so multi-user construction MUST assert this is true. The
   * property is identity of the wiring, not behaviour of a denial: a tree that
   * never exercises a refuse still has to fail when the port is dropped.
   */
  get placementAtWakeWired(): boolean {
    return this.deps.placementAtWake !== undefined
  }

  /** {@link MessageDeliveryDeps.authorizeAtApply}, with the absent-port default
   *  stated once. Never memoized: D8 re-authorizes on EVERY apply, and a cached
   *  answer is the capability snapshot D16 refuses, one layer down. */
  private applyAuth(message: MessageRow): { ok: true } | { ok: false; reason: string } {
    const port = this.deps.authorizeAtApply
    if (!port) return { ok: true }
    return port(message)
  }

  /**
   * POD-1193: refuse a wake that would start a process on a machine the sender
   * may not use. `null` = proceed; a DeliveryOutcome = stop (dead-lettered).
   *
   * Missing machineId and a missing port both mean "no gate to consult" — the
   * same fail-open the single-user default uses for authorizeAtApply, and the
   * same `if (machineId)` shape spawnAgent's M5 check already uses. A principal
   * that cannot be re-resolved is a denial (the port returns non-allowed).
   *
   * Unauthorized and unreachable collapse HERE to one reason
   * ({@link WAKE_PLACEMENT_DENIED_REASON}). That is the mail contracts' D20.2
   * half; spawnAgent's distinguishable refusals live only on its handler path.
   *
   * ABSENT vs DELIBERATELY-ABSENT: the decision site cannot tell them apart —
   * both are `if (!port) return null`. Multi-user construction therefore asserts
   * {@link placementAtWakeWired} rather than relying on a denial to fire.
   */
  private refuseWakeUnlessUsable(
    message: MessageRow,
    machineId: string | undefined,
    notifySender: boolean,
  ): DeliveryOutcome | null {
    if (!machineId) return null
    const port = this.deps.placementAtWake
    if (!port) return null
    const decision = port(message, machineId)
    if (decision === 'allowed') return null
    return this.deadLetter(message, WAKE_PLACEMENT_DENIED_REASON, { notifySender })
  }

  /**
   * Re-authorize a durable inbox row immediately before its daemon apply.
   * Neither this method nor the inbox/gateway caches a capability or decision.
   */
  authorizeQueuedInput(messageId: string): { ok: true } | { ok: false; reason: string } {
    const message = this.deps.messages.getMessage(messageId)
    if (!message) return { ok: false, reason: 'session no longer exists' }
    return this.applyAuth(message)
  }

  notifyQueuedInputRejected(messageId: string, reason: string): void {
    const message = this.deps.messages.getMessage(messageId)
    if (message?.status === 'dead_letter') this.notifyDeadLetter(message, reason)
  }

  rejectQueuedInput(messageId: string, reason: string): void {
    const message = this.deps.messages.getMessage(messageId)
    if (message && message.status === 'queued') {
      this.deadLetter(message, reason, { notifySender: true })
    }
  }

  private authorityOf(from: MessageSender): {
    attribution: Attribution
    delegationRef: string | null
  } {
    if (from.attribution) {
      return { attribution: from.attribution, delegationRef: from.delegationRef ?? null }
    }
    switch (from.kind) {
      case 'operator':
        return {
          attribution: {
            actor: actorUser(FIRST_ADMIN_USER_ID),
            onBehalfOf: FIRST_ADMIN_USER_ID,
          },
          delegationRef: null,
        }
      case 'superagent':
        return {
          attribution: {
            actor: actorAgent(asAgentIdentityId('superagent')),
            onBehalfOf: FIRST_ADMIN_USER_ID,
          },
          delegationRef: 'superagent',
        }
      case 'agent': {
        const actorId = from.sessionId ?? ('unbound-agent' as SessionId)
        return {
          attribution: {
            actor: actorAgent(asAgentIdentityId(actorId)),
            onBehalfOf: FIRST_ADMIN_USER_ID,
          },
          delegationRef: from.sessionId ?? null,
        }
      }
      case 'system': {
        const job = from.name ?? 'system'
        return {
          attribution: { actor: actorSystem(job), onBehalfOf: null },
          delegationRef: null,
        }
      }
    }
  }

  private inboxPrincipal(message: MessageRow): InboxPrincipalReference {
    const legacySender: MessageSender =
      message.fromKind === 'operator'
        ? { kind: 'operator' }
        : message.fromKind === 'superagent'
          ? { kind: 'superagent' }
          : message.fromKind === 'system'
            ? { kind: 'system', ...(message.fromName ? { name: message.fromName } : {}) }
            : {
                kind: 'agent',
                ...(message.fromIssue ? { issueId: message.fromIssue } : {}),
                ...(message.fromSession ? { sessionId: message.fromSession } : {}),
              }
    const attribution = message.attribution ?? this.authorityOf(legacySender).attribution
    const actor = attribution.actor
    return {
      kind: actor.kind === 'user' ? 'user' : actor.kind === 'agent' ? 'agent' : 'system',
      attribution,
      principalRef: actor.kind === 'system' ? actor.job : actor.id,
      delegation:
        message.delegationRef && actor.kind === 'agent'
          ? asDelegationRef(message.delegationRef)
          : null,
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
          const issue = this.deps.issues.getMeta(from.issueId)
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
