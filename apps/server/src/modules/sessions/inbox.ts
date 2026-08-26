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
  agentErrorRecoveryInstruction,
  formatAgentError,
  actorAgent,
  actorSystem,
  actorUser,
  asAgentIdentityId,
  asMutationId,
  asSessionId,
  asUserId,
  isAgentComputing,
} from '@podium/model'
import type { AgentObservation, ObservationInputOrigin } from '@podium/protocol'
import type { Refusal, TurnReceipt } from '@podium/protocol/daemon'
import { asDelegationRef, type DelegationRef } from '@podium/protocol'
import type { CommandPrincipal } from '../../command-principal'
import type { ClientPrincipal } from '../../gateway/client-principal'
import type { ClientConn } from '../../gateway/client-registry'
import type { SessionInputGatewayPort } from '../../gateway/daemon-ports'
import type { HarnessComposerReadiness, HarnessInterrupt } from '../../harness-manifest'
import { injectionPayload } from './paste'
import type { Session } from './session'

/**
 * What `sessions.interrupt` answers, and what each half of it means (POD-2792).
 *
 * `ok` is "the interrupt was REQUESTED", never "the turn stopped" — see
 * {@link SessionInbox.interruptTurn} for why nothing synchronous can say the
 * second. `requested` names the delivery that carried it, so a caller reading
 * only this object can tell a keystroke typed at a TUI from a request a driver
 * accepted over its protocol; they are different proofs and collapsing them is
 * how the two paths came to look alike while only one of them worked.
 *
 * `reason` is user-facing: the chat composer prints it verbatim.
 */
export type InterruptOutcome =
  | { ok: true; requested: 'keystroke' | 'protocol'; reason?: undefined }
  | { ok: false; reason: string; requested?: undefined }

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
 * A WOKEN session's readiness budget (POD-1100). A state report is not a
 * readiness witness: the PTY can report a fresh runtime state while the CLI is
 * still painting its composer. Keep the conservative quiet/ceiling heuristic;
 * never shorten it because a harness state stamp changed.
 */
/** Liveness budget for a wake. A cold resume of a large session routinely
 *  outran the 25s a live session gets, and gave up before the PTY had bound. */
const WOKEN_DRAIN_DEADLINE_MS = 60_000
/** How long a typed prompt has to show up as a turn before we call it lost.
 *  Only counted while the agent is FREE to take it — see {@link SessionInbox.drain}. */
const CONFIRM_TIMEOUT_MS = 5_000
/** A creation prompt gets one longer confirmation window before it is failed
 * visibly; ordinary queued sends retain the shorter retry cadence. */
const INITIAL_PROMPT_CONFIRM_TIMEOUT_MS = 30_000
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
/** Prefix of the normalized prompt used to recognise it in the transcript. */
const CONFIRM_NEEDLE_CHARS = 80
/** Below this, a needle matches too much of the transcript to be evidence. */
const CONFIRM_NEEDLE_MIN_CHARS = 12

/** Stable queue key for the prompt supplied in the session creation request. */
const INITIAL_PROMPT_QUEUE_ID_PREFIX = 'session-initial-prompt:'

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
   *  (POD-1242). Between this and {@link applied} the message is the harness's,
   *  not the queue's — nothing more will be typed, and nothing can be retracted. */
  injected?(input: { sourceMessageId: string; sessionId: SessionId }): void
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
  /** A queued input was not witnessed before its bounded confirmation window. */
  promptFailed(input: {
    ownerUserId?: UserId
    sessionId: SessionId
    text: string
    reason: string
    initialPrompt: boolean
  }): void
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
  /** When this harness's composer is known to accept typed input after a bind —
   *  see {@link SessionInbox.needsInputReadiness}. */
  composerReadiness(agentKind: AgentKind): HarnessComposerReadiness
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
  /** Seed/restore the server-persisted composer draft without a client echo. */
  setSessionDraft?(input: { sessionId: SessionId; text: string }): void
  /** Read the current draft so automatic recovery never overwrites a human edit. */
  draftText?(sessionId: SessionId): string | undefined
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
  /**
   * Is this session driven by a runtime driver with NO PTY bridge behind it
   * (POD-2291)?
   *
   * The drain below branches on it because typing at such a session is not
   * merely suboptimal, it is a guaranteed silent loss: the daemon's `input`
   * handler resolves the PTY bridge by session id, finds none, and discards the
   * bytes with no error — while this side reports the row applied. The fact is
   * read off the bind-reported contract flag, so it is only ever true for a
   * LIVE session; a `starting` one stays on the queue until bind says which
   * family it became.
   *
   * Production answers it by ruling a terminal driver IN rather than a server
   * driver OUT, so a driver id this build's manifests do not know — or a bind
   * that carries no driver id at all — still takes the contract path
   * (POD-2327). See `session-wiring.ts` for why that asymmetry is the safe one.
   */
  serverDriven?(session: Session): boolean
  /**
   * Deliver one queued row through the runtime contract (`when-ready`), for
   * sessions {@link serverDriven} says have no PTY to type into.
   *
   * The receipt is the driver's own answer, not a prediction. Optional only as
   * a fixture affordance: production always wires it, and a server-driven
   * session without it leaves rows visibly queued rather than typing them into
   * the void.
   */
  contractDeliver?(input: {
    sessionId: SessionId
    turnId: string
    text: string
    origin: ObservationInputOrigin
    principal: InboxPrincipalReference
  }): Promise<TurnReceipt>
  /**
   * REQUEST an interrupt through the runtime contract, for sessions
   * {@link serverDriven} says have no PTY to type an abort key into.
   *
   * The answer is the DRIVER's, and it says the request was accepted or names
   * the reason it was not — it never says the turn stopped. The fence is a
   * provider-confirmed terminal turn event on the causal stream, and this reply
   * is not it (see {@link SessionInbox.interruptTurn}).
   *
   * Optional only as a fixture affordance, and the missing case REFUSES rather
   * than confirming: a stop that cannot be delivered must say so.
   */
  contractInterrupt?(sessionId: SessionId): Promise<{ ok: true } | Refusal>
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
  /** Only the existing recovery interaction may cross a terminal provider failure. */
  allowErrored?: boolean
}

