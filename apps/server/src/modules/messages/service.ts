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
 *                  interrupt → durable row that cuts the turn (POD-4795)
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

import type { WorldIndexReader } from '../world-index'
import { createLogger } from '@podium/logger'
import {
  asThreadId,
  deadLetterSenderGloss,
  isMessageHandedOn,
  isMessagePending,
  isSpawnedBy,
  type IssueId,
  type MachineId,
  MessageDelivery,
} from '@podium/model'
import { randomUUID } from 'node:crypto'
import {
  exemptFromBrakes,
  type MailSenderPrincipal,
  type PlacementDecision,
  senderBrakeKey,
} from '@podium/commands'
import {
  type Attribution,
  actorAgent,
  actorSystem,
  actorUser,
  asAgentIdentityId,
  asIssueId,
  asSessionId,
  isIssueClosed,
  type IssueScope,
  type SessionId,
  type SessionMeta,
} from '@podium/model'
import { asDelegationRef } from '@podium/protocol'
import {
  type QueueDrainAbandonedReason,
  type TurnReceipt,
} from '@podium/protocol/daemon'
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
import { type MessagePageCursor, type MessagesRepository, moved } from '../../store/messages'
import { afterCommit } from '../../store/executor/executor'
import { withReadScope } from '../../store/executor/read-scope'
import type { NotificationFactsRepository } from '../../store/notification-facts'
import { NotificationArbiter } from '../../store/notification-facts'
import type { IssueService } from '../issues/service'
import type { InboxPrincipalReference } from '../sessions/inbox'
import type { SessionFacts } from '../sessions/facts'
import { DeliveryBrakes, SPAWN_BUDGET_PER_DAY } from './brakes'
import { MessageMailbox } from './mailbox'
import { INLINE_BODY_MAX, MessageRenderer, principalOfRow } from './render'
import { type DeliveryRunner, DeliveryScheduler, type MessageDeliveryStats } from './scheduler'
import type {
  MessageSender,
  MessageSendInput,
  MessageSendResult,
  SendDisposition,
} from './types'
import { SUPERAGENT_AGENT_IDENTITY } from './types'

const log = createLogger('server:messages')

export type {
  MessageSender,
  MessageSenderIdentity,
  MessageSendInput,
  MessageSendResult,
  SendDisposition,
} from './types'

import { cursorOf, DELIVERY_TARGET_PAGE_LIMIT, type DeliveryTarget } from './targets'

/** Chain depth past which lifecycle clamps to wait (brake 3). */
export const HOP_LIMIT = 5
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
  position?: number
  disposition: SendDisposition
}

/** Spawn-on-unresumable-wake seam [spec:SP-34d7 decision 4]. Actual agent
 *  spawning is wired in a later stage (TODO: wire to SessionLifecycle.spawn with
 *  the message as the first prompt after prime); the default (absent) marks the
 *  ledger and surfaces needs-attention instead. */
export interface SpawnOnWake {
  spawn(input: { issueId: IssueId | null; message: MessageRow }): Promise<{
    ok: boolean
    sessionId?: SessionId
    reason?: string
  }>
}

interface InboxDeliveryInput {
  sessionId: SessionId
  text: string
  /** The two origins message delivery can produce — NOT the full
   *  `ObservationInputOrigin`. Agent/system/superagent rows stamp `mail`;
   *  operator rows (chat, offer buttons) stamp `controller` because they are a
   *  person typing into the session, and the inbox acts on that difference —
   *  `prepareInboxSend` clears a standing offer for a person-send only
   *  [spec:SP-c7f1, POD-118, POD-552]. Was `'mail'` alone until offer-action
   *  delivery started riding this substrate (POD-729); the port is deliberately
   *  narrower than `SessionInbox`'s own `InboxSendInput` so it keeps naming what
   *  delivery actually sends. */
  inputOrigin?: 'controller' | 'mail'
  principal: InboxPrincipalReference
  sourceMessageId: string
}

/** Membership candidates maintained by the same session events as the routing
 * before-state. Cwd nodes contain only unattached sessions; explicit attachments
 * never become candidates merely because their directory matches another issue.
 * Each node retains descendant IDs so an issue change reads its members directly.
 */
class RoutingMembership {
  private readonly byIssue = new Map<string, Set<SessionId>>()
  private readonly byPath = new Map<string, Set<SessionId>>()
  private readonly members = new Map<SessionId, { issueId: IssueId | null; paths: string[] }>()

  update(id: SessionId, session: Pick<SessionFacts, 'cwd' | 'issueId'> | undefined, issueId: IssueId | null): void {
    const old = this.members.get(id)
    const remove = (map: Map<string, Set<SessionId>>, key: string) => {
      const ids = map.get(key)
      ids?.delete(id)
      if (!ids?.size) map.delete(key)
    }
    if (old?.issueId) remove(this.byIssue, old.issueId)
    for (const path of old?.paths ?? []) remove(this.byPath, path)
    this.members.delete(id)
    if (!session) return
    const add = (map: Map<string, Set<SessionId>>, key: string) => {
      let ids = map.get(key)
      if (!ids) map.set(key, (ids = new Set()))
      ids.add(id)
    }
    const paths: string[] = []
    if (!session.issueId) {
      let end = session.cwd.length
      while (end > 0) {
        const path = session.cwd.slice(0, end)
        paths.push(path)
        add(this.byPath, path)
        end = session.cwd.lastIndexOf('/', end - 1)
      }
    }
    if (issueId) add(this.byIssue, issueId)
    this.members.set(id, { issueId, paths })
  }

  has(id: SessionId): boolean { return this.members.has(id) }

  candidates(issueId: string, worktreePath: string | null | undefined): Set<SessionId> {
    return new Set([
      ...(this.byIssue.get(issueId) ?? []),
      ...(worktreePath ? this.byPath.get(worktreePath) ?? [] : []),
    ])
  }
}

