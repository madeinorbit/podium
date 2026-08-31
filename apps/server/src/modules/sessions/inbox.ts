/**
 * Session inbox: attributed text/answer delivery, durable FIFO draining and
 * controller-gated browser input.
 *
 * Authorization is deliberately a PORT at the command/drain boundary. The
 * daemon gateway below is transport only and never receives or caches a
 * capability. Durable rows carry a delegation REFERENCE plus attribution, not a
 * capability snapshot; {@link InboxAuthorizationPort.authorizeAtDrain} resolves
 * that reference against the live world on every attempt (ADR 3 D8/D16).
 */

import { randomUUID } from 'node:crypto'
import type {
  ActorRef,
  AgentKind,
  AgentRuntimeState,
  Attribution,
  Geometry,
  MutationId,
  SessionId,
  UserId,
} from '@podium/model'
import {
  actorAgent,
  actorSystem,
  actorUser,
  asAgentIdentityId,
  asSessionId,
  asUserId,
  isAgentComputing,
} from '@podium/model'
import type { AgentObservation, ObservationInputOrigin } from '@podium/protocol'
import { asDelegationRef, type DelegationRef } from '@podium/protocol'
import type { CommandPrincipal } from '../../command-principal'
import type { ClientPrincipal } from '../../gateway/client-principal'
import type { ClientConn } from '../../gateway/client-registry'
import type { SessionInputGatewayPort } from '../../gateway/daemon-ports'
import type { HarnessInterrupt } from '../../harness-manifest'
import type { Session } from './session'

const SUBMIT_CR_DELAY_MS = 90
/** Gap between two keystrokes typed into a native menu — see
 *  {@link SessionInbox.answerAskUserQuestion}. Comfortably above the CLI key
 *  parser's own 50ms byte-run window, so no two keys share a read. */
const MENU_KEY_DELAY_MS = 120
/** Extra settle before the keystroke that COMMITS the answer set. */
const MENU_CONFIRM_DELAY_MS = 240
const SUBMIT_VERIFY_DELAY_MS = 1_600
const SUBMIT_MAX_RETRIES = 2
const READY_FLOOR_MS = 800
const READY_QUIET_MS = 600
const READY_MAX_MS = 6_000
const READY_POLL_MS = 200
const QUEUE_DRAIN_DEADLINE_MS = 25_000
const QUEUE_MESSAGE_SPACING_MS = 400
/**
 * A WOKEN session's readiness budget (POD-1100). The quiet heuristic above reads
 * "the PTY stopped painting" as "the CLI is reading" — true for a process that
 * has been up for a while, false for one that is still rehydrating a transcript
 * and connecting MCP servers, which is silent for exactly the same reason. On a
 * wake we wait for the HARNESS to speak for this process instead, and fall back
 * to the quiet heuristic only after this grace, so a harness that reports no
 * runtime state at all still delivers.
 */
const READY_STATE_GRACE_MS = 10_000
/** Liveness budget for a wake. A cold resume of a large session routinely
 *  outran the 25s a live session gets, and gave up before the PTY had bound. */
const WOKEN_DRAIN_DEADLINE_MS = 60_000
/** How long a typed prompt has to show up as a turn before we call it lost.
 *  Only counted while the agent is FREE to take it — see {@link SessionInbox.drain}. */
const CONFIRM_TIMEOUT_MS = 5_000
const CONFIRM_POLL_MS = 250
/** Poll cadence while the CLI is holding our prompt behind a running turn. The
 *  wait is measured in minutes, so it is not worth a 250ms tick; a second still
 *  settles the row promptly once the turn boundary takes it. */
const HELD_POLL_MS = 1_000
/**
 * The outer bound on waiting for a turn that never comes (POD-1242).
 *
 * A held prompt is not a lost one, so the confirmation clock does not run while
 * the harness says it is computing — but "computing" is a REPORT, and a wedged
 * daemon that stops updating it would otherwise hold the row forever. Generous
 * enough that a genuinely long turn is waited out rather than retyped over.
 */
const HELD_CONFIRM_CEILING_MS = 30 * 60_000
/** Type attempts for one queued row, counted ACROSS drain passes (POD-1242) —
 *  the row carries the count, so a re-armed pass resumes rather than restarts. */
const MAX_DELIVERY_ATTEMPTS = 5
/** Backoff before re-typing an unconfirmed row; scaled by attempt number. */
const RETRY_BACKOFF_MS = 2_000
/**
 * Cadence of the queued-input sweep — see {@link SessionInbox.sweepQueuedInputs}
 * (POD-1703).
 *
 * A minute, against the ledger sweep's five: this one re-arms rows a person is
 * waiting on, and a pass over a session with nothing pending (or one already
 * draining) is a map lookup and a return. Not shorter, because a row the drain
 * genuinely cannot deliver yet — a session mid-wake, a CLI still rehydrating —
 * is better left to finish its current pass than re-entered every few seconds.
 */
export const QUEUED_INPUT_SWEEP_MS = 60_000
/** Prefix of the normalized prompt used to recognise it in the transcript. */
const CONFIRM_NEEDLE_CHARS = 80
/** Below this, a needle matches too much of the transcript to be evidence. */
const CONFIRM_NEEDLE_MIN_CHARS = 12

/**
 * Stable authorization identity stored with a queued input.
 *
 * `delegation` is the existing actor-session seam expressed as the canonical
 * opaque reference. POD-323 replaces that transitional value with the
 * SessionBinding delegation reference without changing this module or its row.
 */
export interface InboxPrincipalReference {
  readonly kind: 'user' | 'agent' | 'system'
  readonly attribution: Attribution
  readonly principalRef: string
  readonly delegation: DelegationRef | null
}

export const inboxPrincipalFromCommand = (principal: CommandPrincipal): InboxPrincipalReference => {
  switch (principal.kind) {
    case 'user':
      return {
        kind: 'user',
        attribution: { actor: actorUser(principal.user), onBehalfOf: principal.user },
        principalRef: principal.user,
        delegation: null,
      }
    case 'agent':
      return {
        kind: 'agent',
        attribution: {
          actor: actorAgent(asAgentIdentityId(principal.agentSessionId)),
          onBehalfOf: principal.onBehalfOf,
        },
        principalRef: principal.agentSessionId,
        // Capability.actorSessionId is the existing server-minted seam. This is
        // a reference only; no role/scope/effective-rights snapshot is stored.
        delegation: asDelegationRef(principal.agentSessionId),
      }
    case 'system':
      return {
        kind: 'system',
        attribution: { actor: actorSystem(principal.job), onBehalfOf: null },
        principalRef: principal.job,
        delegation: null,
      }
  }
}

export const inboxPrincipalFromClient = (principal: ClientPrincipal): InboxPrincipalReference => ({
  kind: 'user',
  attribution: { actor: actorUser(principal.user), onBehalfOf: principal.user },
  principalRef: principal.user,
  delegation: null,
})