/** Wrapping and indentation are the harness's, not the author's — compare on
 *  neither. */
const normalizeForMatch = (text: string): string => text.replace(/\s+/g, ' ').trim()

/**
 * The fragment of a queued prompt we look for in the transcript to know the CLI
 * accepted it. A prefix, because a harness may elide or decorate the tail of a
 * long paste; the complete normalized prompt when its identity must be exact;
 * null when the prompt is too short to be evidence of anything.
 */
const confirmationNeedle = (text: string, exact = false): string | null => {
  const normalized = normalizeForMatch(text)
  // Nothing to look for. The only genuinely unwitnessable send.
  if (normalized.length === 0) return null
  if (normalized.length < CONFIRM_NEEDLE_MIN_CHARS && !exact) return null
  return exact ? normalized : normalized.slice(0, CONFIRM_NEEDLE_CHARS)
}

const initialPromptQueueId = (sessionId: SessionId): string =>
  `${INITIAL_PROMPT_QUEUE_ID_PREFIX}${sessionId}`

const isInitialPromptRow = (sessionId: SessionId, row: QueuedInboxMessage): boolean =>
  row.id === initialPromptQueueId(sessionId)

/** The LAST user turn, and whether it is ours. Deliberately the tail rather than
 *  a count: the daemon re-reads a resumed transcript as a `reset` delta, which
 *  moves every count but leaves the tail meaning what it means. */
const tailUserTurnMatches = (session: Session, needle: string, exact = false): boolean => {
  const items = session.terminal.transcriptItems()
  for (let i = items.length - 1; i >= 0; i--) {
    const item = items[i]
    if (item?.role !== 'user') continue
    const normalized = normalizeForMatch(item.text)
    return exact ? normalized === needle : normalized.includes(needle)
  }
  return false
}

/** Archive records deliberate human intent, never a provider failure that a
 * recovery answer may override. Keep this gate separate from
 * {@link terminalSessionSendFailureReason}: combining them makes
 * `allowErrored` an archive bypass. */
export function archivedSessionSendReason(session: Pick<Session, 'archived'>): string | undefined {
  return session.archived ? 'session is archived' : undefined
}

/** The terminal provider failure that the one recovery-answer flow may cross. */
export function terminalSessionSendFailureReason(
  session: Pick<Session, 'agentState'>,
): string | undefined {
  const state = session.agentState
  if (state?.phase !== 'errored' || !state.error || state.error.retryable) return undefined
  return formatAgentError(state.error) + '. ' + agentErrorRecoveryInstruction(state.error)
}

/** Has this session ever carried a user turn? The transcript is the only record
 *  that survives a rebind, which is what makes it the start-up window's edge. */
function hasSeenUserTurn(session: Session): boolean {
  return session.terminal.transcriptItems().some((item) => item.role === 'user')
}

/** Refuse archive unconditionally; only provider failure is overridable. */
function sessionSendRefusalReason(
  session: Pick<Session, 'agentState' | 'archived'>,
  allowErrored: boolean,
): string | undefined {
  return (
    archivedSessionSendReason(session) ??
    (allowErrored ? undefined : terminalSessionSendFailureReason(session))
  )
}

export class SessionInbox {
  private readonly activeDrains = new Set<SessionId>()
  /** Recovery answers may queue while a failed session is being woken. */
  private readonly recoveryDrains = new Set<SessionId>()
  /**
   * A PTY bind makes a session live before its harness composer is ready. Keep
   * this marker on the session object rather than retaining session ids here.
   */
  private readonly inputReadySessions = new WeakSet<Session>()
  /**
   * WHEN THIS SESSION'S PTY LAST BOUND — the composer-readiness clock's zero
   * (POD-2836). Held here, beside the readiness marker the same bind clears,
   * because the bind is already announced to this object and nothing else
   * records the moment; a durable field would be a second, weaker copy of a
   * fact that only matters while the process it describes is still running.
   *
   * Session-keyed for the same reason {@link inputReadySessions} is: the entry
   * dies with the row rather than being reaped by id.
   */
  private readonly boundAtMs = new WeakMap<Session, number>()
  /** One durable attention event per queued row and failure episode. */
  private readonly reportedPromptFailures = new Set<string>()
  /** Set by {@link dispose}; read at every drain re-entry point. */
  private disposed = false

  constructor(private readonly deps: SessionInboxDeps) {}

  /**
   * THE DRAIN IS A LOOP, AND A LOOP OUTLIVES THE REGISTRY THAT STARTED IT
   * (POD-2842).
   *
   * `drain` re-arms itself on a timer — `READY_POLL_MS` while it waits for the
   * composer, `CONFIRM_POLL_MS` while it waits for the transcript turn that
   * proves the row landed — and every one of those wake-ups reads
   * `deps.queue.list(...)`, which is a read against the SQLite handle.
   * `server.ts` closes that handle one step after `registry.dispose()`, for the
   * reason its own shutdown comment gives: "a late write against a closed DB
   * would throw". Nothing was stopping this loop, so a shutdown taken while a
   * row was in flight woke into a closed store and threw
   * `RangeError: Cannot use a closed database` out of a detached timer.
   *
   * IT BECAME REACHABLE WHEN THE QUEUE BECAME THE CONTRACT. A claude-code row
   * is held after it is typed until a transcript user turn confirms it
   * (POD-2116), so the window in which a drain is still polling is now the
   * ordinary case rather than a rare one — `relay.outbox.test.ts`'s restart
   * check reproduces it verbatim, disposing one registry and closing its store
   * while the row it queued is still waiting.
   *
   * A stopped drain loses nothing: the row is durable, and the next bind,
   * reconnect or enqueue re-arms a fresh pass over it.
   */
  dispose(): void {
    this.disposed = true
    this.activeDrains.clear()
  }

