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
  SessionId,
  UserId,
} from '@podium/model'
import { actorAgent, actorSystem, actorUser, asAgentIdentityId, asUserId } from '@podium/model'
import type { AgentObservation, ObservationInputOrigin } from '@podium/protocol'
import { asDelegationRef, type DelegationRef } from '@podium/protocol'
import type { CommandPrincipal } from '../../command-principal'
import type { ClientPrincipal } from '../../gateway/client-principal'
import type { ClientConn } from '../../gateway/client-registry'
import type { SessionInputGatewayPort } from '../../gateway/daemon-ports'
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
  bumpAttempts(id: string): void
  delete(id: string): void
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
 * `multiSelect` is the QUESTION's shape, not the answer's, and it travels
 * because the menu cannot be driven without it — see
 * {@link SessionInbox.answerAskUserQuestion}.
 */
export type AnswerChoice = { multiSelect?: boolean } & (
  | { optionIndices: number[] }
  | { freeText: string; otherIndex: number }
)

/** Several picks can only have come from a multi-select, so a client that
 *  cannot say so is still read correctly. */
const isMultiSelect = (choice: AnswerChoice): boolean =>
  choice.multiSelect ?? ('optionIndices' in choice && choice.optionIndices.length > 1)

/** The ONE shape the native menu commits by itself, so the ONE shape that must
 *  not be given a closing CR. Kept next to the choice type because both sides
 *  of the asymmetry have to read the same way. */
const isLoneSingleSelect = (choices: AnswerChoice[]): boolean => {
  const only = choices.length === 1 ? choices[0] : undefined
  return only !== undefined && !isMultiSelect(only)
}

export interface InboxSendInput {
  sessionId: SessionId
  text: string
  inputOrigin?: ObservationInputOrigin
  principal?: InboxPrincipalReference
  sourceMessageId?: string
}

export class SessionInbox {
  private readonly activeDrains = new Set<SessionId>()

  constructor(private readonly deps: SessionInboxDeps) {}

  isDraining(sessionId: SessionId): boolean {
    return this.activeDrains.has(sessionId)
  }

  sendText(input: InboxSendInput): { ok: boolean; queued?: boolean; reason?: string } {
    const session = this.deps.getSession(input.sessionId)
    if (session && (session.queuedMessageCount > 0 || this.isDraining(input.sessionId))) {
      return this.queueText(input)
    }
    return this.typeText(input)
  }

  resumeAndSend(input: InboxSendInput & { mutationId?: string }): {
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
    this.sendInput(session, '\x1b', input.inputOrigin ?? 'controller', principal.attribution)
    setTimeout(() => this.typeText({ ...input, principal }, true), SUBMIT_CR_DELAY_MS).unref?.()
    return { ok: true }
  }