/** In-process fallback for callers that are server jobs, never a transport. */
export const SYSTEM_INBOX_PRINCIPAL: InboxPrincipalReference = {
  kind: 'system',
  attribution: { actor: actorSystem('session-inbox'), onBehalfOf: null },
  principalRef: 'session-inbox',
  delegation: null,
}

export interface QueuedInboxMessage {
  /** UNBRANDED BY DECISION: queue primary key; may be a mutation id or a generated UUID. */
  id: string
  text: string
  attempts: number
  inputOrigin: ObservationInputOrigin
  principal: InboxPrincipalReference
  sourceMessageId: string | null
}

export interface InboxQueuePort {
  enqueue(row: {
    id: string
    sessionId: SessionId
    text: string
    queuedAt: number
    inputOrigin: ObservationInputOrigin
    principal: InboxPrincipalReference
    sourceMessageId: string | null
  }): boolean
  list(sessionId: SessionId): QueuedInboxMessage[]
  /** UNBRANDED BY DECISION: queue primary key; may be a mutation id or a generated UUID. */
  bumpAttempts(id: string): void
  /** A FRESH PROCESS HAS NEVER BEEN TYPED INTO (POD-1242). Attempts bound how
   *  many copies of a row one CLI may receive; the count dies with that CLI.
   *  UNBRANDED BY DECISION: queue primary key, as above. */
  resetAttempts?(id: string): void
  /** UNBRANDED BY DECISION: queue primary key; may be a mutation id or a generated UUID. */
  delete(id: string): void
  /** Every session holding at least one pending row — the work list for
   *  {@link SessionInbox.sweepQueuedInputs} (POD-1703). Optional so the many
   *  fixtures that satisfy this port with enqueue/list/delete alone stay valid;
   *  without it the sweep is a no-op rather than a crash. */
  sessionsWithPending?(): SessionId[]
}

export interface InboxAuthorizationPort {
  /** Resolve live; implementations must never memoize this answer. */
  authorizeAtDrain(input: {
    sessionId: SessionId
    principal: InboxPrincipalReference
    sourceMessageId: string | null
  }): { ok: true } | { ok: false; reason: string }
  rejected(input: {
    queueId: string
    sourceMessageId: string | null
    principal: InboxPrincipalReference
    reason: string
  }): void
  /** The queued row has now crossed the real PTY boundary — and, where the
   *  transcript can witness it, has been seen to become a turn (POD-1100). */
  applied(input: { sourceMessageId: string; sessionId: SessionId }): void
  /** The bytes went into the CLI; the agent has not been seen to take them yet
   *  (POD-1242). Between this and {@link applied} the message is normally the
   *  harness's. An explicit interrupt is the one signal that returns ownership
   *  to this queue so it can cancel instead of retrying. */
  injected?(input: { sourceMessageId: string; sessionId: SessionId }): void
  /** The operator interrupted an injected row before it became a user turn. */
  interrupted?(input: { sourceMessageId: string | null; sessionId: SessionId }): void
  /** The operator interrupted while a chat message was still held in the
   *  higher-level message ledger and had no physical inbox row yet. */
  interruptedPending?(input: { sessionId: SessionId; sourceMessageId?: string }): void
}

export interface InboxAttentionPort {
  stateChanged(input: {
    ownerUserId: UserId
    sessionId: SessionId
    prev: AgentRuntimeState | undefined
    next: AgentRuntimeState
    observation?: AgentObservation
  }): void
  answered(input: { ownerUserId: UserId; sessionId: SessionId; attribution: Attribution }): void
}

export interface SessionInboxDeps {
  getSession(sessionId: SessionId): Session | undefined
  queue: InboxQueuePort
  daemon: SessionInputGatewayPort
  authorization: InboxAuthorizationPort
  attention: InboxAttentionPort
  now(): number
  persist(session: Session, options?: { cancelTerminalCandidate?: boolean }): void
  broadcast(): void
  needsSubmitVerification(agentKind: AgentKind): boolean
  usesRawFirstTurn(agentKind: AgentKind): boolean
  /** Which key aborts this harness's running turn, and whether it is safe to
   *  press outside one — see {@link SessionInbox.abortKeyFor}. */
  harnessInterrupt(agentKind: AgentKind): HarnessInterrupt
  /** The harness's human-facing name, for a refusal an operator will read. */
  harnessName(agentKind: AgentKind): string
  prepareSend(
    sessionId: SessionId,
    attribution: Attribution,
    kind: 'text' | 'answer',
    origin: ObservationInputOrigin,
  ): void
  ownerOf(sessionId: SessionId): UserId | null | undefined
  /**
   * REQUEST a wake for a parked target; it does not perform one.
   *
   * Deliberately `void`, not an outcome. The wake is dispatched by a reaction
   * (`session.wakeRequested`) that re-authorizes the queued delegation live and
   * may legitimately refuse — so nothing here can be told whether the session
   * came back, and the composition root that DOES know is where the refusal and
   * the failure are reported. This used to be typed as an outcome, which read
   * like the caller could act on it while the only implementation returned a
   * hardcoded `{ ok: true }`: the failure branch below it was dead code that
   * made the silence look handled (POD-1650).
   *
   * The queued row is durable either way, so a refused wake loses no input.
   */
  resurrect(sessionId: SessionId, principal: InboxPrincipalReference): void
  /**
   * Live take-control / hold-control gate (POD-1081). When omitted, controller
   * identity is still stamped but policy is open — unit fixtures without a
   * grant table. Production always injects it.
   */
  authorizeDrive?(principal: ClientPrincipal, sessionId: SessionId): boolean
}

/**
 * One question's answer, as the client picked it: listed options, or the free
 * text the native menu's Other entry takes (POD-599).
 *
 * `multiSelect` and `previewLayout` are the QUESTION's shape, not the answer's,
 * and they travel because the menu cannot be driven without them — see
 * {@link SessionInbox.answerAskUserQuestion}.
 */
export type AnswerChoice = { multiSelect?: boolean; previewLayout?: boolean } & (
  | { optionIndices: number[] }
  | { freeText: string; otherIndex: number }
)

/** Several picks can only have come from a multi-select, so a client that
 *  cannot say so is still read correctly. */
const isMultiSelect = (choice: AnswerChoice): boolean =>
  choice.multiSelect ?? ('optionIndices' in choice && choice.optionIndices.length > 1)

/** The side-by-side preview dialog. It is single-select BY CONSTRUCTION (the CLI
 *  only reaches for it when `!multiSelect`), so a choice claiming both is a
 *  client bug and must not be typed at all. */
const isPreviewLayout = (choice: AnswerChoice): boolean =>
  choice.previewLayout === true && !isMultiSelect(choice)

/** The ONE shape the native menu commits by itself, so the ONE shape that must
 *  not be given a closing CR. Kept next to the choice type because both sides
 *  of the asymmetry have to read the same way. Holds in the preview layout too:
 *  a lone question auto-submits the moment the CR selects a row. */