export interface MessageDeliveryDeps {
  worldIndex: Pick<WorldIndexReader, 'pendingCount'>
  firstAdminMemberId(): Promise<import('@podium/model').UserId>
  messages: MessagesRepository
  notificationFacts: NotificationFactsRepository
  events: EventsRepository
  issues: IssueService
  sessions: {
    /** The NARROW reads delivery actually needs [POD-1653]. The full list is
     *  not an accessor — it is a reader-scoped projection that runs an
     *  authorization check (one issue row + one grants read) and a display-ref
     *  resolution PER SESSION, so resolving one recipient through it cost a full
     *  1208-session pass. Both questions delivery asks have a direct answer:
     *  `sessionById` (POD-1646) and `listSessionsForIssue` (POD-1639). Both are
     *  REQUIRED since POD-3857 — the full-list port they used to fall back to is
     *  gone, so a fixture cannot silently reintroduce the pass. */
    sessionById(sessionId: SessionId): Promise<SessionMeta | undefined>
    listSessionsForIssue(
      worktreePath: string | null,
      issueId: IssueId,
    ): Promise<SessionMeta[]>
    /** The whole fleet as cheap in-memory facts [POD-3857] — what the two
     *  membership sweeps below actually read. Generalizes POD-2322's
     *  `sessionRoutingFacts`. */
    sessionFacts(): SessionFacts[]
    sessionFactsById(sessionId: SessionId): SessionFacts | undefined
    /** Live position in the SessionInbox FIFO for a ledger row already handed
     * to it by a receipt/queue delivery. */
    queuedMessagePosition?(
      sessionId: SessionId,
      sourceMessageId: string,
    ): Promise<number | undefined>
    sendText(input: InboxDeliveryInput): Promise<{
      ok: boolean
      queued?: boolean
      reason?: string
      position?: number
    }>
    queueText(input: InboxDeliveryInput): Promise<{
      ok: boolean
      queued?: boolean
      reason?: string
      position?: number
    }>
    cancelQueuedMessage?(sessionId: SessionId, sourceMessageId: string): Promise<boolean>
    hasQueuedMessage?(sessionId: SessionId, sourceMessageId: string): Promise<boolean>
    /** Cut the running turn and type this next (#237 hard interrupt): for an
     *  agent, a durable row in the interrupt delivery mode (POD-4795). */
    interruptText(input: InboxDeliveryInput): Promise<{
      ok: boolean
      queued?: boolean
      reason?: string
      position?: number
    }>
    /**
     * THE RECEIPT PATH (POD-1761 W4), and the ONLY send port delivery uses when
     * it is wired.
     *
     * It subsumes the three verbs above rather than sitting beside them: `via`
     * carries the same choice `injectAndMark` already made, so the urgency x
     * lifecycle table is untouched and the transport it picked is simply named
     * once instead of switched on twice. For an agent every `via` is one durable
     * row under the message id (POD-4795); `onReceipt` carries the queue's own
     * answer, and the daemon's delivery outcome settles the row later by id.
     *
     * OPTIONAL, for the same reason `sessionById` above is: a great many fixtures
     * wire the three verbs and nothing else, and the fallback is the legacy path
     * they already exercise — so an unwired fixture is flag-off, never wrong.
     * `ReceiptSender` decides per session whether a receipt is coming at all; a
     * legacy-driven session gets none, and no reconciliation fires.
     */
    receiptSend?(
      via: 'now' | 'queue' | 'interrupt',
      input: InboxDeliveryInput,
      onReceipt?: (receipt: TurnReceipt) => void,
    ):
      | { ok: boolean; queued?: boolean; reason?: string; position?: number }
      | Promise<{ ok: boolean; queued?: boolean; reason?: string; position?: number }>
  }
  /** Server-only taxonomy fact: true for agent sessions (driver path). It is not part of the client session projection. */
  isAgentDriven?(sessionId: SessionId): boolean
  /**
   * Legacy mailbox mirror (store.issues.addIssueMessage) — issue-addressed
   * sends dual-write so inbox/claim/pending keep working (drop with the table).
   *
   * PROMISE-TYPED BECAUSE IT WRITES THE STORE [POD-3820]. Both mirrors are
   * wired at the composition root to `funnel.run({ write })`, which opens its
   * own transaction. Typed `=> void` those `async` wirings were assignable
   * anyway and the promise was dropped inside the send's span — the POD-3802
   * shape. The honest type leaves `afterCommit` as the only hand-off that
   * compiles, and a wiring that forgets to return its promise is now an error.
   */
  mirrorIssueMail?(row: IssueMessageRow): Promise<void>
  /** Legacy mirror read-marking (store.issues.markIssueMessagesRead): a
   *  substrate inbox read must consume the mirror row's unread status too, or
   *  mailPending's legacy fallback keeps nagging. Drop with the table.
   *  `Promise<void>` for the reason {@link MessageDeliveryDeps.mirrorIssueMail} gives. */
  mirrorMarkIssueMailRead?(issueId: IssueId, ids: string[]): Promise<void>
  /** Spawn-on-wake seam; absent = unresumable wakes surface needs-attention. */
  spawnOnWake?: SpawnOnWake
  /** Transaction seam (store.transact): an ack's row insert + acked_by stamp on
   *  the original commit atomically. Absent (tests) = plain sequential writes. */
  transact?<T>(fn: () => T | Promise<T>): Promise<T>
  /** Existing notify path for needs-attention surfacing (best-effort). A
   *  notification is an external effect and its implementations reach the store,
   *  so it returns `Promise<void>` (POD-3820) and is deferred past the commit
   *  rather than fired inside the sweep's span. */
  notifyOperator?(input: { messageId: string; reason: string; body: string }): Promise<void>
  /** Human-readable machine name for cross-machine provenance [POD-658];
   *  absent (tests) = raw machine id. */
  machineName?(id: string): string | Promise<string>
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
  authorizeAtApply?(
    message: MessageRow,
  ): { ok: true } | { ok: false; reason: string } | Promise<{ ok: true } | { ok: false; reason: string }>
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
  placementAtWake?(
    message: MessageRow,
    machineId: MachineId,
  ): PlacementDecision | Promise<PlacementDecision>
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

type ClampNote = { urgency?: MessageUrgency; lifecycle?: MessageLifecycle; reason: string }

const URGENCY_ORDER: MessageUrgency[] = ['fyi', 'next-turn', 'interrupt']

function capUrgency(requested: MessageUrgency, max: MessageUrgency): MessageUrgency {
  return URGENCY_ORDER.indexOf(requested) > URGENCY_ORDER.indexOf(max) ? max : requested
}

/** What the sender is told when the daemon reports it never typed their turn
 *  [POD-2132, POD-2202]. Written for the person holding the receipt, not for the
 *  driver: neither reason is anybody's fault and neither is a retry instruction. */
const ABANDONED_REASON_TEXT: Record<QueueDrainAbandonedReason, string> = {
  'never-live': 'the agent was not accepting input, so it was never typed',
  teardown: 'the target session was torn down before it could be typed into',
  'delivery-failed': 'the target session accepted it, then failed to hand it to the agent',
}

export class MessageDeliveryService {
  /** hop of the message that triggered the CURRENT turn per session — set at
   *  delivery, cleared when the session goes idle (turn ended). Messages the
   *  session sends within that turn carry hop + 1 (brake 3). */
  private readonly turnHop = new Map<string, number>()
  /** needs-attention already emitted per `${messageId}|${reason}` — the sweep
   *  re-attempts every 60s and must not spam the event log / notify path. */
  private readonly attentionEmitted = new Set<string>()
  /** The send in progress per sender-supplied message id (POD-4763). A sender
   *  that gave up waiting repeats its attempt while the first may still be
   *  running; the repeat waits for it and then answers from the stored row. */
  private readonly sending = new Map<string, Promise<unknown>>()

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
      onCooldownElapsed: async (targets) => {
        for (const target of targets) await this.queueDeliveryTarget(target)
      },
    })
    this.scheduler = new DeliveryScheduler({
      worldIndex: deps.worldIndex,
      messages: deps.messages,
      now: deps.now,
      runner: this.deliveryRunner(),
    })
    this.mailbox = new MessageMailbox({
      messages: deps.messages,
      issues: deps.issues,
      notificationArbiter: this.notificationArbiter,
      sessionById: async (id) => await deps.sessions.sessionById(id),
      now: deps.now,
      ...(deps.mirrorMarkIssueMailRead
        ? {
            mirrorMarkIssueMailRead: async (issueId: IssueId, ids: string[]) =>
              await deps.mirrorMarkIssueMailRead?.(issueId, ids),
          }
        : {}),
      send: async (from, input) => await this.send(from, input),
      cancelQueuedInput: async (message) => {
        const sessionId =
          message.deliveredTo ?? (message.toKind === 'session' ? message.toId : null)
        if (sessionId) await deps.sessions.cancelQueuedMessage?.(asSessionId(sessionId), message.id)
      },
      emitTransition: async (message, kind, extra) => await this.emitTransition(message, kind, extra),
      fromLabel: async (message) => await this.render.fromLabel(message),
    })
    this.render = new MessageRenderer({
      issues: deps.issues,
      sessionById: async (id) => await deps.sessions.sessionById(id),
      ...(deps.machineName ? { machineName: (id: string) => deps.machineName!(id) } : {}),
    })
  }

  /** The exact text a receiver would see — the delivery service's own view of
   *  its renderer, kept public because callers ask this service, not its parts. */
  async renderFor(message: MessageRow, receiverSessionId?: SessionId): Promise<string> {
    return await this.render.renderFor(message, receiverSessionId)
  }

  /** Last resolved issue per session. This is the before-state needed for detach,
   * reassignment, inferred-cwd movement, and remove events. */
  private readonly sessionIssueTargets = new Map<SessionId, IssueId>()
  private readonly routingMembership = new RoutingMembership()
  private routingMembershipReady = false

  private rememberMembership(sessionId: SessionId, session: Pick<SessionFacts, 'cwd' | 'issueId'> | undefined, issueId: IssueId | null): void {
    this.routingMembership.update(sessionId, session, issueId)
    if (issueId) this.sessionIssueTargets.set(sessionId, issueId)
    else this.sessionIssueTargets.delete(sessionId)
  }

  private seedMembership(sessions: readonly SessionFacts[], preserveKnown = false): void {
    for (const session of sessions) {
      if (preserveKnown && this.routingMembership.has(session.sessionId)) continue
      this.rememberMembership(session.sessionId, session, this.issueForSession(session))
    }
    this.routingMembershipReady = true
  }

  /** Queue the session principal plus both sides of its issue-resolution change. */
  async onSessionEligibilityChanged(sessionId: SessionId, changed?: SessionMeta): Promise<void> {
    await this.requeueSessionTargets(sessionId, changed ?? await this.deps.sessions.sessionById(sessionId))
  }

  private async requeueSessionTargets(
    sessionId: SessionId,
    session: Pick<SessionFacts, 'cwd' | 'issueId'> | undefined,
  ): Promise<void> {
    const previousIssueId = this.sessionIssueTargets.get(sessionId)
    const nextIssueId = this.issueForSession(session)
    this.rememberMembership(sessionId, session, nextIssueId)

    await this.queueDeliveryTarget({ kind: 'session', id: sessionId })
    if (previousIssueId && previousIssueId !== nextIssueId) {
      await this.queueDeliveryTarget({ kind: 'issue', id: previousIssueId })
    }
    if (nextIssueId) await this.queueDeliveryTarget({ kind: 'issue', id: nextIssueId })
  }

  /** Issue-side target changes can alter inferred session membership and the
   * cooldown key of session-addressed wakes. Recompute affected sessions and
   * queue their principals plus both old/new issues. */
  async onIssueEligibilityChanged(issueId: IssueId): Promise<void> {
    await this.onIssuesEligibilityChanged([issueId])
  }

  /** Issue events revisit previous owners plus unattached sessions under the
   * current worktree. This includes both sides of rehome/deletion and newly
   * introduced nested worktrees, without resolving unrelated sessions. The
   * initial seed is a boot-only fleet read; ordinary session events update one
   * member and issue events use the reverse indexes.
   */
  async onIssuesEligibilityChanged(issueIds: readonly string[]): Promise<void> {
    const changed = new Set(issueIds)
    if (changed.size === 0) return
    if (!this.routingMembershipReady) this.seedMembership(this.deps.sessions.sessionFacts(), true)
    const candidates = new Set<SessionId>()
    for (const issueId of changed) {
      await this.queueDeliveryTarget({ kind: 'issue', id: issueId })
      const issue = await this.deps.issues.getMeta(issueId)
      for (const id of this.routingMembership.candidates(issueId, issue?.worktreePath)) candidates.add(id)
    }
    for (const id of candidates) {
      const session = this.deps.sessions.sessionFactsById(id)
      if (session) await this.requeueSessionTargets(session.sessionId, session)
      else this.rememberMembership(id, undefined, null)
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
      nowMs: () => this.nowMs(),
      attemptOne: async (message) => {
        if (!await this.prepareQueuedAttemptSafely(message)) return
        await this.attemptDelivery(message, { viaSweep: true })
        await this.scheduleQueuedWakeRetry(message)
      },
    }
  }

  /** Begin a bounded startup walk. The session→issue before-state is this
   *  service's to restore; the walk itself is the scheduler's. */
  async reconcileQueued(): Promise<void> {
    const sessions = this.deps.sessions.sessionFacts()
    if (await this.scheduler.queueIsEmpty()) {
      // Preserve the before-state needed by detach/reassign events without
      // issuing two principal COUNTs per live session on the overwhelmingly
      // common empty-queue boot path.
      this.seedMembership(sessions)
      return
    }
    for (const session of sessions) {
      await this.requeueSessionTargets(session.sessionId, session)
    }
    this.routingMembershipReady = true
    await this.scheduler.reconcile()
  }

  /** Deterministic test/shutdown seam for one bounded coalesced turn. */
  async flushDeliveryTriggers(): Promise<void> {
    await this.scheduler.flushDeliveryTriggers()
  }

  /** Slow delivery backstop [spec:SP-c29e]. */
  async sweep(): Promise<void> {
    await this.scheduler.sweep()
  }

  deliveryStats(): MessageDeliveryStats {
    return this.scheduler.deliveryStats()
  }

  dispose(): void {
    this.scheduler.dispose()
    this.brakes.dispose()
    this.sessionIssueTargets.clear()
  }

  private async queueDeliveryTarget(target: DeliveryTarget): Promise<void> {
    await this.scheduler.queueDeliveryTarget(target)
  }

  private async prepareQueuedAttemptSafely(message: MessageRow): Promise<boolean> {
    try {
      return await this.prepareQueuedAttempt(message)
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
  async send(from: MessageSender, input: MessageSendInput): Promise<MessageSendResult> {
    const id = input.messageId
    if (id === undefined) return await this.sendUnder(`msg_${randomUUID()}`, from, input)
    // ONE ATTEMPT AT A TIME PER ID. The repeat of a send still running would
    // otherwise find the row stored but not yet handed on, and hand it on a
    // second time beside the first.
    const before = this.sending.get(id)
    const attempt = (async () => {
      await before?.catch(() => undefined)
      return await this.sendUnder(id, from, input)
    })()
    this.sending.set(id, attempt)
    try {
      return await attempt
    } finally {
      if (this.sending.get(id) === attempt) this.sending.delete(id)
    }
  }

  /**
   * Store a message under `id` ONCE, and answer.
   *
   * THE ROW IS THE DUPLICATE CHECK (POD-4763; POD-4720 §4 rule 2). A sender
   * repeats an attempt it never heard back from under the same id; the insert
   * below does nothing for an id already stored, in the same transaction as the
   * rest of the send's writes, and the repeat is answered from the stored row.
   * There is no second record to write after the effect, so a crash between the
   * store and the answer leaves nothing half done: the retry finds the row and
   * finishes the send the first attempt started.
   */
  private async sendUnder(
    id: string,
    from: MessageSender,
    input: MessageSendInput,
  ): Promise<MessageSendResult> {
    const already = await this.deps.messages.getMessage(id)
    if (already) return await this.answerRepeat(already, from, input)
    const issues = this.deps.issues
    // Resolve an issue recipient ref (#N / seq / id) to the canonical id up
    // front so the stored to_id is stable.
    const toId =
      input.to.kind === 'issue'
        ? await issues.resolveRef(input.to.id ?? '')
        : input.to.kind === 'session'
          ? (input.to.id ?? null)
          : null
    if (input.to.kind === 'session' && !toId) throw new Error('session recipient needs an id')

    const targetSession =
      input.to.kind === 'session'
        ? await this.deps.sessions.sessionById(asSessionId(toId!))
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
      const key = `${(await this.senderKey(from))}|${issueKey ?? toId ?? ''}`
      if (await this.brakes.isWakeHot(key)) {
        clamps.push({ lifecycle, reason: 'wake cooldown (1 per 10min per sender+issue)' })
        lifecycle = 'wait'
      }
    }

    // Acks [spec:SP-34d7 acks]: kind 'ack' requires in_reply_to; the write
    // below also stamps acked_by on the original in the same transaction.
    // Replies (any kind) inherit the original's thread.
    const original = input.inReplyTo ? await this.deps.messages.getMessage(input.inReplyTo) : null
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
      !(await this.sameSenderAs(from, original)) &&
      this.isRecipientOf(from, original)
    const stampsAck = (kind === 'ack' || respondsToRequest) && !!input.inReplyTo

    const authority = await this.authorityOf(from)
    const message: MessageRow = {
      id,
      threadId: asThreadId(input.threadId ?? original?.threadId ?? id),
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
      ...(input.attachments?.length ? { attachments: input.attachments } : {}),
      expiresAt: input.expiresAt ?? null,
      createdAt: this.deps.now(),
      deliveryStatus: 'stored',
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
    const write = async (): Promise<boolean> => {
      if (!(await this.deps.messages.addMessage(message))) return false
      if (stampsAck && message.inReplyTo) {
        await this.deps.messages.markAcked(message.inReplyTo, id)
      }
      return true
    }
    const stored = this.deps.transact ? await this.deps.transact(write) : await write()
    if (!stored) {
      // Another server process stored this id between the read above and the
      // insert. It is the same case as a repeat, answered the same way.
      const existing = await this.deps.messages.getMessage(id)
      if (!existing) throw new Error(`message ${id} was neither stored nor found`)
      return await this.answerRepeat(existing, from, input)
    }
    if (stampsAck && original) {
      await this.emitTransition({ ...original, ackedBy: id }, 'message.acked')
      // A reply PROVES the recipient received the original — a stronger signal than
      // a transcript echo. Confirm it delivered so a missed echo never keeps the
      // sweep re-injecting an already-answered message [POD-834 review]. An
      // already-confirmed original is "already there" in the store; deliveredTo
      // is always set once a row was handed on.
      if (isMessagePending(original.deliveryStatus) && original.deliveredTo) {
        await this.markDelivered(original, original.deliveredTo, 'ack')
      }
    }
    await this.emitTransition(message, 'message.queued')
    if (message.clampedFrom) {
      await this.emitTransition(message, 'message.clamped')
    }
    if (hopClamped) {
      await this.needsAttention(
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
    if (
      message.toKind === 'issue' &&
      toId &&
      await issues.has(toId) &&
      (await this.applyAuth(message)).ok
    ) {
      legacy = {
        id,
        // `toId` is polymorphic by `toKind` (see the MessageRow field's note), so
        // the brand is recovered HERE, inside the branch that decides the id
        // space — and only after `issues.has(toId)` confirms the row exists.
        issueId: asIssueId(toId),
        fromAuthor: await this.legacyAuthor(from),
        body: input.body,
        createdAt: message.createdAt,
        status: 'unread',
        claimedBy: null,
        claimedAt: null,
      }
      // AFTER THE COMMIT, not inside the span [POD-3806]. Both mirrors are wired
      // at the composition root to `funnel.run({ write })`, which opens its own
      // store transaction. Under the async executor that
      // transaction JOINS whatever span this send is running inside, as a
      // savepoint, so firing it here made the span's next statement address a
      // frame with an open child (refused) and left the mirror's savepoint to die
      // when the span closed. Same shape as the lock bug (POD-3802).
      const mirrored = legacy
      afterCommit(() => this.deps.mirrorIssueMail?.(mirrored), 'legacy-mail-mirror')
    }

    const outcome = await this.attemptDelivery(message)
    // A pushed row may already be in the SessionInbox FIFO with an exact
    // driver-facing position. Fill the common result boundary from a live read;
    // never freeze the enqueue ordinal into the message row.
    const position =
      outcome.position ?? (outcome.queued ? await this.queuePositionForMessage(message) : undefined)
    await this.scheduleQueuedWakeRetry(message)
    return {
      message: await this.deps.messages.getMessage(id) ?? message,
      ...outcome,
      ...(position !== undefined ? { position } : {}),
      legacy,
    }
  }

  /**
   * Answer a send whose id is already stored (POD-4763).
   *
   * Only the SAME message is answered. An id is the sender's, so a repeat comes
   * from the same sender with the same body to the same address; anything else
   * under a stored id is a different message that must not be merged into this
   * one, and must not be told what this one is.
   *
   * The answer is the stored message and where it stands now. A row still
   * `stored` and never handed on is a send whose first attempt stopped between
   * the store and the delivery (a crash, a lost connection): the repeat finishes
   * it, exactly as the delivery sweep would. Every later status is reported as
   * it is; nothing is handed on a second time.
   */
  private async answerRepeat(
    stored: MessageRow,
    from: MessageSender,
    input: MessageSendInput,
  ): Promise<MessageSendResult> {
    const toId =
      input.to.kind === 'issue'
        ? await this.deps.issues.resolveRef(input.to.id ?? '')
        : input.to.kind === 'session'
          ? (input.to.id ?? null)
          : null
    const sameAddress = stored.toKind === input.to.kind && stored.toId === toId
    if (!sameAddress || stored.body !== input.body || !(await this.sameSenderAs(from, stored))) {
      throw new Error(`message id ${stored.id} is already used by a different message`)
    }
    if (stored.deliveryStatus === 'stored' && stored.deliveredTo === null) {
      const outcome = await this.attemptDelivery(stored)
      const position =
        outcome.position ?? (outcome.queued ? await this.queuePositionForMessage(stored) : undefined)
      await this.scheduleQueuedWakeRetry(stored)
      return {
        message: (await this.deps.messages.getMessage(stored.id)) ?? stored,
        ...outcome,
        ...(position !== undefined ? { position } : {}),
      }
    }
    return { message: stored, ...(await this.standingOf(stored)) }
  }

  /** Where a stored message stands, in the words a send answers with. */
  private async standingOf(message: MessageRow): Promise<DeliveryOutcome> {
    switch (message.deliveryStatus) {
      case 'confirmed':
        return { ok: true, disposition: 'delivered' }
      case 'cancelled':
      case 'failed':
      case 'expired':
        return {
          ok: false,
          reason: message.deliveryDeferredReason ?? message.deliveryStatus,
          disposition: 'dead_letter',
        }
      default: {
        // Held by the server, on its way, or lost track of: accepted, not done.
        const position = await this.queuePositionForMessage(message)
        return {
          ok: true,
          queued: true,
          ...(position !== undefined ? { position } : {}),
          disposition: message.deliveryStatus === 'stored' ? 'held' : 'queued',
        }
      }
    }
  }

  // ---- delivery resolution (state × axis table) ----

  /**
   * Resolve the recipient to a concrete session NOW (TOCTOU-safe — nothing was
   * decided at send time) and act per the delivery table. Undeliverable
   * messages stay `queued`; retriggers: eligibility changes (bind, resume,
   * membership), the daemon stop-hook (mailPending), and the slow
   * sweep(). None of them is the agent's phase [POD-4661].
   */
  /**
   * NO FULL SESSION PASS [POD-1653]. This used to take an `allSessions` listing
   * so a sweep could share one projection across its pass [POD-817]; the sweep
   * then rebuilt that projection once PER PAGE, and with a 5.5k-message backlog
   * at 100 rows a page that was ~56 full 1208-session passes per reconcile —
   * the largest single source of `issues WHERE id = ?` and of the zero-row
   * `grants` reads in the stall attribution.
   *
   * Sharing a listing was the wrong axis. A delivery attempt asks only two
   * questions — "which session is this id" and "which sessions belong to this
   * issue" — and both have a direct answer that skips the projection entirely.
   * So the parameter is gone rather than hoisted: there is no listing left to
   * share, and no caller can reintroduce the per-page cost by forgetting to
   * pass one.
   */
  private async attemptDelivery(
    message: MessageRow,
    opts?: { viaSweep?: boolean },
  ): Promise<DeliveryOutcome> {
    return await withReadScope(async () => await this.attemptDeliveryInScope(message, opts))
  }

  private async attemptDeliveryInScope(
    message: MessageRow,
    opts?: { viaSweep?: boolean },
  ): Promise<DeliveryOutcome> {
    // A dead-letter found at SEND time returns synchronously to a watching sender
    // (no async notice); one found LATER (sweep) must tell the sender once.
    const notifySender = opts?.viaSweep === true
    // ADR 3 D8: re-authorize on EVERY apply. A queued send whose principal lost
    // access before the drain is rejected here and surfaced to its sender —
    // not silently dropped, not applied.
    const auth = await this.applyAuth(message)
    if (!auth.ok) return await this.deadLetter(message, auth.reason, { notifySender })
    if (message.toKind === 'operator') {
      // Escalation to the human: stays queued, kind-tagged for UI pickup (ledger
      // view). Its "delivery" is the operator reading their inbox, not a black hole.
      return { ok: true, queued: true, disposition: 'queued' }
    }
    const sessions = this.deps.sessions

    let target: SessionMeta | undefined
    if (message.toKind === 'session') {
      // Self-delivery suppression [spec:SP-a4ba] (§09-H, POD-836): a message must never be
      // surfaced back to the session that sent it (the POD-279 15× self-echo
      // loop). A session-addressed self-send has no other recipient — ledger-only.
      if (message.fromSession && message.toId === message.fromSession) {
        return await this.suppressSelf(message)
      }
      target = message.toId ? await sessions.sessionById(asSessionId(message.toId)) : undefined
      if (!target) {
        // The session row is GONE (not merely parked — parked sessions still
        // list). A session-addressed row records no issue to re-route to, so
        // dead-letter it: never silently queue to a session that will never exist
        // again — the 70 POD-279 losses included exactly this [POD-834 §05].
        return await this.deadLetter(message, 'session no longer exists', { notifySender })
      }
      // An archived row remains addressable for history, but is retired for
      // delivery. Treat it as a terminal target before the wake path can queue
      // input and revive a hidden process.
      if (target.archived) {
        return await this.deadLetter(message, 'session is archived', { notifySender })
      }
    } else {
      const issue = await this.deps.issues.get(message.toId ?? '')
      if (!issue) return await this.deadLetter(message, 'issue no longer exists', { notifySender })
      // A closed-and-archived issue is GONE — no future session will prime on it,
      // so holding is a black hole. Dead-letter it [POD-834 §05]. A merely open
      // (or done-but-live) issue with no session is HELD, below.
      if (issue.archived)
        return await this.deadLetter(message, `issue #${issue.seq} is archived`, { notifySender })
      // A closed issue is terminal even when it has not reached the archive
      // lifecycle yet. In particular, a queued wake must not resurrect a
      // session after the close reaper has stopped it.
      if (isIssueClosed(issue))
        return await this.deadLetter(message, `issue #${issue.seq} is closed`, { notifySender })
      // The narrow read applies `isIssueMember` BEFORE the reader-scoped
      // projection is built (POD-1639) — the same predicate `sessionsForIssue`
      // applied after it, so the set is unchanged. The post-filter that used to
      // sit here re-ran that predicate on an already-narrowed list; POD-3857
      // dropped it along with the full-list fallback it existed to cover.
      const allMembers = await sessions.listSessionsForIssue(issue.worktreePath ?? null, issue.id)
      // Self-delivery suppression [spec:SP-a4ba] (§09-H, POD-836): exclude the sender's own
      // session from issue-recipient resolution, so an agent mailing its own
      // issue never picks itself. selectMailNudgeSession picks the most recently
      // active live member, which would otherwise BE the sender.
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
          ? members.find((s) => s.sessionId === live)
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
          return await this.suppressSelf(message)
        }
        if (message.lifecycle === 'wake') {
          // Bare spawn-on-wake places work on the ISSUE's machine (makeSpawnOnWake
          // copies issue.machineId). Gate it before trySpawn, same M2 boundary.
          const denied = await this.refuseWakeUnlessUsable(
            message,
            issue.machineId,
            opts?.viaSweep === true,
          )
          if (denied) return denied
          return await this.trySpawn(message, message.toId ? asIssueId(message.toId) : null)
        }
        // Issue is live but has NO session — HOLD for its next session. Delivered
        // when a session binds to it (eligibility change) / the sweep. The
        // sender is TOLD it is held; it is not a silent drop [POD-834 §05].
        return { ok: true, queued: true, disposition: 'held' }
      }
    }

    // THE SERVER NEVER HOLDS A MESSAGE ON ITS VIEW OF THE AGENT [POD-4661].
    // Only the daemon knows whether a turn is running right now; the server's
    // phase is a report that can lag or drift (POD-4641 held a send forever on
    // it). A session that has a process gets the message at once, down the
    // durable queue to the daemon's delivery queue, which waits for readiness
    // and the turn boundary itself (POD-4427) — so nothing is typed mid-turn
    // (#471) and nothing answers an on-screen menu (#473). Interrupt is the one
    // urgency that asks to cut the running turn; the driver decides whether
    // there is one to cut.
    if (target.status !== 'hibernated' && target.status !== 'exited') {
      if (message.urgency === 'interrupt') {
        return await this.injectAndMark('interrupt', message, target.sessionId, 'delivered')
      }
      // Files ride the durable row with the text (POD-4795).
      return await this.injectAndMark('queue', message, target.sessionId, 'queued')
    }
    // parked (hibernated/exited): there is no process to hand it to.
    // lifecycle=wait HOLDS the row for this target's next run (bind / sweep) —
    // including a hibernated coordinator preferred by role [POD-1371]. Do not
    // wake on every fyi.
    if (message.lifecycle === 'wait') {
      return { ok: true, queued: true, disposition: 'queued' }
    }
    // wake: durable queue + resurrect (queueText resurrects parked sessions).
    // A parked coordinator chosen above rides this same path — no second wake
    // mechanism. Code execution on the TARGET SESSION's machine — readiness
    // §3.1.4 M2 / POD-1193. Refuse before recordWake so a denied caller neither
    // starts a process nor burns the wake cooldown.
    {
      const denied = await this.refuseWakeUnlessUsable(message, target.machineId, opts?.viaSweep === true)
      if (denied) return denied
    }
    // record the wake against the cooldown window.
    await this.recordWake(message, target)
    const injected = await this.injectAndMark('queue', message, target.sessionId, 'queued')
    if (injected.ok) return injected
    if (injected.reason === 'no resume ref') {
      // Unresumable → spawn-on-wake. The resume attempt was already gated on
      // the parked session's machine; the spawn may land on the ISSUE's machine
      // instead (issue.machineId), so re-check against that placement target.
      const issueId =
        this.issueForSession(target) ?? (message.toId ? asIssueId(message.toId) : null)
      const issueMachine = issueId ? (await this.deps.issues.get(issueId))?.machineId : undefined
      if (issueMachine && issueMachine !== target.machineId) {
        const denied = await this.refuseWakeUnlessUsable(message, issueMachine, opts?.viaSweep === true)
        if (denied) return denied
      }
      return await this.trySpawn(message, issueId)
    }
    return injected
  }

  /**
   * The ONE place a push toward a session records its ledger state [POD-834].
   * `via` picks the transport; `okDisposition` is what a successful dispatch means
   * to the sender. Crucially it marks the row `dispatched` (handed on, awaiting
   * the daemon's settlement, the receipt or the transcript echo), NOT
   * `confirmed`. This is the fix for the POD-495 defect-B lie: an enqueue is no
   * longer a delivery.
   *
   * ONE EXCEPTION, AND IT IS NOT AN AGENT (POD-4775): a direct push of an
   * unwrapped body with no driver behind it — a plain-terminal shell, whose only
   * delivery is the raw PTY write. There is no agent to take it, no receipt and
   * no echo that could ever confirm it later, and the bytes landing on the
   * terminal the operator is watching is exactly what was asked for, so the
   * push is the confirmation. Every agent push has a driver receipt coming and
   * is only handed on until it lands.
   */
  private async injectAndMark(
    via: 'now' | 'queue' | 'interrupt',
    message: MessageRow,
    sessionId: SessionId,
    okDisposition: SendDisposition,
  ): Promise<DeliveryOutcome> {
    const sessions = this.deps.sessions
    const principal = await this.inboxPrincipal(message)
    const text = await this.render.renderFor(message, sessionId)
    // Operator chat / offer buttons ride this substrate after POD-729, but they
    // are still a person typing into the session — not agent mail. Stamp
    // `controller` so prepareInboxSend clears a standing offer [spec:SP-c7f1]
    // and causal turn attribution treats the send as user input (POD-552).
    // Agent/system/superagent deliveries stay `mail` so they never consume an
    // offer the human has not acted on [POD-118].
    const input = {
      sessionId,
      text,
      ...(message.attachments?.length ? { attachments: message.attachments } : {}),
      inputOrigin: message.fromKind === 'operator' ? ('controller' as const) : ('mail' as const),
      principal,
      sourceMessageId: message.id,
    }
    // `receiptSend` is the migrated path; the legacy verbs below it are reached
    // whenever this session has no driver behind it. Every agent push is one
    // durable row under this message's id (POD-4795), so its receipt is the
    // queue's own synchronous answer and the row's fate arrives later as the
    // daemon's delivery outcome, by id.
    const receiptSend = sessions.receiptSend
    const r = await (receiptSend
      ? receiptSend(via, input, async (receipt) => {
          await this.reconcileReceipt(message.id, sessionId, receipt)
        })
      : via === 'now'
        ? sessions.sendText(input)
        : via === 'interrupt'
          ? sessions.interruptText(input)
          : sessions.queueText(input))
    // Transport rejected the push (e.g. the daemon dropped offline mid-send). The
    // row was still captured + durably queued, so the SWEEP will re-attempt it —
    // `disposition: 'queued'` describes that row position, while `ok: false`
    // reports THIS push attempt failed. The one caller whose ok:false carries a
    // recoverable path — a parked 'no resume ref' — is intercepted upstream and
    // routed to trySpawn, so it never surfaces this mixed signal to a sender.
    if (!r.ok) return { ...r, disposition: 'queued' }
    // A queue acceptance is not delivery. Keep the ledger row queued until
    // SessionInbox settles this exact sourceMessageId (`onQueuedInputApplied`);
    // otherwise the transcript hides a still-pending message as soon as it is
    // accepted, and cancellation can no longer stop it. Recording the chosen
    // target here keeps the row off the retry sweep while it waits. A direct push
    // that the legacy inbox redirected into the same queue is the same case.
    if (via === 'queue' || r.queued === true) {
      await this.markDispatched(message, sessionId)
      return { ...r, disposition: via === 'queue' ? okDisposition : 'queued' }
    }
    // Only a shell's raw push reaches here: every agent push was queued above.
    const confirmed = this.render.confirmedOnInjection(message)
    if (confirmed) {
      // No echo will ever come (unwrapped operator body has no id), or chasing one
      // is pure loop risk (a best-effort ack/notification), and no driver will
      // answer — the injection IS the delivery [POD-834, POD-853].
      await this.markDelivered(message, sessionId, 'injection')
    } else {
      // Enveloped (echo) or a coalesced pointer (read): handed on, and the
      // agent's own signal moves it on.
      await this.markDispatched(message, sessionId)
    }
    // Honest sync disposition [spec:SP-cb9f] [POD-854]: `delivered` only when the
    // push was confirmed above; an enveloped push is merely handed on.
    if (okDisposition === 'delivered') {
      return { ...r, disposition: confirmed ? 'delivered' : 'queued' }
    }
    return { ...r, disposition: okDisposition }
  }

  /** SessionInbox calls this when the daemon settles a durable row as delivered:
   *  the driver took the turn. That settlement IS the delivery receipt, for every
   *  row — an operator's unwrapped line and enveloped mail alike [POD-4661]. A
   *  pointer row still waits for its inbox read. */
  async onQueuedInputApplied(messageId: string, sessionId: SessionId): Promise<void> {
    const message = await this.deps.messages.getMessage(messageId)
    if (!message || !isMessagePending(message.deliveryStatus)) return
    // The pointer turn was taken; the body it points at still waits for a read.
    if (this.render.isPointer(message)) await this.markTyped(message, sessionId)
    else await this.markDelivered(message, sessionId, 'injection')
  }

  /** SessionInbox calls this the moment a durable row's bytes cross into the CLI,
   *  which is BEFORE the agent takes them: a busy harness parks typed input in its
   *  own composer queue until the running turn ends (POD-1242). Delivery still
   *  waits for {@link onQueuedInputApplied}; what this move says is that the
   *  message is the harness's now (`typed`) — no further copy will be typed, and
   *  the operator's own bubble can stop calling it pending. */
  async onQueuedInputInjected(messageId: string, sessionId: SessionId): Promise<void> {
    const message = await this.deps.messages.getMessage(messageId)
    if (!message || !isMessagePending(message.deliveryStatus)) return
    await this.markTyped(message, sessionId)
  }

  /** SessionInbox calls this when a forwarded durable row's fate is lost: the
   *  forward timed out, or the daemon reported that it cannot prove the text
   *  landed (POD-4775). That is not a failure — the machine may still type it —
   *  so the row goes `unknown`, and the daemon's settlement or the echo still
   *  confirms it later. */
  async onQueuedInputUnknown(
    messageId: string,
    sessionId: SessionId,
    reason: string,
  ): Promise<void> {
    const message = await this.deps.messages.getMessage(messageId)
    if (!message) return
    await this.markUnknown(message, sessionId, reason)
  }

  /**
   * THE DAEMON GAVE UP ON THESE TURNS, SO THE RECEIPT STOPS SAYING `queued`
   * [POD-2132, POD-2202].
   *
   * A terminal queue reached its ready deadline with the session never live
   * (`never-live`); any family's session was torn down still holding them
   * (`teardown`); or a server-family driver pulled one off its own queue and the
   * send failed (`delivery-failed`, POD-2297). Either way the turn was never
   * delivered and nothing on this side will deliver it: the row
   * goes TERMINAL (`failed`), which is what takes it out of `countPending`,
   * off the retry sweep, and out of a blocked sender's `waitFor`. The sender is
   * told once, the way any dead-letter tells them — being told nothing is the
   * defect this closes.
   *
   * DIRECT TURNS ONLY. A direct turn is a driver-local FIFO entry the daemon
   * held in custody (an interrupt parked behind a lease, a steer queued behind a
   * turn), named by its message id. A DURABLE row is named by the same id since
   * the queue row took the message's id (POD-4763), so it is told apart by what
   * it is — a row still in this session's durable queue — and skipped: it moves
   * nothing and is still acknowledged. Teardown discards delivery state, not
   * durable work, and the row is re-sent to the next owner as a recovery
   * (relay.test.ts "a teardown report naming a durable row leaves it queued for
   * the next owner"). The server never holds messages based on agent state, and
   * failing durable work on a teardown would be a server-side guess about it
   * [POD-4676].
   *
   * REPORTS REPEAT. They are retryable, they survive restarts, and they carry turn
   * ids a previous report already moved. Dedupe is the repository's guarded write,
   * not a set kept here: a repeat finds the row already `failed` and moves
   * nothing, so a duplicated id — inside one report or across two — produces
   * exactly one transition and exactly one sender notice.
   */
  async onQueueDrainAbandoned(
    sessionId: SessionId,
    turnIds: readonly string[],
    reason: QueueDrainAbandonedReason,
  ): Promise<void> {
    const at = this.deps.now()
    for (const messageId of turnIds) {
      const message = await this.deps.messages.getMessage(messageId)
      if (!message || !isMessagePending(message.deliveryStatus)) continue
      if (await this.deps.sessions.hasQueuedMessage?.(sessionId, messageId)) continue
      if (!moved(await this.deps.messages.markDeliveryAbandoned(messageId, sessionId, at, reason))) continue
      const abandoned: MessageRow = {
        ...message,
        deliveryStatus: 'failed',
        deadLetteredAt: at,
        deliveredTo: message.deliveredTo ?? sessionId,
        deliveryDeferredAt: at,
        deliveryDeferredReason: reason,
      }
      await this.emitTransition(abandoned, 'message.dead_letter', {
        reason,
        retryable: false,
        deliveryConfirmed: false,
      })
      await this.notifyDeadLetter(message, ABANDONED_REASON_TEXT[reason])
    }
  }

  /**
   * The wake this delivery asked for did not happen (POD-1703).
   *
   * `queueText` accepts the row, requests a wake and answers `ok: true, queued`.
   * The wake is dispatched by a reaction that may legitimately refuse — a
   * revoked principal — or simply fail, and BOTH outcomes only reached a
   * `log.warn`. POD-1650 called that out ("the sender is told its message was
   * queued, the session never comes back, and nothing anywhere records why") and
   * fixed the silence in the logs; the sender still saw nothing. Every row
   * addressed to that session is now surfaced the same way an exhausted spawn
   * budget is: a durable `message.needs_attention` transition plus the notify
   * path, deduped per (message, reason) so a refusal that repeats every sweep
   * does not spam either.
   *
   * The rows stay queued — refusing a wake must not drop input, and an explicit
   * resume still delivers them.
   */
  async onWakeUnavailable(sessionId: SessionId, reason: string): Promise<void> {
    let after: MessagePageCursor | undefined
    while (true) {
      const page = await this.deps.messages.listQueuedPage({
        ...(after ? { after } : {}),
        limit: DELIVERY_TARGET_PAGE_LIMIT,
      })
      for (const message of page) {
        if (message.deliveredTo !== sessionId) continue
        await this.needsAttention(message, `wake did not happen (${reason}); message stays queued`)
      }
      if (page.length < DELIVERY_TARGET_PAGE_LIMIT) break
      after = cursorOf(page.at(-1)!)
    }
  }

  /** Brake 2 + the spawn seam: unresumable wake → spawn a fresh agent on the
   *  target issue (deferred wiring) within the per-issue daily budget; no seam
   *  or budget exhausted → ledger + needs-attention, row stays queued. */
  private async trySpawn(message: MessageRow, issueId: IssueId | null): Promise<DeliveryOutcome> {
    const key = issueId ?? 'no-issue'
    const day = this.deps.now().slice(0, 10)
    const count = await this.brakes.spawnCountFor(key, day)
    if (count >= SPAWN_BUDGET_PER_DAY) {
      await this.emitTransition(message, 'message.spawn_budget_exhausted')
      await this.needsAttention(
        message,
        `spawn budget exhausted for issue ${key} (${SPAWN_BUDGET_PER_DAY}/day); message stays queued`,
      )
      return { ok: true, queued: true, reason: 'spawn budget exhausted', disposition: 'held' }
    }
    if (!this.deps.spawnOnWake) {
      // TODO(#237 stage 4/5): wire spawnOnWake to SessionLifecycle.spawn — the
      // message becomes the first prompt after prime.
      await this.needsAttention(message, 'wake target is unresumable and spawn-on-wake is not wired')
      return { ok: true, queued: true, reason: 'unresumable', disposition: 'held' }
    }
    this.brakes.chargeSpawn(key, day, count + 1)
    // A spawn attempt IS a wake — record it against the cooldown so the sweep
    // does not re-run the spawn seam every 60s.
    if (message.fromKind !== 'operator') {
      await this.brakes.recordWake(`${this.senderKeyOfRow(message)}|${issueId ?? ''}`)
    }
    const r = await this.deps.spawnOnWake.spawn({ issueId, message })
    if (r.ok && r.sessionId) {
      // spawnIssue rides the event so the budget survives restarts (see
      // spawnCountFor) — it can differ from toId for session-addressed wakes.
      await this.emitTransition(message, 'message.spawned', { spawnIssue: key })
      const injected = await this.injectAndMark('queue', message, r.sessionId, 'spawning')
      if (injected.ok) return injected
      return injected
    }
    await this.needsAttention(message, `spawn-on-wake failed: ${r.reason ?? 'unknown'}`)
    return { ok: true, queued: true, reason: r.reason ?? 'spawn failed', disposition: 'held' }
  }

  // ---- retriggers ----

  /**
   * A session's turn ended (phase → idle): clear the hop context for the
   * finished turn, so anything the session sends next starts a fresh chain
   * (brake 3). That is all this edge does. It confirms nothing and delivers
   * nothing [POD-4661, POD-4775]: the server's idle edge is its own lagging
   * copy of the agent's phase, and only the daemon's settlement, a receipt, the
   * transcript echo or an inbox read says a message arrived.
   */
  onSessionIdle(sessionId: SessionId): void {
    this.turnHop.delete(sessionId)
  }

  /** One recipient's live meta, through the narrow read when the composition
   *  root wired it [POD-1653]. Undefined for a session this service cannot see. */
  private async targetOf(sessionId: SessionId): Promise<SessionMeta | undefined> {
    return await this.deps.sessions.sessionById(sessionId)
  }

  /** Shared idempotency/cooldown gate for every event-triggered or sweep retry.
   *  Duplicate eligibility events cannot re-push a handed-on row, and a stored
   *  wake gets a one-shot retry at the exact durable cooldown boundary. */
  private async prepareQueuedAttempt(message: MessageRow): Promise<boolean> {
    if (message.toKind === 'operator') return false
    // A row already handed on is never pushed again on a timer [POD-4661]. The
    // server cannot see whether the agent is still working on it, so any window
    // it guessed would be a guess about the agent's turn. The daemon settles the
    // row (delivered, failed or dropped), a refusal that clears by waiting hands
    // it to the session's queue, and the echo, a turn boundary or an inbox read
    // confirm it. Only a row the server still holds is ever pushed.
    if (message.deliveryStatus !== 'stored') return false
    if (message.lifecycle === 'wake' && !exemptFromBrakes(principalOfRow(message))) {
      const key = await this.wakeKeyOfRow(message)
      if (await this.brakes.isWakeHot(key)) {
        this.scheduleWakeRetry(key, message)
        return false
      }
    }
    return true
  }

  /** If an attempted wake is still stored (not handed on), arm its next allowed
   *  attempt. Successful queue/spawn paths dispatch it and need no timer. */
  private async scheduleQueuedWakeRetry(message: MessageRow): Promise<void> {
    if (message.lifecycle !== 'wake' || message.fromKind === 'operator') return
    const current = await this.deps.messages.getMessage(message.id)
    if (!current || current.deliveryStatus !== 'stored') return
    const key = await this.wakeKeyOfRow(current)
    if (await this.brakes.isWakeHot(key)) this.scheduleWakeRetry(key, current)
  }

  // ---- acks & reads (#237 phase 3) [spec:SP-34d7 acks] ----
  //
  // The pull path is its own capability (POD-1397, mailbox.ts). What follows is
  // the facade: callers ask this service, not its parts, exactly as the issue
  // service fronts its POD-320 capability modules.

  /** Where a reply to `original` goes: back to the sender principal. */
  async replyTarget(original: MessageRow): Promise<{ kind: 'issue' | 'session' | 'operator'; id?: string }> {
    return await this.mailbox.replyTarget(original)
  }

  /** Reply to a message: the recipient is computed server-side from the
   *  original's sender (never caller-supplied). */
  async sendReply(
    from: MessageSender,
    input: {
      inReplyTo: string
      body: string
      kind?: MessageKind
      urgency?: MessageUrgency
      lifecycle?: MessageLifecycle
    },
  ): Promise<MessageSendResult> {
    return await this.mailbox.sendReply(from, input)
  }

  /** Delivered-but-unacked (unexpired) messages awaiting `sessionId`'s reply. */
  async deliveredUnacked(sessionId: SessionId): Promise<MessageRow[]> {
    return await this.mailbox.deliveredUnacked(sessionId)
  }

  /** The messages that would produce a settle notice for `sessionId` right now (#468). */
  async settleNotifiable(sessionId: SessionId): Promise<MessageRow[]> {
    return await this.mailbox.settleNotifiable(sessionId)
  }

  /** The stop-hook's single-reminder set [POD-835 §04b]. */
  async pendingReminders(sessionId: SessionId): Promise<{ id: string; from: string; body: string }[]> {
    return await this.mailbox.pendingReminders(sessionId)
  }

  /** Deterministic settle fallback [spec:SP-bf44] [spec:SP-34d7 acks]. */
  async systemAckFallback(
    sessionId: SessionId,
    context: {
      outcome: string
      issueSeq?: number
      issueStage?: string
      lastCommit?: string
      workflowStepId?: string
      notificationFact?: { factKey: string; target: string }
    },
  ): Promise<void> {
    await this.mailbox.systemAckFallback(sessionId, context)
  }

  /** Message lookup for the read surfaces (gate/CLI). */
  async message(id: string): Promise<MessageRow | null> {
    const message = await this.mailbox.message(id)
    return message ? await this.withQueuePosition(message) : null
  }

  /** The per-issue / per-session delivery ledger (#237) — a pure read. */
  async ledger(q: { issueId?: IssueId; sessionId?: SessionId; limit?: number }): Promise<MessageRow[]> {
    return await Promise.all(
      (await this.mailbox.ledger(q)).map(async (message) => await this.withQueuePosition(message)),
    )
  }

  private async withQueuePosition(message: MessageRow): Promise<MessageRow> {
    const position = await this.queuePositionForMessage(message)
    return position === undefined ? message : { ...message, queuePosition: position }
  }

  /** Resolve a queued row's current ordinal at the boundary that serves both
   * send receipts and ledger reloads. Physical queued rows win because they
   * include boot prompts and other non-ledger work; busy-turn rows fall back to
   * the message table's session-scoped FIFO.
   */
  private async queuePositionForMessage(message: MessageRow): Promise<number | undefined> {
    if (!isMessagePending(message.deliveryStatus)) return undefined
    const sessionId =
      message.deliveredTo ??
      (message.toKind === 'session' && message.toId ? asSessionId(message.toId) : undefined)
    if (!sessionId) return undefined
    const physical = await this.deps.sessions.queuedMessagePosition?.(sessionId, message.id)
    if (physical !== undefined) return physical
    if (message.deliveryStatus !== 'stored') return undefined
    return await this.deps.messages.queuedPositionForSession(sessionId, message.id)
  }

  /** Bounded wait for a message's ack [spec:SP-34d7 read-toolkit tier 4]. */
  async awaitAck(
    messageId: string,
    opts: { timeoutMs: number; pollMs?: number; sleep?(ms: number): Promise<void> },
  ): Promise<MessageRow | null> {
    return await this.mailbox.awaitAck(messageId, opts)
  }

  /** Inbox listing for a set of recipient principals, oldest first. */
  async inbox(
    principals: { kind: 'issue' | 'session' | 'operator'; id?: string | null }[],
    opts?: { limit?: number },
  ): Promise<MessageRow[]> {
    return await this.mailbox.inbox(principals, opts)
  }

  /** Inbox read for `podium mail inbox` — the PULL-path confirmation [POD-834 §04d]. */
  async readInbox(
    principals: { kind: 'issue' | 'session' | 'operator'; id?: string | null }[],
    opts?: { consume?: SessionId | null; limit?: number },
  ): Promise<MessageRow[]> {
    return await this.mailbox.readInbox(principals, opts)
  }

  /** Explicitly clear one recipient-owned message without opening the inbox. */
  async dismiss(messageId: string, consume: string | null): Promise<MessageRow> {
    return await this.mailbox.dismiss(messageId, consume)
  }

  async cancel(messageId: string): Promise<MessageRow> {
    return await this.mailbox.cancel(messageId)
  }

  /** The sender dismissed the notice of a message that did not arrive
   *  (POD-4764): a stamp that takes it off the chat feed. */
  async dismissNotice(messageId: string): Promise<boolean> {
    return await this.deps.messages.dismissNotice(messageId, this.deps.now())
  }

  /** Retract the named chat send, or the newest held send for a native terminal
   * interrupt that cannot carry the chat mutation id. */
  async cancelPendingOperatorMessage(sessionId: SessionId, messageId?: string): Promise<MessageRow | null> {
    const message = messageId
      ? await this.deps.messages.getMessage(messageId)
      : await this.deps.messages.latestPendingOperatorForSession(sessionId)
    if (!message) return null
    if (
      !MessageDelivery.canMove(message.deliveryStatus, 'cancelled') ||
      message.fromKind !== 'operator' ||
      message.toKind !== 'session' ||
      message.toId !== sessionId
    ) {
      return null
    }
    return await this.cancel(message.id)
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

  private issueForSession(s: Pick<SessionMeta, 'issueId' | 'cwd'> | undefined): IssueId | null {
    if (!s) return null
    if (s.issueId) return s.issueId
    try {
      const issueId = this.deps.issues.issueForCwd(s.cwd)
      return issueId ? asIssueId(issueId) : null
    } catch {
      return null
    }
  }

  /** ONE definition of the brake bucket, in `@podium/commands` — see
   *  {@link senderBrakeKey} for why `operator`/`superagent` must be re-keyed per
   *  user and why the bare kind is still the right answer today. */
  private async senderKey(from: MessageSender): Promise<string> {
    const authority = await this.authorityOf(from)
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
  private async sameSenderAs(from: MessageSender, original: MessageRow): Promise<boolean> {
    return (await this.senderKey(from)) === this.senderKeyOfRow(original)
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
  async takeSpawnBudget(issueId: IssueId | null): Promise<{ ok: boolean; count: number }> {
    return await this.brakes.takeSpawnBudget(issueId)
  }

  /** The cooldown key of a stored row — MUST mirror recordWake/send: session
   *  targets resolve to their issue. Derived HERE, never inside the brake: this
   *  service owns the session→issue resolution, and a key written by one
   *  derivation and checked by another silently disables the brake. */
  private async wakeKeyOfRow(m: MessageRow): Promise<string> {
    // By-id, not a full pass [POD-1653]: this runs per stored row on the sweep.
    const target =
      m.toKind === 'session' && m.toId
        ? await this.deps.sessions.sessionById(asSessionId(m.toId))
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

  private async recordWake(message: MessageRow, target: SessionMeta | undefined): Promise<void> {
    if (exemptFromBrakes(principalOfRow(message))) return
    const issueKey = message.toKind === 'issue' ? message.toId : this.issueForSession(target)
    await this.brakes.recordWake(`${this.senderKeyOfRow(message)}|${issueKey ?? message.toId ?? ''}`)
  }

  /** stored → dispatched: record the hand-off toward `sessionId` without
   *  claiming the agent saw it [POD-834]. The receipt, the daemon's settlement,
   *  the transcript echo or an inbox read makes the honest claim later; nothing
   *  pushes a dispatched row again. */
  private async markDispatched(message: MessageRow, sessionId: SessionId): Promise<void> {
    const at = this.deps.now()
    if (moved(await this.deps.messages.markDispatched(message.id, sessionId, at))) {
      // The injected message triggers the receiver's next turn — anything it
      // sends within that turn chains at hop + 1 (cleared when it goes idle).
      this.turnHop.set(sessionId, message.hop)
      await this.emitTransition(
        { ...message, deliveryStatus: 'dispatched', deliveredTo: sessionId, injectedAt: at },
        'message.injected',
      )
    }
  }

  /** → typed: the bytes crossed into `sessionId`'s CLI (POD-1242). */
  private async markTyped(message: MessageRow, sessionId: SessionId): Promise<void> {
    const at = this.deps.now()
    if (moved(await this.deps.messages.markTyped(message.id, sessionId, at))) {
      this.turnHop.set(sessionId, message.hop)
      await this.emitTransition(
        {
          ...message,
          deliveryStatus: 'typed',
          deliveredTo: sessionId,
          injectedAt: message.injectedAt ?? at,
        },
        'message.typed',
      )
    }
  }

  /** → unknown: handed to `sessionId`, and nobody can say any more whether it
   *  arrived (POD-4775). The honest end of a timeout or an unproven write — the
   *  sender is told nothing has failed, because nothing has. */
  private async markUnknown(
    message: MessageRow,
    sessionId: SessionId,
    reason: string,
  ): Promise<void> {
    if (moved(await this.deps.messages.markUnknown(message.id, sessionId))) {
      await this.emitTransition(
        { ...message, deliveryStatus: 'unknown', deliveredTo: sessionId },
        'message.unknown',
        { reason, deliveryConfirmed: false },
      )
    }
  }

  /**
   * THE QUEUE'S ANSWER, WRITTEN INTO THE LEDGER (POD-1761 W4, POD-4795).
   *
   * Every agent push is one durable row, so the receipt a push hears is the
   * queue's own, given synchronously from inside `receiptSend`: `queued`, or a
   * refusal that kept the row out. It records `message.receipt` beside the
   * row's own transitions and moves nothing — the caller still recording the
   * push owns the row it answers, and what happens at the agent arrives later
   * as the daemon's delivery outcome by id (`onQueuedInputApplied`,
   * `onQueuedInputUnknown`, the drain's rejection). Nothing here resends.
   *
   * ONE REFUSAL ENDS THE ROW [POD-2574]: `unsupported` for a send with files is
   * a CAPABILITY rather than a moment — a shell has no way to take files — so a
   * sweep retrying it would be refused again, for the same reason, forever.
   * WHO GETS TOLD DEPENDS ON WHO CAN HEAR THE SYNCHRONOUS ANSWER. An OPERATOR
   * send is a human at the composer: the refusal is the `ok: false` their own
   * call returns and the chat renders it, so a steward notice on top would be
   * the same refusal twice. An AGENT mailing another session has no such
   * surface, so without the notice it is told nothing at all. The cause is
   * stamped so the row does not read as a vanished target.
   */
  private async reconcileReceipt(
    messageId: string,
    sessionId: SessionId,
    receipt: TurnReceipt,
  ): Promise<void> {
    const message = await this.deps.messages.getMessage(messageId)
    if (!message) return
    await this.emitTransition({ ...message, deliveredTo: sessionId }, 'message.receipt', {
      outcome: receipt.outcome,
      ...('deliveredAs' in receipt ? { deliveredAs: receipt.deliveredAs } : {}),
      ...(receipt.outcome === 'queued' ? { position: receipt.position } : {}),
      ...(receipt.outcome === 'refused'
        ? {
            refusedFor: receipt.refusal.reason,
            ...(receipt.refusal.detail ? { refusalDetail: receipt.refusal.detail } : {}),
          }
        : {}),
    })
    if (
      receipt.outcome === 'refused' &&
      receipt.refusal.reason === 'unsupported' &&
      message.attachments?.length
    ) {
      await this.deadLetter(message, receipt.refusal.detail ?? 'file attachments are unsupported', {
        cause: 'delivery-failed',
        notifySender: message.fromKind !== 'operator',
      })
    }
  }

  /** → confirmed: the PUSH is confirmed [POD-834]. `via` records HOW it was
   *  confirmed so the ledger can tell an echo-confirmed row from one confirmed at a
   *  turn boundary / on injection / by an ack — invaluable when debugging delivery
   *  [POD-853]: 'echo' (transcript), 'boundary' (turn ended), 'injection' (unwrapped
   *  or best-effort — the push IS the confirmation), 'ack' (an ack proves the
   *  original was received). */
  private async markDelivered(
    message: MessageRow,
    sessionId: SessionId,
    via: 'echo' | 'boundary' | 'injection' | 'ack',
  ): Promise<void> {
    const at = this.deps.now()
    if (moved(await this.deps.messages.markDelivered(message.id, sessionId, at))) {
      // THE MIRRORS MOVE WITH THE COMMIT [POD-3259, spec §6 rule 12]: process-owned
      // state describing a durable transition sits AFTER the write that makes the
      // transition true, in the same turn it resolves in.
      //
      // Delivery consumes the legacy issue_messages mirror row too, or
      // mailPending's legacy fallback keeps the stop-hook nagging ("You have
      // mail") until the agent runs `podium issue mail inbox`.
      if (message.toKind === 'issue' && message.toId) {
        // After the commit, for the reason the mirror insert above states.
        const readIssueId = asIssueId(message.toId)
        afterCommit(async () => {
          try {
            // AWAITED [POD-3820]: the mirror is a store write and the dep now
            // says so. A synchronous try/catch around a dropped promise caught
            // nothing that mattered.
            await this.deps.mirrorMarkIssueMailRead?.(readIssueId, [message.id])
          } catch {}
        }, 'legacy-mail-mirror-read')
      }
      this.turnHop.set(sessionId, message.hop)
      await this.emitTransition(
        { ...message, deliveryStatus: 'confirmed', deliveredAt: at, deliveredTo: sessionId },
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
  private async suppressSelf(message: MessageRow): Promise<DeliveryOutcome> {
    const at = this.deps.now()
    if (moved(await this.deps.messages.markDelivered(message.id, null, at))) {
      if (message.toKind === 'issue' && message.toId) {
        // After the commit, for the reason the mirror insert above states.
        const readIssueId = asIssueId(message.toId)
        afterCommit(async () => {
          try {
            // AWAITED, for the reason the delivery path above states.
            await this.deps.mirrorMarkIssueMailRead?.(readIssueId, [message.id])
          } catch {}
        }, 'legacy-mail-mirror-read')
      }
      await this.emitTransition(
        { ...message, deliveryStatus: 'confirmed', deliveredAt: at, deliveredTo: null },
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
   * proof the agent has it in context, so the row moves to confirmed.
   * Best-effort and idempotent: a late/duplicate echo finds it already there.
   */
  async onTranscriptDelta(sessionId: SessionId, items: { role?: string; text?: string }[]): Promise<void> {
    for (const item of items) {
      // Only a user turn echoes a pasted prompt; assistant/tool text quoting the
      // id must never self-confirm a message the agent merely referenced.
      if (item.role !== 'user' || !item.text) continue
      ECHO_ID_RE.lastIndex = 0
      for (const m of item.text.matchAll(ECHO_ID_RE)) {
        const id = m[1]
        if (!id) continue
        const row = await this.deps.messages.getMessage(id)
        // `unknown` included: the echo is exactly the proof it was waiting for.
        if (!row || !isMessageHandedOn(row.deliveryStatus)) continue
        // Confirm ONLY a push WE made to THIS session. A row we never handed on
        // (still stored — e.g. a HELD issue message with no live session, or
        // one waiting for a boundary) has deliveredTo null; some OTHER session's
        // transcript merely quoting its id (an operator pasting it into a
        // different agent) must NOT flip it delivered-to-the-wrong-place and
        // silently strand the real target — the exact silent-drop class this
        // branch kills [POD-834 review]. A hand-off always sets deliveredTo, so
        // requiring the push target to match closes the loophole.
        if (row.deliveredTo !== sessionId) continue
        await this.markDelivered(row, sessionId, 'echo')
      }
    }
  }

  /** Dead-letter a message whose target was gone [POD-834 §05]: mark it terminal,
   *  ledger the transition, and — for a row discovered gone LATER (sweep), when
   *  the sender isn't watching a synchronous return — tell the sender once. A
   *  send-time dead-letter skips the notice (the sender gets the outcome inline).
   *  Returns the `dead_letter` disposition for the delivery path.
   *
   *  A HANDED-ON ROW IS NOT A VANISHED TARGET [POD-4704]. A row the server
   *  handed on but never saw confirmed (dispatched or further, not stored)
   *  that dies here — e.g. a message cut off mid-turn — must not fall through
   *  to the "target gone" line: the session is alive and what failed is the
   *  delivery. With no explicit cause it therefore stamps `delivery-failed`,
   *  the same arm the refusal paths use for a send the driver never honoured.
   *  Rows never pushed keep the old behaviour: no cause, and downstream readers
   *  correctly read a vanished target. */
  private async deadLetter(
    message: MessageRow,
    reason: string,
    opts?: { notifySender?: boolean; cause?: QueueDrainAbandonedReason },
  ): Promise<DeliveryOutcome> {
    const at = this.deps.now()
    const cause = opts?.cause ?? (message.deliveryStatus !== 'stored' ? 'delivery-failed' : undefined)
    if (moved(await this.deps.messages.markDeadLetter(message.id, at, cause))) {
      await this.emitTransition(
        {
          ...message,
          deliveryStatus: 'failed',
          deadLetteredAt: at,
          ...(cause ? { deliveryDeferredAt: at, deliveryDeferredReason: cause } : {}),
        },
        'message.dead_letter',
        // The event names WHY [POD-3226]. The row records only when, and the
        // sender's notice is best-effort; without this, most dead-letter events
        // on a live instance said nothing about the cause.
        { reason },
      )
      // AN INJECTED-BUT-UNCONFIRMED NOTICE IS NOT A VANISHED TARGET [POD-4704].
      // When the cause was inferred from the row having been typed
      // (injectedAt set, no explicit opts.cause), the free-text reason is the
      // sweep's "session no longer exists" about a session that is alive
      // (POD-4604 run 13). The steward notice must say the delivery failed,
      // never that the target vanished — the shared gloss keeps it worded one
      // way with the CLI and the web ledger. An explicit cause keeps its own
      // accurate detail (e.g. attachment refusal).
      if (opts?.notifySender) {
        const inferredUnconfirmed = opts?.cause === undefined && cause === 'delivery-failed'
        await this.notifyDeadLetter(
          message,
          inferredUnconfirmed ? deadLetterSenderGloss('delivery-failed') : reason,
        )
      }
    }
    return { ok: false, reason: `dead-lettered: ${reason}`, disposition: 'dead_letter' }
  }

  /** Tell the sender, exactly once, that their message could not be delivered —
   *  routed back to the sender principal like a reply. Never for a system/steward
   *  sender (no one to tell, and it would loop). */
  private async notifyDeadLetter(message: MessageRow, reason: string): Promise<void> {
    if (message.fromKind === 'system') return
    const to = await this.replyTarget(message)
    try {
      await this.send(
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
  private async applyAuth(
    message: MessageRow,
  ): Promise<{ ok: true } | { ok: false; reason: string }> {
    const port = this.deps.authorizeAtApply
    if (!port) return { ok: true }
    return await port(message)
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
  private async refuseWakeUnlessUsable(
    message: MessageRow,
    machineId: MachineId | undefined,
    notifySender: boolean,
  ): Promise<DeliveryOutcome | null> {
    if (!machineId) return null
    const port = this.deps.placementAtWake
    if (!port) return null
    const decision = await port(message, machineId)
    if (decision === 'allowed') return null
    return await this.deadLetter(message, WAKE_PLACEMENT_DENIED_REASON, { notifySender })
  }

  /**
   * Re-authorize a durable inbox row immediately before its daemon apply.
   * Neither this method nor the inbox/gateway caches a capability or decision.
   */
  async authorizeQueuedInput(messageId: string): Promise<{ ok: true } | { ok: false; reason: string }> {
    const message = await this.deps.messages.getMessage(messageId)
    if (!message) return { ok: false, reason: 'session no longer exists' }
    return await this.applyAuth(message)
  }

  async notifyQueuedInputRejected(messageId: string, reason: string): Promise<void> {
    const message = await this.deps.messages.getMessage(messageId)
    if (message?.deliveryStatus !== 'failed') return
    // A handed-on row the inbox fails is stamped with a cause by
    // QueuedMessageApply [POD-4704] — `never-live` when the daemon said the
    // agent was not accepting input (POD-4775), `delivery-failed` otherwise —
    // while the free-text reason can still say "session no longer exists"
    // about a session that is alive. The notice must never say the target
    // vanished: the shared gloss words the cause, so the notice, the CLI and
    // the ledger say the same thing.
    const cause = message.deliveryDeferredReason
    await this.notifyDeadLetter(message, cause ? deadLetterSenderGloss(cause) : reason)
  }

  async rejectQueuedInput(messageId: string, reason: string): Promise<void> {
    const message = await this.deps.messages.getMessage(messageId)
    if (message && isMessagePending(message.deliveryStatus)) {
      await this.deadLetter(message, reason, { notifySender: true })
    }
  }

  private async authorityOf(from: MessageSender): Promise<{
    attribution: Attribution
    delegationRef: string | null
  }> {
    if (from.attribution) {
      return { attribution: from.attribution, delegationRef: from.delegationRef ?? null }
    }
    switch (from.kind) {
      case 'operator': {
        const owner = await this.deps.firstAdminMemberId()
        return {
          attribution: {
            actor: actorUser(owner),
            onBehalfOf: owner,
          },
          delegationRef: null,
        }
      }
      case 'superagent':
        return {
          attribution: {
            actor: actorAgent(asAgentIdentityId(SUPERAGENT_AGENT_IDENTITY)),
            onBehalfOf: (await this.deps.firstAdminMemberId()),
          },
          delegationRef: SUPERAGENT_AGENT_IDENTITY,
        }
      case 'agent': {
        const actorId = from.sessionId ?? ('unbound-agent' as SessionId)
        return {
          attribution: {
            actor: actorAgent(asAgentIdentityId(actorId)),
            onBehalfOf: (await this.deps.firstAdminMemberId()),
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

  private async inboxPrincipal(message: MessageRow): Promise<InboxPrincipalReference> {
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
    const attribution = message.attribution ?? (await this.authorityOf(legacySender)).attribution
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

  private async legacyAuthor(from: MessageSender): Promise<string> {
    switch (from.kind) {
      case 'operator':
        return 'operator'
      case 'superagent':
        return 'superagent'
      case 'system':
        return from.name ?? 'system'
      case 'agent': {
        if (from.issueId) {
          const issue = await this.deps.issues.getMeta(from.issueId)
          if (issue) return `issue:#${issue.seq}`
        }
        return from.sessionId ? `session:${from.sessionId}` : 'agent'
      }
    }
  }

  /** Needs-attention surfacing: durable event + existing notify path (both
   *  best-effort — the row itself stays queued, nothing is dropped). */
  private async needsAttention(message: MessageRow, reason: string): Promise<void> {
    // Once per (message, reason): the sweep retries every 60s and must not
    // re-emit the same alarm each pass (event-log + notify spam).
    const dedupe = `${message.id}|${reason}`
    if (this.attentionEmitted.has(dedupe)) return
    this.attentionEmitted.add(dedupe)
    await this.emitTransition(message, 'message.needs_attention')
    // AFTER THE COMMIT [POD-3820]. The sweep that reaches here runs inside a
    // span, and the notify path is an external effect whose implementations open
    // their own store transaction: firing it here unawaited is the POD-3802
    // shape, and awaiting it inside the span would announce an alarm a rollback
    // then unmakes. With no span open `afterCommit` runs it now, as before.
    const notice = { messageId: message.id, reason, body: message.body }
    afterCommit(async () => {
      try {
        await this.deps.notifyOperator?.(notice)
      } catch {}
    }, 'message-needs-attention-notify')
  }

  /** One podium_events row per ledger transition (steward visibility, audit). */
  private async emitTransition(message: MessageRow, kind: string, extra?: Record<string, unknown>): Promise<void> {
    try {
      await this.deps.events.appendEvent({
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
          deliveryStatus: message.deliveryStatus,
          ...(message.hop ? { hop: message.hop } : {}),
          ...(message.clampedFrom ? { clampedFrom: message.clampedFrom } : {}),
          ...(message.deliveredTo ? { deliveredTo: message.deliveredTo } : {}),
          ...extra,
        },
      })
    } catch (error) {
      // Audit failures must be visible without interrupting message delivery.
      log.warn('message transition recording failed', { err: error, messageId: message.id, kind })
    }
  }
}