  queueText(input: InboxSendInput & { mutationId?: string }): {
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

  drain(sessionId: SessionId): void {
    if (this.activeDrains.has(sessionId)) return
    const session = this.deps.getSession(sessionId)
    if (!session || session.queuedMessageCount === 0) return
    this.activeDrains.add(sessionId)
    const deadline = this.deps.now() + QUEUE_DRAIN_DEADLINE_MS
    let liveAtMs = 0
    let baseOutputMs = 0
    const stop = () => this.activeDrains.delete(sessionId)
    const removeHead = (current: Session, id: string): void => {
      this.deps.queue.delete(id)
      current.queuedMessageCount = Math.max(0, current.queuedMessageCount - 1)
      this.deps.persist(current)
      this.deps.broadcast()
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
      this.deps.queue.bumpAttempts(head.id)
      // The security boundary is HERE, immediately before the daemon gateway.
      // Nothing accepted at enqueue is trusted now.
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
      } else {
        const sent = this.typeText({
          sessionId,
          text: head.text,
          inputOrigin: head.inputOrigin,
          principal: head.principal,
          ...(head.sourceMessageId ? { sourceMessageId: head.sourceMessageId } : {}),
          recordSend: false,
        })
        if (!sent.ok) {
          stop()
          return
        }
        removeHead(current, head.id)
      }
      if (current.queuedMessageCount > 0) {
        setTimeout(deliverNext, QUEUE_MESSAGE_SPACING_MS).unref?.()
      } else stop()
    }
    const tick = (): void => {
      const current = this.deps.getSession(sessionId)
      if (!current || current.status === 'exited' || current.status === 'hibernated') {
        stop()
        return
      }
      const now = this.deps.now()
      if (current.status === 'live') {
        if (!liveAtMs) {
          liveAtMs = now
          baseOutputMs = current.terminal.lastOutputAtMs
        }
        const settled =
          current.terminal.lastOutputAtMs > baseOutputMs &&
          now - liveAtMs >= READY_FLOOR_MS &&
          now - current.terminal.lastOutputAtMs >= READY_QUIET_MS
        if (settled || now - liveAtMs >= READY_MAX_MS || now >= deadline) {
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
   * bundle (2.1.226) and then verified by driving a real session in a PTY —
   * docs/agent-harness-reference/claude.md §6 carries the contract and
   * docs/agents/evidence/pod-609-ask-menu-drive.md the screens. Three facts
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
   * The three answer routes ride the SAME script (POD-599 brought the last two):
   *  - Options: the digit(s), one keystroke each.
   *  - Free text: the native menu always has an Other entry after the agent
   *    options. Digit `otherIndex` focuses its field, the text follows, and a CR
   *    commits it as the custom answer — free text must never land as a raw chat
   *    send on top of an open menu.
   *  - Skip: Esc cancels the whole dialog ("User declined to answer questions"),
   *    so it takes no confirm.
   */
  answerAskUserQuestion(input: {
    sessionId: SessionId
    choices?: AnswerChoice[]
    skip?: boolean
    principal: InboxPrincipalReference
  }): { ok: boolean } {
    const session = this.deps.getSession(input.sessionId)
    const ownerUserId = this.deps.ownerOf(input.sessionId)
    // Attention is per-owner. An unresolved owner is not an invitation to send
    // to an ambient operator; fail closed before bytes or notifications move.
    if (!session || !ownerUserId || (session.status !== 'live' && session.status !== 'starting')) {
      return { ok: false }
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
      const choices = input.choices ?? []
      for (const choice of choices) {
        if ('freeText' in choice) {
          const otherIndex = choice.otherIndex
          if (!Number.isInteger(otherIndex) || otherIndex < 1 || otherIndex > 9) continue
          // Ink needs a frame to move focus into the field before characters
          // land as the custom answer rather than as menu digits.
          key(String(otherIndex))
          key(choice.freeText)
          key('\r')
        } else {
          const digits = choice.optionIndices.filter((n) => Number.isInteger(n) && n >= 1 && n <= 9)
          if (digits.length === 0) continue
          for (const digit of digits) key(String(digit))
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
    const session = this.deps.getSession(sessionId)
    if (!session) return
    // Live re-auth at apply: a revoked human (or their agent) loses control here
    // rather than via a reaper (ADR 9 D5 A1 / ADR 3 D8).
    if (this.deps.authorizeDrive && !this.deps.authorizeDrive(principal, sessionId)) {
      if (session.terminal.controllerId === client.id) session.terminal.revokeController()
      return
    }
    session.terminal.handleInput(client.id, data, inboxPrincipalFromClient(principal).attribution)
  }

  /**
   * Preemptive take-control (POD-1081 §3). The current controller cannot refuse;
   * rights are re-checked live against owner/grants + machine use.
   */
  requestControl(principal: ClientPrincipal, client: ClientConn, sessionId: SessionId): void {
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
    session.terminal.requestControl(client.id)
  }

  handleResize(
    principal: ClientPrincipal,
    client: ClientConn,
    sessionId: SessionId,
    cols: number,
    rows: number,
  ): void {
    void principal
    this.deps.getSession(sessionId)?.terminal.handleResize(client.id, cols, rows)
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
    const baseline = session.terminal.transcriptItems().filter((item) => item.role === 'user').length
    this.sendInput(
      session,
      `\x1b[200~${input.text}\x1b[201~`,
      input.inputOrigin ?? 'controller',
      principal.attribution,
    )
    setTimeout(
      () => this.sendInput(session, '\r', input.inputOrigin ?? 'controller', principal.attribution),
      SUBMIT_CR_DELAY_MS,
    ).unref?.()
    if (this.deps.needsSubmitVerification(session.agentKind)) {
      this.scheduleSubmitVerify(input.sessionId, baseline, principal.attribution, 1)
    }
    return { ok: true }
  }

  private scheduleSubmitVerify(
    sessionId: SessionId,
    baselineUserTurns: number,
    attribution: Attribution,
    attempt: number,
  ): void {
    setTimeout(() => {
      const session = this.deps.getSession(sessionId)
      if (!session || (session.status !== 'live' && session.status !== 'starting')) return
      const phase = session.agentState?.phase
      if (phase !== undefined && phase !== 'idle') return
      if (
        session.terminal.transcriptItems().filter((item) => item.role === 'user').length > baselineUserTurns
      )
        return
      this.sendInput(session, '\r', 'controller', attribution)
      if (attempt < SUBMIT_MAX_RETRIES) {
        this.scheduleSubmitVerify(sessionId, baselineUserTurns, attribution, attempt + 1)
      }
    }, SUBMIT_VERIFY_DELAY_MS).unref?.()
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
      type: 'input',
      sessionId: session.sessionId,
      inputOrigin,
      data: Buffer.from(data).toString('base64'),
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