const isLoneSingleSelect = (choices: AnswerChoice[]): boolean => {
  const only = choices.length === 1 ? choices[0] : undefined
  return only !== undefined && !isMultiSelect(only)
}

/** One typed digit. Anything else cannot be a menu keystroke. */
const isMenuDigit = (n: number): boolean => Number.isInteger(n) && n >= 1 && n <= 9

/**
 * Why this answer cannot be typed into the native menu, or null when it can.
 *
 * Checked for EVERY choice before a single byte moves. The old code skipped an
 * undeliverable choice and kept going, which is how POD-770 stayed silent: the
 * skipped question was left highlighted on its first row and the closing CR
 * committed that row as though the operator had chosen it.
 */
const undeliverable = (choice: AnswerChoice, at: number): string | null => {
  const where = `question ${at + 1}`
  const digits = 'optionIndices' in choice ? choice.optionIndices.filter(isMenuDigit) : []
  // The preview dialog is single-select by construction and its Enter selects
  // exactly the one highlighted row, so both ways of asking it for several
  // answers are contradictions rather than something to type half of. Checked
  // before `isMultiSelect`, whose several-picks inference would misdescribe the
  // second one as a multi-select question.
  if (choice.previewLayout === true) {
    if (choice.multiSelect === true) return `${where}: a preview question cannot be multi-select`
    if (digits.length > 1) {
      return `${where}: a preview question takes one option, got ${digits.join(',')}`
    }
  }
  if ('freeText' in choice) {
    if (choice.freeText.trim() === '') return `${where}: empty free text`
    // The Other row only exists in the classic list layout; the preview layout
    // reaches its Notes field with `n` and needs no index.
    if (!isPreviewLayout(choice) && !isMenuDigit(choice.otherIndex)) {
      return `${where}: Other is at ${choice.otherIndex}, outside the menu's 1-9 digits`
    }
    return null
  }
  if (digits.length === 0) {
    const got = choice.optionIndices.join(',') || 'nothing'
    return `${where}: no option in the menu's 1-9 digits (got ${got})`
  }
  return null
}

export interface InboxSendInput {
  sessionId: SessionId
  text: string
  inputOrigin?: ObservationInputOrigin
  principal?: InboxPrincipalReference
  sourceMessageId?: string
}

/** Wrapping and indentation are the harness's, not the author's — compare on
 *  neither. */
const normalizeForMatch = (text: string): string => text.replace(/\s+/g, ' ').trim()

/**
 * The fragment of a queued prompt we look for in the transcript to know the CLI
 * accepted it. A prefix, because a harness may elide or decorate the tail of a
 * long paste; null when the prompt is too short to be evidence of anything.
 */
const confirmationNeedle = (text: string): string | null => {
  const normalized = normalizeForMatch(text)
  if (normalized.length < CONFIRM_NEEDLE_MIN_CHARS) return null
  return normalized.slice(0, CONFIRM_NEEDLE_CHARS)
}

/** The LAST user turn, and whether it is ours. Deliberately the tail rather than
 *  a count: the daemon re-reads a resumed transcript as a `reset` delta, which
 *  moves every count but leaves the tail meaning what it means. */
const tailUserTurnMatches = (session: Session, needle: string): boolean => {
  const items = session.terminal.transcriptItems()
  for (let i = items.length - 1; i >= 0; i--) {
    const item = items[i]
    if (item?.role !== 'user') continue
    return normalizeForMatch(item.text).includes(needle)
  }
  return false
}

/** When the harness last spoke about this session, in ms. `stateObservedAt` is
 *  the observation clock; `since` is the phase's event-time and the fallback for
 *  a daemon that reports no observation stamp. */
const stateStampMs = (session: Session): number | undefined => {
  const state = session.agentState
  if (!state) return undefined
  const stamp = Date.parse(state.stateObservedAt ?? state.since)
  return Number.isNaN(stamp) ? undefined : stamp
}

export class SessionInbox {
  private readonly activeDrains = new Set<SessionId>()
  /** One generation owns every delayed submit key for a session. Deleting it
   *  is the cancellation token used by both chat stop and native CLI interrupts. */
  private readonly submitVerificationGeneration = new Map<SessionId, number>()
  private nextSubmitVerificationGeneration = 0

  constructor(private readonly deps: SessionInboxDeps) {}

  isDraining(sessionId: SessionId): boolean {
    return this.activeDrains.has(sessionId)
  }

  sendText(input: InboxSendInput): { ok: boolean; queued?: boolean; reason?: string } {
    const session = this.deps.getSession(input.sessionId)
    if (
      session &&
      (isAgentComputing(session) ||
        session.queuedMessageCount > 0 ||
        this.isDraining(input.sessionId))
    ) {
      return this.queueText(input)
    }
    // A grok process that has bound but not finished its TUI still reports
    // `starting`. Typing into that PTY is the POD-549 no-op; wait for settle.
    if (session?.status === 'starting' && this.isRawFirstTurn(session)) {
      return this.queueText(input)
    }
    return this.typeText(input)
  }

  resumeAndSend(input: InboxSendInput & { mutationId?: MutationId }): {
    ok: boolean
    queued?: boolean
    reason?: string
  } {
    const session = this.deps.getSession(input.sessionId)
    if (!session) return { ok: false, reason: 'unknown session' }
    if (session.status === 'live' && session.queuedMessageCount === 0) return this.sendText(input)
    return this.queueText({ ...input, mutationId: input.mutationId })
  }

  interruptText(input: InboxSendInput): { ok: boolean; queued?: boolean; reason?: string } {
    const session = this.deps.getSession(input.sessionId)
    if (!session || (session.status !== 'live' && session.status !== 'starting')) {
      return { ok: false, reason: 'session not running' }
    }
    const principal = input.principal ?? SYSTEM_INBOX_PRINCIPAL
    // An idle agent has no turn to cut into, so the abort key is skipped rather
    // than refused — the message still lands, which is the point of this path.
    // Skipping matters for a harness whose key exits when idle: an
    // interrupt-urgency message must never be the thing that kills the session.
    const abort = this.abortKeyFor(session)
    if (abort) {
      this.sendInput(session, abort, input.inputOrigin ?? 'controller', principal.attribution)
    }
    setTimeout(() => this.typeText({ ...input, principal }, true), SUBMIT_CR_DELAY_MS).unref?.()
    return { ok: true }
  }

  /** Interrupt the active native turn without injecting a replacement prompt. */
  interruptTurn(input: Omit<InboxSendInput, 'text'>): { ok: boolean; reason?: string } {
    const session = this.deps.getSession(input.sessionId)
    if (!session || (session.status !== 'live' && session.status !== 'starting')) {
      return { ok: false, reason: 'session not running' }
    }
    const cancelledDelivery = this.cancelInterruptedDelivery(
      input.sessionId,
      true,
      input.sourceMessageId,
    )
    const abort = this.abortKeyFor(session)
    // REFUSED, not skipped: unlike interruptText there is nothing else this call
    // does, so a silent `{ ok: true }` would be the lie POD-1214 set out to fix —
    // the operator pressed stop and would be told it worked. The reason is
    // user-facing (the chat composer prints it verbatim).
    if (!abort) {
      if (cancelledDelivery) return { ok: true }
      return {
        ok: false,
        reason: `${this.deps.harnessName(session.agentKind)} only takes an interrupt while it is working, and it is not working right now`,
      }
    }
    const principal = input.principal ?? SYSTEM_INBOX_PRINCIPAL
    this.sendInput(session, abort, input.inputOrigin ?? 'controller', principal.attribution)
    return { ok: true }
  }