  isDraining(sessionId: SessionId): boolean {
    return this.activeDrains.has(sessionId)
  }

  /** A new bind starts a fresh harness-readiness window — and STAMPS it, so the
   *  drain can tell a composer that has had an hour to mount from one that has
   *  had a second (POD-2836). */
  markSessionBound(sessionId: SessionId): void {
    const session = this.deps.getSession(sessionId)
    if (!session) return
    this.inputReadySessions.delete(session)
    this.boundAtMs.set(session, this.deps.now())
  }

  /**
   * Queue the prompt that arrived with session creation. Its deterministic id
   * keeps the proof requirement recognizable if the server restarts before the
   * first turn is observed.
   */
  queueInitialPrompt(input: InboxSendInput): {
    ok: boolean
    queued?: boolean
    reason?: string
  } {
    return this.queueText({
      ...input,
      mutationId: asMutationId(initialPromptQueueId(input.sessionId)),
    })
  }

  /**
   * A BIND MAKES A SESSION LIVE BEFORE ITS COMPOSER IS UP, and for some
   * harnesses nothing says when that changed (POD-2823).
   *
   * This asked `session.agentKind === 'claude-code'` first. The literal was not
   * standing in for "this is Claude": it was NARROWING the capability on the
   * line below it, because `submitVerification` is true for grok as well, and
   * reading that field alone would have put every post-first-turn grok send
   * behind a readiness proof grok does not need. Two harnesses share the
   * verification property and do not share this one — which is exactly why the
   * name looked load-bearing.
   *
   * `composerReadiness` is the property the literal actually meant, so the
   * `needsSubmitVerification` conjunct goes with it: it was the nearest existing
   * capability, not the right one, and it is not load-bearing here. A readiness
   * proof drives its own `confirm()` in the drain loop (`needsReadinessProof`
   * below), independently of whether a submit is separately verified.
   *
   * `!isRawFirstTurn` STAYS, and now guards something statable rather than
   * something incidental: a harness that needs a confirmed turn AND injects its
   * first turn raw would have that turn queued twice over, once by `sendText`'s
   * settle wait and once here. No harness declares both today.
   */
  private needsInputReadiness(session: Session): boolean {
    return (
      this.deps.composerReadiness(session.agentKind) === 'confirmed-turn' &&
      !this.isRawFirstTurn(session) &&
      !this.inputReadySessions.has(session)
    )
  }

  /**
   * The refusals `typeText` would give this send, asked BEFORE the readiness
   * queue can turn them into an acceptance. Deliberately only the ones that are
   * about the session being un-typeable right now, and deliberately NOT the
   * server-family case: a server-driven session has no PTY, and queueing is how
   * its row is delivered rather than a way of losing it — the drain's contract
   * branch is the path that carries it (POD-2291).
   */
  private readinessQueueRefusal(session: Session): { ok: false } | undefined {
    if (this.deps.serverDriven?.(session) === true) return undefined
    if (session.status !== 'live' && session.status !== 'starting') return { ok: false }
    if (session.agentState?.phase === 'needs_user') return { ok: false }
    return undefined
  }