  /** Apply the same cancellation when the operator used the native CLI instead
   *  of Podium's stop control. Transcript parsers normalize every harness's
   *  wording to `event: interrupt`, so delivery policy stays provider-neutral. */
  onTranscriptDelta(sessionId: SessionId, items: readonly { event?: string }[]): void {
    if (!items.some((item) => item.event === 'interrupt')) return
    this.cancelInterruptedDelivery(sessionId)
  }

  private cancelInterruptedDelivery(
    sessionId: SessionId,
    includeUnattempted = false,
    sourceMessageId?: string,
  ): boolean {
    const verification = this.submitVerificationGeneration.delete(sessionId)
    const session = this.deps.getSession(sessionId)
    if (!session) return verification
    // Only the head can have crossed into the CLI. Rows behind it have not been
    // part of the interrupted interaction and remain individually retractable.
    const rows = this.deps.queue.list(sessionId)
    const head = sourceMessageId
      ? rows.find((row) => row.sourceMessageId === sourceMessageId)
      : (rows.find((row) => row.attempts > 0) ?? (includeUnattempted ? rows[0] : undefined))
    if (!head) {
      if (includeUnattempted) {
        this.deps.authorization.interruptedPending?.({
          sessionId,
          ...(sourceMessageId ? { sourceMessageId } : {}),
        })
      }
      return verification
    }
    this.deps.queue.delete(head.id)
    session.queuedMessageCount = Math.max(0, session.queuedMessageCount - 1)
    this.deps.persist(session)
    this.deps.broadcast()
    this.deps.authorization.interrupted?.({
      sourceMessageId: head.sourceMessageId,
      sessionId,
    })
    return true
  }

  /**
   * The bytes that abort THIS session's harness, or undefined when sending them
   * would do more harm than nothing (POD-1214).
   *
   * There is no universal abort key, and providers change their bindings. The
   * key comes from the harness manifest; `interruptQuitsWhenIdle` turns a stop
   * into a refusal when that provider's current key would exit an idle CLI.
   *
   * The phase read here is the SERVER's `agentState`, the authority the client's
   * replica is a copy of — which is why the client no longer gates the chord on
   * its own copy of it (see `use-chat-surface.ts`).
   */
  private abortKeyFor(session: Session): string | undefined {
    const abort = this.deps.harnessInterrupt(session.agentKind)
    if (abort.quitsWhenIdle && !isAgentComputing(session)) return undefined
    return abort.bytes
  }

  queueText(input: InboxSendInput & { mutationId?: MutationId }): {
    ok: boolean
    queued?: boolean
    reason?: string
  } {
    const session = this.deps.getSession(input.sessionId)
    if (!session) return { ok: false, reason: 'unknown session' }
    const parked = session.status === 'hibernated' || session.status === 'exited'
    if (parked && session.agentKind !== 'shell' && !session.resume) {
      return { ok: false, reason: 'no resume ref' }
    }
    const principal = input.principal ?? SYSTEM_INBOX_PRINCIPAL
    // ONE LEDGER INTENT, ONE PHYSICAL ROW (POD-1703). A ledger row that cannot
    // confirm itself is re-pushed by the delivery sweep, and this used to mint a
    // fresh queue id for each pass — so the agent was typed the same text three
    // times over five minutes while the FIRST copy was still sitting in the
    // queue, unread. The row already here is the delivery; re-arm the drain in
    // case the earlier pass gave up, but never stack a duplicate behind it.
    // `cancelQueuedMessage` retracts by the same key, so a second row would also
    // survive a cancellation that was meant to remove the message entirely.
    if (input.sourceMessageId && this.hasQueuedMessage(input.sessionId, input.sourceMessageId)) {
      if (parked) this.deps.resurrect(input.sessionId, principal)
      this.drain(input.sessionId)
      return { ok: true, queued: true }
    }
    const inserted = this.deps.queue.enqueue({
      id: input.mutationId ?? randomUUID(),
      sessionId: input.sessionId,
      text: input.text,
      inputOrigin: input.inputOrigin ?? 'controller',
      queuedAt: this.deps.now(),
      principal,
      sourceMessageId: input.sourceMessageId ?? null,
    })
    if (inserted) {
      session.queuedMessageCount += 1
      this.deps.persist(session, { cancelTerminalCandidate: true })
      this.deps.prepareSend(
        input.sessionId,
        principal.attribution,
        'text',
        input.inputOrigin ?? 'controller',
      )
      this.deps.broadcast()
    }
    // Ask for the wake; the reaction decides and reports. See the port's note.
    if (parked) this.deps.resurrect(input.sessionId, principal)
    this.drain(input.sessionId)
    return { ok: true, queued: true }
  }

  /** Remove every still-pending PTY row backed by one message-ledger intent. */
  cancelQueuedMessage(sessionId: SessionId, sourceMessageId: string): boolean {
    const session = this.deps.getSession(sessionId)
    if (!session) return false
    const matches = this.deps.queue
      .list(sessionId)
      .filter((row) => row.sourceMessageId === sourceMessageId)
    if (matches.length === 0) return false
    for (const row of matches) this.deps.queue.delete(row.id)
    session.queuedMessageCount = Math.max(0, session.queuedMessageCount - matches.length)
    this.deps.persist(session)
    this.deps.broadcast()
    return true
  }

  hasQueuedMessage(sessionId: SessionId, sourceMessageId: string): boolean {
    return this.deps.queue.list(sessionId).some((row) => row.sourceMessageId === sourceMessageId)
  }

  /**
   * Re-arm delivery for every session still holding a queued row (POD-1703).
   *
   * THE MISSING HALF OF THE RETRY STORY. The message ledger has had a slow sweep
   * since #237, but the PTY queue — the table the bytes actually wait in — had
   * none, and `drain` was re-armed from only three places: the enqueue itself, a
   * daemon bind, and a machine reattach. None is a timer, so any pass that ended
   * without settling the row left it for a daemon reconnect that a healthy
   * long-lived session never performs. Every stuck row observed live had
   * `attempts = 0` on a parked session — queued, never typed once, the oldest 33
   * days old.
   *
   * Deliberately just a re-arm, not a delivery path of its own: `drain` is
   * single-flight, checks liveness and readiness, and carries the row's own
   * attempt budget, so a pass that still cannot deliver costs one no-op. That is
   * what makes it safe to run over every pending session on a fixed interval.
   */
  sweepQueuedInputs(): void {
    const pending = this.deps.queue.sessionsWithPending?.()
    if (!pending) return
    for (const sessionId of pending) this.drain(sessionId)
  }

  /**
   * Deliver this session's queued rows, oldest first.
   *
   * A ROW LEAVES THE QUEUE ONLY WHEN THE AGENT TOOK IT (POD-1100). It used to
   * leave when the bytes reached the daemon, which is not the same claim: a
   * session woken by an offer click binds its PTY within a second or two and
   * then spends much longer rehydrating its transcript before the composer
   * exists, so a paste typed in that window went nowhere — and the row, the
   * queue badge and the ledger's `applied` receipt all said it had landed. The
   * message was gone from a queue that had never delivered it.
   *
   * So: type, then watch the transcript for the turn. Confirmed → remove.
   * Unconfirmed → the row stays durable and queued, and we retry with backoff.
   * When the transcript cannot witness the send at all (no transcript for this
   * session, or a prompt too short to recognise) we keep the old remove-on-write
   * behaviour rather than retry blind — an unwitnessable duplicate is worse than
   * the loss it would be guarding against.
   */
  drain(sessionId: SessionId, opts?: { justBound?: boolean }): void {
    if (this.activeDrains.has(sessionId)) return
    const session = this.deps.getSession(sessionId)
    if (!session || session.queuedMessageCount === 0) return
    this.activeDrains.add(sessionId)
    // A PTY we are watching come up — parked as this pass begins, or bound so
    // recently that the caller is telling us so. Its CLI has proven nothing yet,
    // and it is the only case whose readiness the quiet heuristic gets wrong.
    // The status alone cannot see it: the bind that wakes this pass has already
    // flipped the session to 'live' by the time we are called.
    const woken = session.status !== 'live' || opts?.justBound === true
    // The CLI that was typed into is gone; whatever it was holding went with it.
    // Give this process the full attempt budget rather than the exhausted one the
    // dead process left behind (POD-1242).
    if (woken && this.deps.queue.resetAttempts) {
      for (const row of this.deps.queue.list(sessionId)) this.deps.queue.resetAttempts(row.id)
    }
    const deadline = this.deps.now() + (woken ? WOKEN_DRAIN_DEADLINE_MS : QUEUE_DRAIN_DEADLINE_MS)
    const baseStateAt = stateStampMs(session)
    let liveAtMs = 0
    let baseOutputMs = 0
    const stop = () => this.activeDrains.delete(sessionId)
    const removeHead = (current: Session, id: string): void => {
      this.deps.queue.delete(asSessionId(id))
      current.queuedMessageCount = Math.max(0, current.queuedMessageCount - 1)
      this.deps.persist(current)
      this.deps.broadcast()
    }
    /** The head is done with — settle its ledger receipt and move on. */
    const settleHead = (current: Session, head: QueuedInboxMessage): void => {
      if (head.sourceMessageId) {
        this.deps.authorization.applied({ sourceMessageId: head.sourceMessageId, sessionId })
      }
      removeHead(current, head.id)
      afterHead(current)
    }
    const afterHead = (current: Session): void => {
      if (current.queuedMessageCount > 0) {
        setTimeout(deliverNext, QUEUE_MESSAGE_SPACING_MS).unref?.()
      } else stop()
    }
    /**
     * Poll for our own prompt arriving as the transcript's last user turn. Not
     * finding it is not proof of loss — a slow harness may simply not have
     * written the record yet — so the timeout retypes rather than dead-letters,
     * and gives up leaving the row exactly where a retry can find it.
     *
     * A BUSY AGENT IS NOT A LOST PROMPT (POD-1242). The CLI parks typed input in
     * its own composer queue and does not write the user turn until the running
     * turn ends, which is minutes away and routinely much more. The five-second
     * clock therefore only runs while the harness is FREE to take the prompt:
     * while it reports computing we simply wait, and the clock restarts whole
     * when it stops — otherwise the very first poll after a long turn would find
     * an expired deadline and retype into the boundary it was waiting for. The
     * old behaviour typed the same message up to five times in forty seconds
     * (observed: eight copies of one offer click), and the CLI showed each copy
     * to the running turn as a queued command, so the agent acted on the request
     * several times over.
     */
    const confirm = (head: QueuedInboxMessage, needle: string, attempt: number): void => {
      let until = this.deps.now() + CONFIRM_TIMEOUT_MS
      const heldUntil = this.deps.now() + HELD_CONFIRM_CEILING_MS
      const poll = (): void => {
        const current = this.deps.getSession(sessionId)
        if (!current || (current.status !== 'live' && current.status !== 'starting')) {
          stop()
          return
        }
        if (!this.deps.queue.list(sessionId).some((row) => row.id === head.id)) {
          afterHead(current)
          return
        }
        if (tailUserTurnMatches(current, needle)) {
          settleHead(current, head)
          return
        }
        const now = this.deps.now()
        if (isAgentComputing(current)) {
          // Held, not lost. Give up only at the ceiling, and leave the row
          // exactly where a later re-arm finds it — with its attempts intact.
          if (now >= heldUntil) {
            stop()
            return
          }
          until = now + CONFIRM_TIMEOUT_MS
          setTimeout(poll, HELD_POLL_MS).unref?.()
          return
        }
        if (now < until) {
          setTimeout(poll, CONFIRM_POLL_MS).unref?.()
          return
        }
        // Unconfirmed. The row is still queued and still durable; the operator
        // keeps seeing it, and a later bind or daemon attach re-arms this pass.
        if (attempt >= MAX_DELIVERY_ATTEMPTS) {
          stop()
          return
        }
        setTimeout(() => attemptDelivery(head, attempt + 1), RETRY_BACKOFF_MS * attempt).unref?.()
      }
      setTimeout(poll, CONFIRM_POLL_MS).unref?.()
    }
    const attemptDelivery = (head: QueuedInboxMessage, attempt: number): void => {
      const current = this.deps.getSession(sessionId)
      if (!current || (current.status !== 'live' && current.status !== 'starting')) {
        stop()
        return
      }
      if (!this.deps.queue.list(sessionId).some((row) => row.id === head.id)) {
        afterHead(current)
        return
      }
      // Re-authorize immediately before EVERY physical attempt. Confirmation
      // can span an agent turn; during that gap an ack, echo, or cancellation
      // can settle the source ledger row and make a retry invalid.
      const authorized = this.deps.authorization.authorizeAtDrain({
        sessionId,
        principal: head.principal,
        sourceMessageId: head.sourceMessageId,
      })
      if (!authorized.ok) {
        removeHead(current, head.id)
        this.deps.authorization.rejected({
          queueId: head.id,
          sourceMessageId: head.sourceMessageId,
          principal: head.principal,
          reason: authorized.reason,
        })
        afterHead(current)
        return
      }
      const needle = confirmationNeedle(head.text)
      // A retry exists ONLY because the last attempt went unwitnessed. If the
      // turn has appeared since, it landed late — settle it rather than send the
      // same prompt twice. This check is what makes retrying safe at all.
      if (attempt > 1 && needle !== null && tailUserTurnMatches(current, needle)) {
        settleHead(current, head)
        return
      }
      // A RE-ARMED PASS OVER AN ALREADY-TYPED ROW (POD-1242). This row has been
      // typed before and the harness is computing; the copy it is holding IS the
      // delivery. Rejoin the wait rather than type a second one — `attempt - 1`
      // because nothing is typed here, so the last typed attempt still stands.
      if (attempt > 1 && needle !== null && current.transcriptAvailable) {
        if (isAgentComputing(current)) {
          confirm(head, needle, attempt - 1)
          return
        }
      }
      this.deps.queue.bumpAttempts(head.id)
      // Baseline: if OUR text is already the last user turn we cannot tell a
      // fresh arrival from the one that is there, so there is nothing to witness.
      const witnessable =
        needle !== null && current.transcriptAvailable && !tailUserTurnMatches(current, needle)
      const sent = this.typeText({
        sessionId,
        text: head.text,
        inputOrigin: head.inputOrigin,
        principal: head.principal,
        ...(head.sourceMessageId ? { sourceMessageId: head.sourceMessageId } : {}),
        recordSend: false,
      })
      if (!sent.ok) {
        // A live menu is holding the CLI (`needs_user`). Typing a prompt into it
        // would answer the wrong question; leave the row for the next re-arm.
        stop()
        return
      }
      // The bytes are in the CLI now, whatever the agent does with them next
      // (POD-1242). Said out loud so the ledger — and the operator's own bubble —
      // can stop calling a message that has been handed over "pending". It is not
      // delivery: `applied` below still waits for the turn.
      if (head.sourceMessageId) {
        this.deps.authorization.injected?.({ sourceMessageId: head.sourceMessageId, sessionId })
      }
      if (witnessable && needle !== null) confirm(head, needle, attempt)
      else settleHead(current, head)
    }
    const deliverNext = (): void => {
      const current = this.deps.getSession(sessionId)
      if (!current || (current.status !== 'live' && current.status !== 'starting')) {
        stop()
        return
      }
      const head = this.deps.queue.list(sessionId)[0]
      if (!head) {
        stop()
        return
      }
      // ATTEMPTS ARE THE ROW'S, NOT THE PASS'S (POD-1242). The cap used to reset
      // every time a bind, an idle edge or a reconnect re-armed the drain, so a
      // row that could not be confirmed was retyped five times per pass, forever.
      // Spent means spent: the row stays durable and waits for a fresh process,
      // which is the one event that hands the budget back.
      if (head.attempts >= MAX_DELIVERY_ATTEMPTS) {
        stop()
        return
      }
      attemptDelivery(head, head.attempts + 1)
    }
    /**
     * Ready to be typed into. On a wake that means the harness has reported
     * runtime state for the RESUMED process — its own word that it is up, where
     * terminal silence is equally consistent with a CLI that is still loading.
     */
    const readyForInput = (current: Session, now: number): boolean => {
      if (now - liveAtMs < READY_FLOOR_MS) return false
      if (woken) {
        const stamp = stateStampMs(current)
        if (stamp !== undefined && (baseStateAt === undefined || stamp > baseStateAt)) return true
        // A harness that reports no runtime state at all still has to be served.
        if (now - liveAtMs < READY_STATE_GRACE_MS) return false
      }
      const settled =
        current.terminal.lastOutputAtMs > baseOutputMs &&
        now - current.terminal.lastOutputAtMs >= READY_QUIET_MS
      return settled || now - liveAtMs >= READY_MAX_MS
    }
    const tick = (): void => {
      const current = this.deps.getSession(sessionId)
      if (!current || current.status === 'exited' || current.status === 'hibernated') {
        stop()
        return
      }
      const now = this.deps.now()
      if (current.status === 'live') {
        // Keep ownership of chat messages while the harness is working. Once a
        // prompt has been submitted into a CLI's own queue, an interrupt may
        // deliberately promote it into the next turn; holding it here is what
        // lets either native Escape or chat Stop retract it reliably.
        if (isAgentComputing(current)) {
          setTimeout(tick, HELD_POLL_MS).unref?.()
          return
        }
        if (!liveAtMs) {
          liveAtMs = now
          baseOutputMs = current.terminal.lastOutputAtMs
        }
        if (readyForInput(current, now) || now >= deadline) {
          deliverNext()
          return
        }
      } else if (now >= deadline) {
        stop()
        return
      }
      setTimeout(tick, READY_POLL_MS).unref?.()
    }
    setTimeout(tick, READY_POLL_MS).unref?.()
  }