  sendText(input: InboxSendInput): { ok: boolean; queued?: boolean; reason?: string } {
    const session = this.deps.getSession(input.sessionId)
    const blockedReason = session
      ? sessionSendRefusalReason(session, input.allowErrored === true)
      : undefined
    if (blockedReason) return { ok: false, reason: blockedReason }
    if (session && (session.queuedMessageCount > 0 || this.isDraining(input.sessionId))) {
      return this.queueText(input)
    }
    if (session && this.needsInputReadiness(session)) {
      // THE READINESS QUEUE MUST NOT SWALLOW A REFUSAL (POD-2828).
      //
      // Diverting to the queue moved this send PAST the guards `typeText`
      // applies, so a send that had to be REFUSED came back `{ok: true,
      // queued: true}` instead. The queue is a place to wait for a composer
      // that is coming, not a place to put a send that must not happen — and
      // "not yet" and "no" are not the same answer to give a caller.
      //
      // #473 IS WHY THIS IS A SAFETY FIX AND NOT A SHAPE ONE. A submitting CR
      // typed at a live AskUserQuestion menu ANSWERS THE HIGHLIGHTED DEFAULT:
      // it picks an option on the human's behalf. `typeText` refuses that, and
      // the design is that the human resends once the menu resolves. Queued,
      // the same send is accepted, held, and then typed when the menu clears —
      // a message the caller was told was fine, delivered into a conversation
      // that has since moved on.
      const refusal = this.readinessQueueRefusal(session)
      if (refusal) return refusal
      return this.queueText(input)
    }
    // THE SAME QUESTION AS `needsInputReadiness`, ASKED OF A HARNESS THAT CAN
    // ANSWER IT FROM STATUS (POD-2823). A process that has bound but not
    // finished its TUI still reports `starting`; typing into that PTY is the
    // POD-549 no-op, so wait for settle. This used to read the raw-first-turn
    // flag, which conflated two facts that only happen to coincide in grok —
    // how a first turn is INJECTED, and how the composer's start-up window is
    // OBSERVED. The injection meaning stays on `rawFirstTurn`; this one is the
    // readiness declaration.
    if (
      session?.status === 'starting' &&
      this.deps.composerReadiness(session.agentKind) === 'process-settle' &&
      !hasSeenUserTurn(session)
    ) {
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
    const blockedReason = sessionSendRefusalReason(session, input.allowErrored === true)
    if (blockedReason) return { ok: false, reason: blockedReason }
    if (session.status === 'live' && session.queuedMessageCount === 0) return this.sendText(input)
    return this.queueText({ ...input, mutationId: input.mutationId })
  }

  interruptText(input: InboxSendInput): { ok: boolean; queued?: boolean; reason?: string } {
    const session = this.deps.getSession(input.sessionId)
    const blockedReason = session
      ? sessionSendRefusalReason(session, input.allowErrored === true)
      : undefined
    if (blockedReason) return { ok: false, reason: blockedReason }
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

  /**
   * Interrupt the active native turn without injecting a replacement prompt.
   *
   * WHAT `ok: true` CLAIMS, SAID EXACTLY, because the difference is the whole
   * bug (POD-2792). It claims the interrupt was REQUESTED — the abort key went
   * to the terminal, or the driver accepted the request — and `requested` names
   * which of those two happened. It does NOT claim the turn stopped. Nothing
   * synchronous can: the contract models `interrupt()` as a request for a fence,
   * and the fence is a provider-confirmed terminal turn event that arrives later
   * on the causal stream. A reply that said "stopped" would be a claim this
   * server cannot check, which is the shape of lie this issue is about.
   *
   * TWO PATHS, BECAUSE THERE ARE TWO KINDS OF SESSION, and routing every stop
   * down the terminal one is what made the button lie. A server-family session
   * has no PTY: the daemon finds no bridge for its `input` frame, logs
   * `discarding input bytes for a bridgeless contract session` and drops the
   * abort key on the floor — while this method had already answered `ok: true`.
   * That is POD-2291's vanish, reached through the stop button instead of
   * through a queued row, and it was measured on the opencode headless arm as
   * "the interrupt returns ok and the turn runs on". The contract branch below
   * is the delivery those sessions actually have; every server driver
   * implements `interrupt()` and none of them was ever called.
   */
  interruptTurn(input: Omit<InboxSendInput, 'text'>): InterruptOutcome | Promise<InterruptOutcome> {
    const session = this.deps.getSession(input.sessionId)
    if (!session || (session.status !== 'live' && session.status !== 'starting')) {
      return { ok: false, reason: 'session not running' }
    }
    if (this.deps.serverDriven?.(session) === true) return this.contractInterrupt(session, input)
    const abort = this.abortKeyFor(session)
    // REFUSED, not skipped: unlike interruptText there is nothing else this call
    // does, so a silent `{ ok: true }` would be the lie POD-1214 set out to fix —
    // the operator pressed stop and would be told it worked. The reason is
    // user-facing (the chat composer prints it verbatim).
    if (!abort) {
      return {
        ok: false,
        reason: `${this.deps.harnessName(session.agentKind)} only takes an interrupt while it is working, and it is not working right now`,
      }
    }
    const principal = input.principal ?? SYSTEM_INBOX_PRINCIPAL
    this.sendInput(session, abort, input.inputOrigin ?? 'controller', principal.attribution)
    return { ok: true, requested: 'keystroke' }
  }

  /**
   * The stop, for a session with no terminal to type it into.
   *
   * The reason travels back VERBATIM where the driver gave one: the chat
   * composer prints this string, and 'not_running' with the driver's own detail
   * tells an operator more than a sentence this layer invented would. The
   * unwired case refuses rather than confirming — a fixture without the port is
   * still a stop that did not happen.
   */
  private async contractInterrupt(
    session: Session,
    input: Omit<InboxSendInput, 'text'>,
  ): Promise<InterruptOutcome> {
    const request = this.deps.contractInterrupt
    if (!request) {
      return {
        ok: false,
        reason: `${this.deps.harnessName(session.agentKind)} is running headless and this server has no runtime connection to it, so the stop could not be delivered`,
      }
    }
    const result = await request(input.sessionId)
    if ('ok' in result) return { ok: true, requested: 'protocol' }
    return {
      ok: false,
      reason: result.detail ? `${result.reason}: ${result.detail}` : result.reason,
    }
  }

  /**
   * The bytes that abort THIS session's harness, or undefined when sending them
   * would do more harm than nothing (POD-1214).
   *
   * There is no universal abort key. Esc cancels claude-code and grok and is
   * inert at their idle prompts; codex ignores Esc entirely and cancels on
   * Ctrl-C, which at an IDLE codex prompt exits the process. So the key comes
   * from the harness manifest, and the manifest's `interruptQuitsWhenIdle` is
   * what turns a stop into a refusal when the agent is not observed working.
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
    const blockedReason = sessionSendRefusalReason(session, input.allowErrored === true)
    if (blockedReason) return { ok: false, reason: blockedReason }
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
      if (input.allowErrored) this.recoveryDrains.add(input.sessionId)
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
    if (session.queuedMessageCount === 0) this.recoveryDrains.delete(session.sessionId)
    this.deps.persist(session)
    this.deps.broadcast()
    return true
  }

  hasQueuedMessage(sessionId: SessionId, sourceMessageId: string): boolean {
    return this.deps.queue.list(sessionId).some((row) => row.sourceMessageId === sourceMessageId)
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
   * Unconfirmed → the row stays durable and queued, and ordinary rows retry with
   * backoff. When the transcript cannot witness a send at all, leave the row and
   * surface a recoverable failure; never settle it or arm later sends from a
   * harness state report.
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
    const firstQueuedRow = this.deps.queue.list(sessionId)[0]
    const woken =
      session.status !== 'live' ||
      opts?.justBound === true ||
      this.needsInputReadiness(session) ||
      (firstQueuedRow !== undefined && isInitialPromptRow(sessionId, firstQueuedRow))
    // The CLI that was typed into is gone; whatever it was holding went with it.
    // Give this process the full attempt budget rather than the exhausted one the
    // dead process left behind (POD-1242).
    // THE SAME CLASS THE DRAIN EXEMPTS FROM RETYPING (POD-2828). A row typed
    // blind — into a session with no transcript to witness it — is at-most-once
    // for the reason the creation prompt is: the composer may be holding the
    // bytes with nothing able to say so, and the durable attempt count is the
    // only fence against a second copy. Resetting it on a bind hands that fence
    // back to whichever event re-armed the drain.
    const attemptsAreTheFence = this.needsInputReadiness(session) && !session.transcriptAvailable
    if (woken && this.deps.queue.resetAttempts && !attemptsAreTheFence) {
      for (const row of this.deps.queue.list(sessionId)) {
        // A creation prompt may already have been typed by the old process. Its
        // durable attempt count is the duplicate-prevention fence; resetting it
        // on bind would put the concatenation bug back after a restart.
        if (!isInitialPromptRow(sessionId, row)) this.deps.queue.resetAttempts(row.id)
      }
    }
    const deadline = this.deps.now() + (woken ? WOKEN_DRAIN_DEADLINE_MS : QUEUE_DRAIN_DEADLINE_MS)
    let liveAtMs = 0
    let baseOutputMs = 0
    const stop = () => this.activeDrains.delete(sessionId)
    const removeHead = (current: Session, id: string): void => {
      this.deps.queue.delete(asSessionId(id))
      current.queuedMessageCount = Math.max(0, current.queuedMessageCount - 1)
      if (current.queuedMessageCount === 0) this.recoveryDrains.delete(current.sessionId)
      this.deps.persist(current)
      this.deps.broadcast()
    }
    /** The head is done with — settle its ledger receipt and move on. */
    const clearQueuedDraft = (head: QueuedInboxMessage): void => {
      if (!this.deps.setSessionDraft) return
      const draft = this.deps.draftText?.(sessionId)
      if (draft === head.text) {
        this.deps.setSessionDraft({ sessionId, text: '' })
      }
    }
    const settleHead = (
      current: Session,
      head: QueuedInboxMessage,
      transcriptConfirmed = false,
    ): void => {
      if (transcriptConfirmed && this.needsInputReadiness(current)) {
        this.inputReadySessions.add(current)
      }
      if (transcriptConfirmed) clearQueuedDraft(head)
      if (transcriptConfirmed) this.reportedPromptFailures.delete(head.id)
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
    const reportPromptFailure = (
      current: Session | undefined,
      head: QueuedInboxMessage,
      reason: string,
    ): void => {
      if (!this.reportedPromptFailures.has(head.id)) {
        this.reportedPromptFailures.add(head.id)
        const initialPrompt = isInitialPromptRow(sessionId, head)
        if (this.deps.setSessionDraft) {
          const draft = this.deps.draftText?.(sessionId)
          // A missing/blank draft is recoverable state to restore. A
          // non-matching draft belongs to a human and must never be overwritten.
          if (draft === undefined || draft === '' || draft === head.text) {
            this.deps.setSessionDraft({ sessionId, text: head.text })
          }
        }
        const ownerUserId = this.deps.ownerOf(sessionId)
        this.deps.attention.promptFailed({
          ...(ownerUserId ? { ownerUserId } : {}),
          sessionId,
          text: head.text,
          reason,
          initialPrompt,
        })
      }
      // Keep the durable row. It is the retry/cancel handle and the queue badge
      // is the visible proof that no agent turn was confirmed. Later queued rows
      // stay behind it so another prompt cannot glue onto an unsubmitted native
      // composer buffer.
      if (current) this.deps.persist(current)
      stop()
    }
    /**
     * Poll for our own prompt arriving as the transcript's last user turn. Not
     * finding it is not proof of loss — a slow harness may simply not have
     * written the record yet — so an ordinary row retries rather than
     * dead-letters. A creation row has a bounded confirmation window and emits
     * a visible failure if it never becomes a witnessed turn.
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
      const initialPrompt = isInitialPromptRow(sessionId, head)
      let until =
        this.deps.now() + (initialPrompt ? INITIAL_PROMPT_CONFIRM_TIMEOUT_MS : CONFIRM_TIMEOUT_MS)
      const heldUntil = this.deps.now() + HELD_CONFIRM_CEILING_MS
      const poll = (): void => {
        // A disposed registry has no store to read (see `dispose`): stand down.
        if (this.disposed) return
        const current = this.deps.getSession(sessionId)
        if (!current || (current.status !== 'live' && current.status !== 'starting')) {
          reportPromptFailure(
            current,
            head,
            initialPrompt
              ? 'the session stopped before the creation prompt was confirmed'
              : 'the session stopped before this input was confirmed',
          )
          stop()
          return
        }
        const blockedReason = sessionSendRefusalReason(current, this.recoveryDrains.has(sessionId))
        if (blockedReason) {
          reportPromptFailure(current, head, blockedReason)
          stop()
          return
        }
        // A fresh session may create its first transcript record only after this
        // write. While the transcript is unavailable, hold the confirmation
        // poll rather than settling, retrying, or treating state as evidence.
        // The outer drain deadline makes the wait visible and bounded.
        if (!current.transcriptAvailable && this.needsInputReadiness(current)) {
          const now = this.deps.now()
          if (now >= deadline) {
            reportPromptFailure(
              current,
              head,
              `the agent transcript is not available to confirm this ${this.deps.harnessName(current.agentKind)} input`,
            )
            return
          }
          setTimeout(poll, HELD_POLL_MS).unref?.()
          return
        }
        if (tailUserTurnMatches(current, needle, isInitialPromptRow(sessionId, head))) {
          settleHead(current, head, true)
          return
        }
        const now = this.deps.now()
        if (isAgentComputing(current)) {
          // Held, not lost. Give up only at the ceiling, and leave the row
          // exactly where a later re-arm finds it — with its attempts intact.
          if (now >= heldUntil) {
            reportPromptFailure(
              current,
              head,
              initialPrompt
                ? 'the agent stayed busy without confirming the creation prompt'
                : 'the agent stayed busy without confirming this input',
            )
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
        // keeps seeing it, and an ordinary row gets a later retry. A creation
        // prompt is never retyped after an unconfirmed attempt: the original
        // bytes may still be sitting in the native composer.
        if (initialPrompt) {
          reportPromptFailure(
            current,
            head,
            'the agent transcript did not confirm the creation prompt before the deadline',
          )
          return
        }
        if (attempt >= MAX_DELIVERY_ATTEMPTS) {
          reportPromptFailure(
            current,
            head,
            'the agent transcript did not confirm this input after the retry budget was exhausted',
          )
          return
        }
        setTimeout(() => attemptDelivery(head, attempt + 1), RETRY_BACKOFF_MS * attempt).unref?.()
      }
      setTimeout(poll, CONFIRM_POLL_MS).unref?.()
    }
    const attemptDelivery = (head: QueuedInboxMessage, attempt: number): void => {
      // A disposed registry has no store to read (see `dispose`): stand down.
      if (this.disposed) return
      const firstPromptNeedsProof = isInitialPromptRow(sessionId, head)
      const current = this.deps.getSession(sessionId)
      if (!current || (current.status !== 'live' && current.status !== 'starting')) {
        reportPromptFailure(
          current,
          head,
          firstPromptNeedsProof
            ? 'the session stopped before the creation prompt was confirmed'
            : 'the session stopped before this input was confirmed',
        )
        stop()
        return
      }
      const blockedReason = sessionSendRefusalReason(current, this.recoveryDrains.has(sessionId))
      if (blockedReason) {
        reportPromptFailure(current, head, blockedReason)
        stop()
        return
      }
      const needsReadinessProof = this.needsInputReadiness(current)
      /**
       * THE WRITE THAT MAY CREATE THE TRANSCRIPT (POD-2828).
       *
       * A harness whose composer is proven from a CONFIRMED TURN has a
       * bootstrap problem, and the creation prompt is not the only row that
       * hits it. `transcriptAvailable` is a one-way latch: false means this
       * server has never seen a transcript ITEM for the session, and for
       * claude-code a session that has not taken a turn yet has none —
       * `claudeRecordToItems` drops the `isMeta` records SessionStart writes,
       * so the JSONL exists and maps to nothing. So the very first chat send
       * to a Claude session started WITHOUT a creation prompt is in exactly
       * the position the creation prompt is in: the transcript that would
       * witness it is the one it is about to create.
       *
       * Refusing that write is not caution, it is a state with no exit — the
       * only thing that can produce the missing evidence is the write being
       * refused. The generalization is the one POD-2116 already wrote for the
       * creation row, applied to the class rather than to the instance it
       * happened to have: type ONCE, then watch for the turn. Nothing here
       * claims delivery — `confirm` below holds the row while the transcript
       * is unavailable and dead-letters it at the deadline, so an unwitnessed
       * write is still visibly the operator's.
       */
      const transcriptCreatingWrite =
        firstPromptNeedsProof || (needsReadinessProof && !current.transcriptAvailable)
      /**
       * A SEND THAT MUST BE WITNESSED IS MATCHED EXACTLY (POD-2828).
       *
       * The 12-character floor exists because a short needle used with
       * `includes` matches too much of a transcript to be evidence of
       * anything. `tailUserTurnMatches(…, exact)` does not use `includes` — it
       * compares the WHOLE normalized tail user turn against the WHOLE
       * normalized text, which is unambiguous at any length. So the floor is a
       * property of the PREFIX form, not of witnessing, and applying it to a
       * row that is going to be confirmed anyway refused short sends for a
       * weakness the exact comparison does not have: "quick one" is nine
       * characters, and a first chat send of "quick one" was dead-lettered as
       * "too short to witness in the transcript" rather than delivered.
       *
       * This is the same class the transcript-creating exemption named, at its
       * actual boundary rather than stretched past it: every row here is one
       * whose delivery is proven from the transcript, and exact matching only
       * ever ADDS to what such a row can prove.
       */
      const exactNeedle = firstPromptNeedsProof || needsReadinessProof
      const needle = confirmationNeedle(head.text, exactNeedle)
      // A retry exists ONLY because the last attempt went unwitnessed. If the
      // turn has appeared since, it landed late — settle it rather than send the
      // same prompt twice. This check is what makes retrying safe at all.
      if (
        needle !== null &&
        tailUserTurnMatches(current, needle, exactNeedle) &&
        (attempt > 1 || transcriptCreatingWrite)
      ) {
        settleHead(current, head, true)
        return
      }
      // A transcript-creating write is at-most-once across process restarts. Its
      // attempt count is durable because the old native composer may still hold
      // the bytes even when the server never saw a transcript turn — retyping
      // would turn one uncertain prompt into two in the composer.
      if (transcriptCreatingWrite && head.attempts > 0) {
        reportPromptFailure(
          current,
          head,
          firstPromptNeedsProof
            ? 'the creation prompt was already typed but has not appeared in the transcript'
            : 'this input was already typed but has not appeared in the transcript',
        )
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
      // A needle short enough to match half the transcript is evidence of
      // nothing. A transcript-creating write is exempt: `confirmationNeedle`
      // gives it the WHOLE normalized text and `tailUserTurnMatches` compares
      // it exactly, so "ok" is still witnessable without a prefix.
      if (needsReadinessProof && needle === null) {
        reportPromptFailure(
          current,
          head,
          `this ${this.deps.harnessName(current.agentKind)} input is too short to witness in the transcript`,
        )
        return
      }
      this.deps.queue.bumpAttempts(head.id)
      // Baseline: if OUR text is already the last user turn we cannot tell a
      // fresh arrival from the one that is there, so there is nothing to witness.
      const witnessable =
        needle !== null &&
        current.transcriptAvailable &&
        !tailUserTurnMatches(current, needle, exactNeedle)
      const sent = this.typeText({
        sessionId,
        text: head.text,
        inputOrigin: head.inputOrigin,
        principal: head.principal,
        allowErrored: this.recoveryDrains.has(sessionId),
        ...(head.sourceMessageId ? { sourceMessageId: head.sourceMessageId } : {}),
        recordSend: false,
      })
      if (!sent.ok) {
        // A live menu is holding the CLI (`needs_user`). Typing a prompt into it
        // would answer the wrong question. Keep the row and report the blocked
        // delivery so the operator has a visible recovery handle.
        reportPromptFailure(
          current,
          head,
          current.agentState?.phase === 'needs_user'
            ? 'the agent is waiting for an answer before this input can be sent'
            : 'the queued input could not be sent to the session',
        )
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
      if (needle !== null && (witnessable || transcriptCreatingWrite || needsReadinessProof)) {
        confirm(head, needle, attempt)
      } else if (needsReadinessProof) {
        reportPromptFailure(
          current,
          head,
          `the agent transcript did not confirm this ${this.deps.harnessName(current.agentKind)} input`,
        )
      } else settleHead(current, head)
    }
    const deliverNext = (): void => {
      // A disposed registry has no store to read (see `dispose`): stand down.
      if (this.disposed) return
      const current = this.deps.getSession(sessionId)
      const head = this.deps.queue.list(sessionId)[0]
      if (!current || (current.status !== 'live' && current.status !== 'starting')) {
        if (head) {
          reportPromptFailure(
            current,
            head,
            isInitialPromptRow(sessionId, head)
              ? 'the session stopped before the creation prompt was confirmed'
              : 'the session stopped before this input was confirmed',
          )
        }
        stop()
        return
      }
      const blockedReason = sessionSendRefusalReason(current, this.recoveryDrains.has(sessionId))
      if (blockedReason) {
        if (head) reportPromptFailure(current, head, blockedReason)
        stop()
        return
      }
      if (!head) {
        stop()
        return
      }
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
        afterHead(current)
        return
      }
      if (this.deps.serverDriven?.(current) === true) {
        /**
         * NO PTY TO TYPE INTO — the row goes through the runtime contract, and
         * the driver's receipt decides what happens to it (POD-2291).
         *
         * This branch exists because the alternative was measured, not
         * imagined: a chat prompt sent while a codex app-server session was
         * still `starting` rode this queue, and the PTY path below "delivered"
         * it into a bridge that does not exist — the daemon discarded the
         * bytes, this side marked the ledger row delivered, and the operator's
         * message vanished without a transcript entry, an error, or a
         * dead-letter. Accepted input must never vanish: it delivers, stays
         * visibly queued, or dead-letters visibly.
         */
        const contractDeliver = this.deps.contractDeliver
        if (!contractDeliver) {
          // No contract port wired (bare fixtures). The row STAYS queued and
          // visible — the one thing this path must never do is claim delivery.
          stop()
          return
        }
        void contractDeliver({
          sessionId,
          turnId: head.sourceMessageId ?? head.id,
          text: head.text,
          origin: head.inputOrigin,
          principal: head.principal,
        }).then(
          (receipt) => {
            const after = this.deps.getSession(sessionId)
            if (!after) {
              stop()
              return
            }
            if (receipt.outcome === 'refused') {
              // `busy` / `needs_user`: a turn opened (or an ask arrived)
              // between the idle check and the delivery — an ordinary race, so
              // keep polling for the next boundary. Anything else ends this
              // drain; the row stays visibly queued and the next bind,
              // reconnect or enqueue re-drains it.
              if (receipt.refusal.reason === 'busy' || receipt.refusal.reason === 'needs_user') {
                setTimeout(tick, READY_POLL_MS).unref?.()
              } else stop()
              return
            }
            if (receipt.outcome === 'unverified') {
              // Server drivers never legitimately emit `unverified` (the
              // conformance suite pins it terminal-only) — here it is the
              // RPC layer's synthesized answer for a send whose 12s window
              // closed with no daemon reply. That frame may never have
              // reached any daemon, so confirming would be the vanish-shape
              // again through a different door. The row STAYS visibly
              // queued; the next bind, reconnect or enqueue re-drains it.
              //
              // POD-2327 widened this branch's reachable senders: an UNKNOWN
              // driver id also arrives here, and one of those could be a
              // terminal driver from a newer daemon, for which `unverified`
              // IS honest ("typed it, could not prove it"). Keeping the row
              // queued is still the right answer — an unproven send is not a
              // delivered one.
              //
              // NAME THE COST, WHICH IS NOT MERELY "A RE-DRAIN" (POD-2297).
              // `unverified` means UNKNOWN, not "did not arrive": the send may
              // genuinely have been typed. The re-drain re-sends the SAME
              // `turnId`, so a proven-but-unverified prompt is delivered TWICE
              // and the agent sees it twice. THIS PATH IS THEREFORE
              // AT-LEAST-ONCE, DELIBERATELY — of the two ways to be wrong under
              // a two-generals gap, a duplicate prompt is recoverable by a
              // reader and a vanished one is not, which is the same ordering
              // POD-2132/POD-2202 and POD-2297 chose everywhere else. Driver-
              // local dedupe by `turnId` would close the common window (a
              // re-drain inside one driver lifetime) but not the one that
              // matters most (across a daemon restart the driver's memory is
              // gone), so it narrows this and never removes it.
              stop()
              return
            }
            // `accepted` (protocol-acked) or `queued` (the driver's own FIFO
            // now holds it). The row crossed to the driver: confirm it and
            // move on.
            if (head.sourceMessageId) {
              // A retraction that raced the in-flight send is a no-op here:
              // `onQueuedInputApplied` only moves rows still `queued`.
              this.deps.authorization.applied({
                sourceMessageId: head.sourceMessageId,
                sessionId,
              })
            }
            // The delivery was ASYNC, so the row may have been retracted while
            // it was in flight — removeHead on an already-deleted row would
            // decrement `queuedMessageCount` a second time.
            if (this.deps.queue.list(sessionId).some((row) => row.id === head.id)) {
              removeHead(after, head.id)
            }
            if (after.queuedMessageCount > 0) {
              setTimeout(deliverNext, QUEUE_MESSAGE_SPACING_MS).unref?.()
            } else stop()
          },
          () => stop(),
        )
        // The receipt continuation above owns pacing and stop; falling through
        // to the synchronous tail would drive the queue twice.
        return
      }
      // ATTEMPTS ARE THE ROW'S, NOT THE PASS'S (POD-1242). The cap used to reset
      // every time a bind, an idle edge or a reconnect re-armed the drain, so a
      // row that could not be confirmed was retyped five times per pass, forever.
      // Contract delivery above has its own typed receipts; this budget applies
      // only to the terminal path.
      if (head.attempts >= MAX_DELIVERY_ATTEMPTS) {
        reportPromptFailure(
          current,
          head,
          isInitialPromptRow(sessionId, head)
            ? 'the creation prompt was already typed but has not appeared in the transcript'
            : 'the agent transcript did not confirm this input after the retry budget was exhausted',
        )
        return
      }
      attemptDelivery(head, head.attempts + 1)
    }
    /**
     * Ready to be typed into. A harness state report is deliberately absent from
     * this predicate: a PTY bind and a runtime-state stamp are lifecycle facts,
     * not proof that the composer can receive a turn.
     *
     * `liveAtMs` is the BIND, not this pass — see the tick below. Both terms
     * measure the same thing they always did, "how long has this CLI had to put
     * a composer up"; asking it of the bind is what lets the ceiling expire.
     */
    const readyForInput = (current: Session, now: number): boolean => {
      if (now - liveAtMs < READY_FLOOR_MS) return false
      const settled =
        current.terminal.lastOutputAtMs > baseOutputMs &&
        now - current.terminal.lastOutputAtMs >= READY_QUIET_MS
      return settled || now - liveAtMs >= READY_MAX_MS
    }
    const tick = (): void => {
      // A disposed registry has no store to read (see `dispose`): stand down.
      if (this.disposed) return
      const current = this.deps.getSession(sessionId)
      const head = this.deps.queue.list(sessionId)[0]
      if (!current || current.status === 'exited' || current.status === 'hibernated') {
        if (head) {
          reportPromptFailure(
            current,
            head,
            isInitialPromptRow(sessionId, head)
              ? 'the session stopped before the creation prompt was confirmed'
              : 'the session stopped before this input was confirmed',
          )
        }
        stop()
        return
      }
      const now = this.deps.now()
      const blockedReason = sessionSendRefusalReason(current, this.recoveryDrains.has(sessionId))
      if (blockedReason) {
        if (head) reportPromptFailure(current, head, blockedReason)
        else stop()
        return
      }
      const serverDriven = this.deps.serverDriven?.(current) === true
      if (current.status === 'live') {
        if (serverDriven) {
          /**
           * A server-family session has no terminal output to watch settle and
           * no composer to protect — the DRIVER owns readiness, and `when-ready`
           * is how the drain asks it (POD-2291). Deliver at turn boundaries:
           * idle (or no phase reported yet) delivers now; a session mid-turn
           * keeps polling PAST the drain deadline, because the deadline exists
           * to abandon typing into a PTY that never became ready, and applying
           * it here stranded rows behind any turn longer than 25 seconds.
           */
          const phase = current.agentState?.phase
          if (phase === undefined || phase === 'idle') {
            deliverNext()
            return
          }
          setTimeout(tick, READY_POLL_MS).unref?.()
          return
        }
        if (!liveAtMs) {
          /**
           * THE READINESS CLOCK STARTS AT THE BIND, NOT AT THE SEND (POD-2836).
           *
           * This used to stamp `now`, which made the window below unexpirable:
           * every measurement of "has the composer had time to mount" began at
           * the moment someone asked for a message to be typed, so a session
           * that bound an hour ago paid the same 6s ceiling as one that bound a
           * second ago — 6.3s on EVERY first chat send after a bind. The window
           * is right and is deliberately unchanged; only its zero moves.
           *
           * A bind we did not see (a live row rehydrated at server boot, before
           * the daemon reattaches) leaves the clock where it was: unknown means
           * unproven, and unproven waits the full window.
           */
          const boundAt = this.boundAtMs.get(current)
          liveAtMs = boundAt !== undefined && boundAt < now ? boundAt : now
          baseOutputMs = current.terminal.lastOutputAtMs
        }
        if (readyForInput(current, now) || now >= deadline) {
          deliverNext()
          return
        }
      } else if (now >= deadline) {
        if (head) {
          reportPromptFailure(
            current,
            head,
            isInitialPromptRow(sessionId, head)
              ? 'the session did not become live before the creation prompt deadline'
              : 'the session did not become live before this input deadline',
          )
        } else stop()
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
    const blockedReason = sessionSendRefusalReason(session, input.allowErrored === true)
    if (blockedReason) return { ok: false }
    // A server-family session has no PTY bridge: the daemon discards "typed"
    // bytes without an error, so an ok here would be the exact lie POD-2291
    // closes. Refusing keeps the caller's row queued and visible; the drain's
    // contract branch is the path that actually delivers.
    if (this.deps.serverDriven?.(session) === true) return { ok: false }
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
    // THE TRUST BOUNDARY, AND IT IS CROSSED EXACTLY HERE (POD-2708).
    //
    // `injectionPayload` is the only thing on this side that puts caller text
    // inside a bracketed paste, and it cannot do so without first removing every
    // byte a CLI's key parser would read as control — so no text arriving at this
    // line can close the envelope it is about to be wrapped in, whoever sent it.
    // It used to be true only of text that had passed through the message
    // RENDERER's `sanitizeBody`, which the steward's nudges and the automations
    // drain never touch. Grok's fresh TUI ignores bracketed paste until a native
    // first turn (POD-549), so its first prompt goes as raw keystrokes (POD-901) —
    // guarded identically, because a raw ESC there is simply an interrupt.
    const payload = injectionPayload(input.text, { rawFirstTurn: this.isRawFirstTurn(session) })
    this.sendInput(session, payload, input.inputOrigin ?? 'controller', principal.attribution)
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
        session.terminal.transcriptItems().filter((item) => item.role === 'user').length >
        baselineUserTurns
      )
        return
      this.sendInput(session, '\r', 'controller', attribution)
      if (attempt < SUBMIT_MAX_RETRIES) {
        this.scheduleSubmitVerify(sessionId, baselineUserTurns, attribution, attempt + 1)
      }
    }, SUBMIT_VERIFY_DELAY_MS).unref?.()
  }

  private isRawFirstTurn(session: Session): boolean {
    if (!this.deps.usesRawFirstTurn(session.agentKind)) return false
    return !hasSeenUserTurn(session)
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