  /**
   * Type an answer into the live native AskUserQuestion menu.
   *
   * The script below is not a guess: it was read out of the shipped Claude Code
   * bundle (2.1.226, then 2.1.228) and verified by driving a real session in a
   * PTY — docs/agent-harness-reference/claude.md §6 carries the contract, and
   * the screens are in docs/agents/evidence/pod-609-ask-menu-drive.md and
   * docs/agents/evidence/pod-770-preview-layout.md. Three facts
   * shape it, and each one is a way a payload can silently do NOTHING:
   *
   *  - ONE KEYSTROKE PER WRITE. The CLI's key parser folds a multi-character
   *    chunk into a SINGLE key event whose name is the whole string, so `"12"`
   *    arrives as the key "12", matches no digit, and the menu does not move at
   *    all. Every keystroke therefore leaves on its own timer (POD-609).
   *  - A MULTI-SELECT QUESTION DOES NOT ADVANCE. Its digits only toggle boxes;
   *    Tab moves to the next question's tab, and past the last question that
   *    tab IS the review step.
   *  - ONLY A LONE SINGLE-SELECT QUESTION SUBMITS ON THE DIGIT. Every other
   *    shape — several questions, or a multi-select — ends on "Ready to submit
   *    your answers?" with "Submit answers" focused, so one closing CR commits
   *    the set. Without it the agent stays blocked on a dialog nobody presses.
   *
   * That last asymmetry is why the CR is conditional: on the lone single-select
   * path the dialog is already gone, and a blind CR would land in the composer.
   *
   * THE DIALOG HAS TWO LAYOUTS, and the script differs in both routes (POD-770).
   * A single-select question whose options carry `preview` text is not a list at
   * all: options in a narrow left column, the focused option's preview on the
   * right, a "Notes" field under it, and NO Other row. There, a digit only MOVES
   * the highlight, a digit past the last option is dropped on the floor, Enter
   * selects the highlighted row, and `n` opens the Notes field. Driving it with
   * the classic script is how a typed answer became option 1 with the text lost:
   * `3` fell off the end, the text was one dead key event, and the CR committed
   * whatever was highlighted. `previewLayout` therefore rides with the answer,
   * exactly as `multiSelect` does.
   *
   * The answer routes, per layout:
   *  - Options, classic: the digit(s), one keystroke each — a single-select
   *    commits and advances on the digit.
   *  - Options, preview: the digit MOVES, so a CR must follow to select.
   *  - Free text, classic: the menu appends an Other entry after the agent
   *    options. Digit `otherIndex` focuses its field, the text follows, and a CR
   *    commits it as the custom answer — free text must never land as a raw chat
   *    send on top of an open menu.
   *  - Free text, preview: `n` focuses Notes, the text follows, and a CR commits
   *    it with no option selected.
   *  - Skip: Esc cancels the whole dialog ("User declined to answer questions"),
   *    so it takes no confirm.
   *
   * NOTHING IS TYPED UNTIL EVERY CHOICE IS DELIVERABLE. A choice this method
   * cannot express is a refusal, never a partial script: the questions it could
   * not answer stay on their first row, and the closing CR would commit those
   * rows as if the operator had picked them. The caller surfaces the reason.
   */
  answerAskUserQuestion(input: {
    sessionId: SessionId
    choices?: AnswerChoice[]
    skip?: boolean
    principal: InboxPrincipalReference
  }): { ok: boolean; reason?: string } {
    const session = this.deps.getSession(input.sessionId)
    const ownerUserId = this.deps.ownerOf(input.sessionId)
    // Attention is per-owner. An unresolved owner is not an invitation to send
    // to an ambient operator; fail closed before bytes or notifications move.
    // Bare `{ok:false}` here is pinned by the command oracle — the NEW refusal
    // class below is the one that carries a reason.
    if (!session || !ownerUserId || (session.status !== 'live' && session.status !== 'starting')) {
      return { ok: false }
    }
    const choices = input.skip ? [] : (input.choices ?? [])
    if (!input.skip && choices.length === 0) return { ok: false, reason: 'no choices to type' }
    for (let i = 0; i < choices.length; i++) {
      const choice = choices[i]
      const why = choice ? undeliverable(choice, i) : `question ${i + 1}: missing`
      if (why) return { ok: false, reason: why }
    }
    const attribution = input.principal.attribution
    let delayMs = 0
    let typed = false
    const key = (data: string, gapBefore = MENU_KEY_DELAY_MS): void => {
      if (typed) delayMs += gapBefore
      this.scheduleInput(input.sessionId, data, 'human', attribution, delayMs)
      typed = true
    }
    if (input.skip) {
      key('\x1b')
    } else {
      for (const choice of choices) {
        const preview = isPreviewLayout(choice)
        if ('freeText' in choice) {
          // Ink needs a frame to move focus into the field before characters
          // land as the custom answer rather than as menu keys.
          key(preview ? 'n' : String(choice.otherIndex))
          key(choice.freeText)
          key('\r')
        } else {
          const digits = choice.optionIndices.filter(isMenuDigit)
          if (preview) {
            // The digit only moves the cursor here; the CR is what selects.
            key(String(digits[0]))
            key('\r')
          } else {
            for (const digit of digits) key(String(digit))
          }
        }
        if (isMultiSelect(choice)) key('\t')
      }
      if (typed && !isLoneSingleSelect(choices)) key('\r', MENU_CONFIRM_DELAY_MS)
    }
    // Answering the agent's question is always a person acting.
    this.deps.prepareSend(input.sessionId, attribution, 'answer', 'human')
    this.deps.attention.answered({
      ownerUserId,
      sessionId: input.sessionId,
      attribution,
    })
    return { ok: true }
  }

  /** Send now, or after `delayMs`. The session is re-read at send time: a menu
   *  dies with its process, and a late keystroke must not land in whatever
   *  replaced it. Unref'd so a pending keystroke cannot hold the process up. */
  private scheduleInput(
    sessionId: SessionId,
    data: string,
    inputOrigin: ObservationInputOrigin,
    attribution: Attribution,
    delayMs: number,
  ): void {
    const send = (): void => {
      const session = this.deps.getSession(sessionId)
      if (!session || (session.status !== 'live' && session.status !== 'starting')) return
      this.sendInput(session, data, inputOrigin, attribution)
    }
    if (delayMs <= 0) {
      send()
      return
    }
    setTimeout(send, delayMs).unref?.()
  }

  stateChanged(input: {
    sessionId: SessionId
    prev: AgentRuntimeState | undefined
    next: AgentRuntimeState
    observation?: AgentObservation
  }): void {
    // A CLEARED MENU IS A RE-ARM (POD-1703). `typeText` refuses while the phase
    // is `needs_user` — correctly, since a prompt typed into an AskUserQuestion
    // menu answers the wrong question — and the drain then stops and waits for
    // "the next re-arm". That used to mean a daemon bind, which on a healthy
    // long-lived session may never come, so an offer clicked while the agent sat
    // on a permission prompt hung indefinitely. The moment the menu clears is
    // the exact edge that unblocks it, and it costs nothing on a session with an
    // empty queue (`drain` returns on queuedMessageCount === 0).
    if (input.prev?.phase === 'needs_user' && input.next.phase !== 'needs_user') {
      this.drain(input.sessionId)
    }
    const ownerUserId = this.deps.ownerOf(input.sessionId)
    if (!ownerUserId) return
    this.deps.attention.stateChanged({ ...input, ownerUserId })
  }

  /**
   * Controller-gated PTY input. Attribution is stamped from the transport
   * principal (ADR 3 D7) and retained LIVE only (POD-1081 §2). Concurrent
   * keystrokes are a control problem, not a text merge (readiness §4).
   */
  handleControllerInput(
    principal: ClientPrincipal,
    client: ClientConn,
    sessionId: SessionId,
    data: string,
  ): void {
    this.handleControllerInputBytes(principal, client, sessionId, Buffer.from(data, 'base64'))
  }

  handleControllerInputBytes(
    principal: ClientPrincipal,
    client: ClientConn,
    sessionId: SessionId,
    bytes: Uint8Array,
  ): void {
    if (bytes.byteLength === 0) return
    const session = this.deps.getSession(sessionId)
    if (!session) return
    // Live re-auth at apply: a revoked human (or their agent) loses control here
    // rather than via a reaper (ADR 9 D5 A1 / ADR 3 D8).
    if (this.deps.authorizeDrive && !this.deps.authorizeDrive(principal, sessionId)) {
      if (session.terminal.controllerId === client.id) session.terminal.revokeController()
      return
    }
    // The native terminal sees the operator's abort key before the transcript
    // can report its result. Cancel a chat-owned delayed Enter at this boundary,
    // or the 90ms submit timer can win and start the prompt after Codex has
    // already printed "Conversation interrupted" (POD-1733). Compared as bytes:
    // this path no longer carries the base64 the check was first written for.
    const abort = this.abortKeyFor(session)
    if (session.terminal.controllerId === client.id && abort && Buffer.from(abort).equals(bytes)) {
      this.cancelInterruptedDelivery(sessionId, true)
    }
    session.terminal.handleInputBytes(
      client.id,
      bytes,
      inboxPrincipalFromClient(principal).attribution,
    )
  }

  /**
   * Preemptive take-control (POD-1081 §3). The current controller cannot refuse;
   * rights are re-checked live against owner/grants + machine use.
   */
  requestControl(
    principal: ClientPrincipal,
    client: ClientConn,
    sessionId: SessionId,
    geometry?: Geometry,
  ): void {
    const session = this.deps.getSession(sessionId)
    if (!session) return
    if (this.deps.authorizeDrive && !this.deps.authorizeDrive(principal, sessionId)) {
      client.send({
        type: 'terminalOutcome',
        sessionId,
        outcome: 'unauthorized',
      })
      return
    }
    session.terminal.requestControl(client.id, geometry)
  }

  /**
   * If exactly one connection renders the native terminal, make it the driver.
   * Person-level presence intentionally collapses a user's devices, so sizing
   * policy derives from the terminal's per-connection renderer set instead.
   */
  reconcileActiveRenderer(sessionId: SessionId): boolean {
    const session = this.deps.getSession(sessionId)
    if (!session) return false
    const [sole, second] = session.terminal.activeNativeRenderers()
    if (!sole || second) return false
    if (this.deps.authorizeDrive && !this.deps.authorizeDrive(sole.principal, sessionId))
      return false
    const previous = session.terminal.controllerId
    // Never auto-transfer on a stale/unknown grid. A newly active renderer
    // reports its current viewport immediately; handleResize calls back into
    // this method after storing that measurement.
    if (previous !== sole.id && !sole.viewports.has(sessionId)) return false
    session.terminal.requestControl(sole.id)
    return previous !== session.terminal.controllerId
  }

  handleResize(
    principal: ClientPrincipal,
    client: ClientConn,
    sessionId: SessionId,
    cols: number,
    rows: number,
  ): boolean {
    void principal
    const session = this.deps.getSession(sessionId)
    if (!session) return false
    session.terminal.handleResize(client.id, cols, rows)
    return this.reconcileActiveRenderer(sessionId)
  }

  reconcileGeometry(principal: ClientPrincipal, client: ClientConn, sessionId: SessionId): void {
    void principal
    this.deps.getSession(sessionId)?.terminal.reconcileGeometry(client.id)
  }

  private typeText(
    input: InboxSendInput & { recordSend?: boolean },
    afterEsc = false,
  ): { ok: boolean } {
    const session = this.deps.getSession(input.sessionId)
    if (!session || (session.status !== 'live' && session.status !== 'starting')) {
      return { ok: false }
    }
    if (!afterEsc && session.agentState?.phase === 'needs_user') return { ok: false }
    const principal = input.principal ?? SYSTEM_INBOX_PRINCIPAL
    if (input.recordSend !== false)
      this.deps.prepareSend(
        input.sessionId,
        principal.attribution,
        'text',
        input.inputOrigin ?? 'controller',
      )
    const baseline = session.terminal
      .transcriptItems()
      .filter((item) => item.role === 'user').length
    // Grok's fresh TUI ignores bracketed paste until a native first turn
    // (POD-549). Type the first prompt as raw keystrokes so chat-view send
    // matches what works in the native composer (POD-901).
    const payload = this.isRawFirstTurn(session) ? input.text : `\x1b[200~${input.text}\x1b[201~`
    this.sendInput(session, payload, input.inputOrigin ?? 'controller', principal.attribution)
    const generation = ++this.nextSubmitVerificationGeneration
    this.submitVerificationGeneration.set(input.sessionId, generation)
    setTimeout(() => {
      if (this.submitVerificationGeneration.get(input.sessionId) !== generation) return
      const current = this.deps.getSession(input.sessionId)
      if (!current || (current.status !== 'live' && current.status !== 'starting')) {
        this.submitVerificationGeneration.delete(input.sessionId)
        return
      }
      this.sendInput(current, '\r', input.inputOrigin ?? 'controller', principal.attribution)
      if (this.deps.needsSubmitVerification(current.agentKind)) {
        this.scheduleSubmitVerify(input.sessionId, baseline, principal.attribution, 1, generation)
      } else {
        this.submitVerificationGeneration.delete(input.sessionId)
      }
    }, SUBMIT_CR_DELAY_MS).unref?.()
    return { ok: true }
  }

  private scheduleSubmitVerify(
    sessionId: SessionId,
    baselineUserTurns: number,
    attribution: Attribution,
    attempt: number,
    generation: number,
  ): void {
    setTimeout(() => {
      if (this.submitVerificationGeneration.get(sessionId) !== generation) return
      const session = this.deps.getSession(sessionId)
      if (!session || (session.status !== 'live' && session.status !== 'starting')) {
        this.submitVerificationGeneration.delete(sessionId)
        return
      }
      const phase = session.agentState?.phase
      if (phase !== undefined && phase !== 'idle') {
        this.submitVerificationGeneration.delete(sessionId)
        return
      }
      if (
        session.terminal.transcriptItems().filter((item) => item.role === 'user').length >
        baselineUserTurns
      ) {
        this.submitVerificationGeneration.delete(sessionId)
        return
      }
      this.sendInput(session, '\r', 'controller', attribution)
      if (attempt < SUBMIT_MAX_RETRIES) {
        this.scheduleSubmitVerify(
          sessionId,
          baselineUserTurns,
          attribution,
          attempt + 1,
          generation,
        )
      } else {
        this.submitVerificationGeneration.delete(sessionId)
      }
    }, SUBMIT_VERIFY_DELAY_MS).unref?.()
  }

  private isRawFirstTurn(session: Session): boolean {
    if (!this.deps.usesRawFirstTurn(session.agentKind)) return false
    return session.terminal.transcriptItems().every((item) => item.role !== 'user')
  }

  private sendInput(
    session: Session,
    data: string,
    inputOrigin: ObservationInputOrigin,
    attribution: Attribution,
  ): void {
    session.terminal.recordInputActivity(this.deps.now(), inputOrigin)
    // Live last-input attribution for watchers (POD-1081 §2). The durable half
    // of intentional sends remains the queue row, not this field.
    session.terminal.noteInputAttribution(attribution)
    this.deps.daemon.sendInput(session.machineId, {
      bytes: Buffer.from(data),
      sessionId: session.sessionId,
      inputOrigin,
      attribution,
    })
  }
}

export const inboxActorColumns = (
  actor: ActorRef,
): { actorKind: 'user' | 'agent' | 'system'; actorId: string } => {
  if (actor.kind === 'machine') {
    throw new Error('machine principals cannot originate session inbox input')
  }
  return {
    actorKind: actor.kind,
    actorId: actor.kind === 'system' ? actor.job : actor.id,
  }
}

export const inboxActorFromColumns = (kind: 'user' | 'agent' | 'system', id: string): ActorRef => {
  switch (kind) {
    case 'user':
      return actorUser(asUserId(id))
    case 'agent':
      return actorAgent(asAgentIdentityId(id))
    case 'system':
      return actorSystem(id)
  }
}
