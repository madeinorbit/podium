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
import { createLogger } from '@podium/logger'
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
import { type HarnessInterrupt } from '../../harness-manifest'
import { injectionPayload } from './paste'
import type { ConfigureOutcome } from './runtime-gateway'
import type { Session, SessionDurableState } from './session'
import type { ViewportRequest } from './terminal'

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
  /** WHICH delivery carried the stop (POD-2792). `retraction` is the third one
   *  the merge with dev/mw added: the operator's stop was completed by pulling
   *  the queued send back before it ever reached the agent, so no key was typed
   *  and no driver was called — and saying `keystroke` there would name a
   *  delivery that did not happen. */
  | { ok: true; requested: 'keystroke' | 'protocol' | 'retraction'; reason?: undefined }
  | { ok: false; reason: string; requested?: undefined }

const log = createLogger('server:session-inbox')

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

/** Stable queue key for the prompt supplied in the session creation request. */
const INITIAL_PROMPT_QUEUE_ID_PREFIX = 'session-initial-prompt:'

/**
 * Refusals that PROVE the durable forward typed nothing (POD-4622), so the
 * reservation taken for it is released and the row stays fresh. Every
 * producer of these on the contractDeliver path answers before any write:
 *
 *   - `not_running`: the gateway has no machine for the session, or the
 *     daemon has no handle (the readiness window, a session not yet bound).
 *     A daemon whose durable send THROWS answers `unverified`, not this.
 *   - `unsupported`: the gateway's attachment gate, or the delivery queue's
 *     at-boundary gate, both before the row is admitted.
 *   - `staging_failed`: the daemon's attachment check, before `handle.send`.
 *
 * Any other reason keeps the reservation: confirm-or-fail leaves a visible,
 * retryable failure, while a wrong release can type the same turn twice.
 */
const REFUSALS_PROVING_NO_WRITE: ReadonlySet<Refusal['reason']> = new Set(['not_running', 'unsupported', 'staging_failed'])

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
  /** Epoch ms the row was accepted. The transcript witness below compares a
   *  user turn's time against it, so an OLDER identical turn never settles a
   *  NEWER row. */
  queuedAt: number
  attempts: number
  deliveryOwner?: string | null
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
  }): Promise<boolean>
  list(sessionId: SessionId): Promise<QueuedInboxMessage[]>
  /** UNBRANDED BY DECISION: queue primary key; may be a mutation id or a generated UUID. */
  reserveDelivery?(id: string): Promise<void>
  /** Undo a reservation a proven-unwritten forward took (POD-4622): no owner,
   *  and the attempts count the row had before it. UNBRANDED: see above. */
  releaseDelivery?(id: string, attempts: number): Promise<void>
  /** UNBRANDED BY DECISION: queue primary key; may be a mutation id or a generated UUID. */
  delete(id: string): Promise<void>
  /** Every session holding at least one pending row — the work list for
   *  {@link SessionInbox.sweepQueuedInputs} (POD-1703). Optional so the many
   *  fixtures that satisfy this port with enqueue/list/delete alone stay valid;
   *  without it the sweep is a no-op rather than a crash. */
  sessionsWithPending?(): Promise<SessionId[]>
}

export type InboxAuthorizationDecision = { ok: true } | { ok: false; reason: string }

export interface InboxAuthorizationPort {
  /** Resolve live; implementations must never memoize this answer. */
  authorizeAtDrain(input: {
    sessionId: SessionId
    principal: InboxPrincipalReference
    sourceMessageId: string | null
  }): Promise<InboxAuthorizationDecision>
  rejected(input: {
    queueId: string
    sourceMessageId: string | null
    principal: InboxPrincipalReference
    reason: string
  }): Promise<void>
  /** The queued row has now crossed the real PTY boundary — and, where the
   *  transcript can witness it, has been seen to become a turn (POD-1100). */
  applied(input: { sourceMessageId: string; sessionId: SessionId }): Promise<void>
  /** The bytes went into the CLI; the agent has not been seen to take them yet
   *  (POD-1242). Between this and {@link applied} the message is normally the
   *  harness's. An explicit interrupt is the one signal that returns ownership
   *  to this queue so it can cancel instead of retrying. */
  injected?(input: { sourceMessageId: string; sessionId: SessionId }): Promise<void>
  /** The operator interrupted an injected row before it became a user turn. */
  interrupted?(input: { sourceMessageId: string | null; sessionId: SessionId }): Promise<void>
  /** The operator interrupted while a chat message was still held in the
   *  higher-level message ledger and had no physical inbox row yet. */
  interruptedPending?(input: { sessionId: SessionId; sourceMessageId?: string }): Promise<void>
}

export interface InboxAttentionPort {
  stateChanged(input: {
    ownerUserId: UserId
    sessionId: SessionId
    prev: AgentRuntimeState | undefined
    next: AgentRuntimeState
    observation?: AgentObservation
  }): void
  answered(input: {
    ownerUserId: UserId
    sessionId: SessionId
    attribution: Attribution
  }): Promise<void>
  /** A queued input was not witnessed before its bounded confirmation window. */
  promptFailed(input: {
    ownerUserId?: UserId
    sessionId: SessionId
    text: string
    reason: string
    initialPrompt: boolean
  }): Promise<void>
}

export interface SessionInboxDeps {
  getSession(sessionId: SessionId): Session | undefined
  queue: InboxQueuePort
  daemon: SessionInputGatewayPort
  authorization: InboxAuthorizationPort
  attention: InboxAttentionPort
  now(): number
  persist(session: Session, options?: { cancelTerminalCandidate?: boolean }): Promise<void>
  /** Mutate the durable half as a DRAFT and persist it [POD-3330]. */
  write(
    session: Session,
    mutate: (draft: SessionDurableState) => void,
    options?: { cancelTerminalCandidate?: boolean },
  ): Promise<void>
  /** A draft, for the site that must ask whether anything changed at all before
   *  deciding to write [POD-3330]. */
  draft(session: Session): SessionDurableState
  persistDraft(session: Session, draft: SessionDurableState): Promise<void>
  broadcast(): void
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
  ): Promise<void>
  ownerOf(sessionId: SessionId): Promise<UserId | null | undefined>
  /** Seed/restore the server-persisted composer draft without a client echo. */
  setSessionDraft?(input: { sessionId: SessionId; text: string }): Promise<void>
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
  authorizeDrive?(principal: ClientPrincipal, sessionId: SessionId): Promise<boolean>
  /**
   * Native terminal ownership parks sends in the durable FIFO until the view
   * releases the human-controller lease.
   */
  nativeViewActive?(sessionId: SessionId): boolean

  /** Bind-reported contract delivery: true means the daemon built a driver handle
  * for this session and the contract is its only delivery. Shells and unbound
  * sessions keep the server path. Optional only as a fixture affordance. */
  contractAnswer?(input: {
    sessionId: SessionId; interactionId?: string; choices?: AnswerChoice[]; skip?: boolean
    principal: InboxPrincipalReference
  }): Promise<{ ok: boolean; reason?: string }>

  /** Cancel a daemon-owned queued row before deleting its durable intent. */
  contractCancel?(sessionId: SessionId, rowId: string): Promise<{ ok: true } | Refusal>
  contractDeliver?(input: {
    sessionId: SessionId
    turnId: string
    deliveryRecovery?: boolean
    initialPrompt?: boolean
    text: string
    origin: ObservationInputOrigin
    principal: InboxPrincipalReference
  }): Promise<TurnReceipt>
  /**
  * REQUEST an interrupt through the runtime contract — the only delivery an
  * agent session has.
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
  /**
   * CHANGE a running session's sticky model / effort through the runtime
   * contract (POD-3081).
   *
   * Optional only as a fixture affordance, and the missing case REFUSES rather
   * than confirming — the same rule as {@link contractInterrupt}, for the same
   * reason: a setting change that could not be delivered must say so, because
   * the alternative is a control that renders as applied over a session nobody
   * told.
   */
  contractConfigure?(input: {
    sessionId: SessionId
    model?: string
    effort?: string
  }): Promise<ConfigureOutcome>
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

/**
 * Clock tolerance between the server's `queuedAt` and the harness's own
 * transcript timestamps, which may come from another machine.
 */
const WITNESS_CLOCK_SKEW_MS = 5 * 60_000

/**
 * Was this queued row ALREADY DELIVERED by an earlier custody (POD-4360)? The
 * proof is the transcript: a user turn carrying the row's text, recorded at or
 * after the row was queued. A turn without a timestamp can only prove the TAIL
 * — the same rule the legacy drain's late-landing check uses.
 *
 * WHY THIS EXISTS. Custody of a forwarded row lives in server memory: a restart
 * forgets it and hands every remaining row to the daemon again. That is correct
 * for a row the previous process never got to — and a second copy for one it
 * did. The coordinator this was found on received the same nineteen
 * child-finished notices after every server update of the day, because the
 * outcomes that would have deleted the rows were being dropped upstream.
 */
const transcriptWitnesses = (session: Session, row: QueuedInboxMessage): boolean => {
  const needle = confirmationNeedle(row.text)
  if (needle === null) return false
  // Contract-era transcript lives in both surfaces: legacy provider deltas land
  // in `transcriptItems`, driver runtime events land in `runtimeTranscript`
  // (and are bridged into `transcript`). Check both so a witness is seen
  // whichever path carried it after a restart. The runtime surface is optional
  // only as a fixture affordance — production terminals always carry it.
  const surfaces = [session.terminal.transcriptItems()]
  const runtimeItems = session.terminal.runtimeTranscriptItems?.()
  if (runtimeItems) surfaces.push(runtimeItems)
  const notBefore = row.queuedAt - WITNESS_CLOCK_SKEW_MS
  for (const items of surfaces) {
    for (let i = items.length - 1; i >= 0; i--) {
      const item = items[i]
      if (item?.role !== 'user') continue
      const at = item.ts ? Date.parse(item.ts) : Number.NaN
      // Untimed turns: the tail is the only position that proves anything.
      // A non-matching tail ends this surface, not the search: the other
      // surface may still carry a timed witness.
      if (!Number.isFinite(at)) {
        if (normalizeForMatch(item.text).includes(needle)) return true
        break
      }
      if (at < notBefore) break
      if (normalizeForMatch(item.text).includes(needle)) return true
    }
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
  /** True while a queued-input sweep is running — see {@link sweepQueuedInputs}. */
  private sweepingQueuedInputs = false
  /** Generation fence for binds racing a shell drain. */
  private readonly drainGenerations = new Map<SessionId, number>()
  /** Recovery answers may queue while a failed session is being woken. */
  private readonly recoveryDrains = new Set<SessionId>()
  /** One durable attention event per queued row and failure episode. */
  private readonly reportedPromptFailures = new Set<string>()
  /** Set by {@link dispose}; read at every drain re-entry point. */
  private disposed = false

  constructor(private readonly deps: SessionInboxDeps) {}

  private invalidateDrain(sessionId: SessionId): void {
    this.drainGenerations.set(sessionId, (this.drainGenerations.get(sessionId) ?? 0) + 1)
    this.activeDrains.delete(sessionId)
  }

  /**
  * A SHELL DRAIN OUTLIVES THE REGISTRY THAT STARTED IT (POD-2842).
  *
  * `forwardShellRows` awaits the store between rows, and `forwardContractRows`
  * awaits the daemon — either can be in flight when `server.ts` closes the
  * SQLite handle one step after `registry.dispose()` ("a late write against a
  * closed DB would throw"). Both check `disposed` at every re-entry, so a
  * shutdown taken while a row is in flight stands down instead of waking into
  * a closed store.
  *
  * A stopped drain loses nothing: the row is durable, and the next bind,
  * reconnect or enqueue re-arms a fresh pass over it.
  */
  dispose(): void {
    this.disposed = true
    this.activeDrains.clear()
    this.forwardedRows.clear()
  }

  isDraining(sessionId: SessionId): boolean {
    return this.activeDrains.has(sessionId)
  }

  /**
   * A DURABLE ROW ACCEPTED JUST BEFORE PROCESS DEATH STILL OWNS A DELIVERY
   * (POD-2980).
   *
   * `queueText` requests a wake when the session is already parked. The inverse
   * race used to have no owner: enqueue saw `live`, then `agentExit` changed the
   * row to `exited`, and nothing revisited the wake decision. The input remained
   * durably queued forever even though the caller had been told it was accepted.
   *
   * The lifecycle calls this after applying a real exit. Reuse the oldest row's
   * principal so the existing wake reaction re-authorizes the same delegation at
   * apply time.
   *
   * THIS IS THE EXACT GROK ACP REPAIR, not a general crashed-agent policy. Only
   * its bound server driver proved the dead-handle send race; terminal Grok,
   * fallback drivers and other runtime families keep their existing explicit
   * recovery behavior. The live binding facts are intentionally transient, so
   * this cannot infer authority from a requested or historical driver.
   */
  async recoverQueuedAfterExit(sessionId: SessionId): Promise<boolean> {
    const session = this.deps.getSession(sessionId)
    // NOTE (POD-4440): no `hasBoundDriver` term here on purpose. The
    // `driverId === 'grok-acp'` pin below already implies a bound driver
    // (`hasBoundDriver` is derived as `driverId !== undefined`), so a bound
    // check would be redundant. This predicate is a Grok-ACP recovery guard,
    // not a delivery path.
    if (
      !session ||
      session.status !== 'exited' ||
      session.archived ||
      session.queuedMessageCount === 0 ||
      session.agentKind !== 'grok' ||
      session.driverId !== 'grok-acp' ||
      !session.resume
    ) {
      return false
    }
    const queuedRows: Promise<QueuedInboxMessage[]> = this.deps.queue.list(sessionId)
    const head = (await queuedRows)[0]
    if (!head) return false
    this.invalidateDrain(sessionId)
    this.deps.resurrect(sessionId, head.principal)
    return true
  }

  /** A new bind fence off any shell drain the previous bind armed, and drops
  *  daemon custody claimed under the old machine binding. */
  markSessionBound(sessionId: SessionId): void {
    this.forwardedRows.delete(sessionId)
    this.forwarding.delete(sessionId)
    this.invalidateDrain(sessionId)
  }

  /**
   * Queue the prompt that arrived with session creation. Its deterministic id
   * keeps the proof requirement recognizable if the server restarts before the
   * first turn is observed.
   */
  async queueInitialPrompt(input: InboxSendInput): Promise<{
    ok: boolean
    queued?: boolean
    reason?: string
  }> {
    return await this.queueText({
      ...input,
      mutationId: asMutationId(initialPromptQueueId(input.sessionId)),
    })
  }

  async sendText(input: InboxSendInput): Promise<{
    ok: boolean
    queued?: boolean
    reason?: string
  }> {
    const session = this.deps.getSession(input.sessionId)
    const blockedReason = session
      ? sessionSendRefusalReason(session, input.allowErrored === true)
      : undefined
    if (blockedReason) return { ok: false, reason: blockedReason }
    if (!session || (session.status !== 'live' && session.status !== 'starting')) {
      return { ok: false }
    }
    // Agents always queue (POD-4279): the durable queue down the drain's
    // contract branch is the only delivery. queueText stays the explicit wake
    // path (resumeAndSend). Plain-terminal shells (POD-4278) have no driver, so
    // they keep the raw transport below: bytes onto the PTY the operator is
    // watching, exactly as a controller keystroke would land.
    if (session.agentKind !== 'shell') {
      return await this.queueText(input)
    }
    // A live menu is holding the shell (`needs_user`). Typing a prompt into it
    // would answer the wrong question (#473): refuse rather than queue, because
    // "not yet" and "no" are not the same answer to give a caller.
    if (session.agentState?.phase === 'needs_user') return { ok: false }
    // Ordering, not readiness: a live send past a non-empty durable queue would
    // land ahead of older rows still waiting to drain.
    if (session.queuedMessageCount > 0 || this.isDraining(input.sessionId)) {
      return await this.queueText(input)
    }
    // Complete metadata admission before entering the synchronous byte path.
    await this.deps.prepareSend(
      input.sessionId,
      (input.principal ?? SYSTEM_INBOX_PRINCIPAL).attribution,
      'text',
      input.inputOrigin ?? 'controller',
    )
    if (
      this.deps.getSession(input.sessionId) !== session ||
      (session.status !== 'live' && session.status !== 'starting')
    )
      return { ok: false, reason: 'session changed during admission' }
    const currentRefusal = sessionSendRefusalReason(session, input.allowErrored === true)
    if (currentRefusal) return { ok: false, reason: currentRefusal }
    this.sendShellText(session, input)
    return { ok: true }
  }

  async resumeAndSend(input: InboxSendInput & { mutationId?: MutationId }): Promise<{
    ok: boolean
    queued?: boolean
    reason?: string
  }> {
    const session = this.deps.getSession(input.sessionId)
    if (!session) return { ok: false, reason: 'unknown session' }
    const blockedReason = sessionSendRefusalReason(session, input.allowErrored === true)
    if (blockedReason) return { ok: false, reason: blockedReason }
    if (session.status === 'live' && session.queuedMessageCount === 0)
      return await this.sendText(input)
    return await this.queueText({ ...input, mutationId: input.mutationId })
  }

  async interruptText(
    input: InboxSendInput,
  ): Promise<{ ok: boolean; queued?: boolean; reason?: string }> {
    const session = this.deps.getSession(input.sessionId)
    const blockedReason = session
      ? sessionSendRefusalReason(session, input.allowErrored === true)
      : undefined
    if (blockedReason) return { ok: false, reason: blockedReason }
    if (!session || (session.status !== 'live' && session.status !== 'starting')) {
      return { ok: false, reason: 'session not running' }
    }
    const principal = input.principal ?? SYSTEM_INBOX_PRINCIPAL
    // Contract-only stops for agents (POD-4279). The driver owns the abort key
    // behind its manifest idle guard; the server never types it. Plain-terminal
    // shells (POD-4278) keep the raw path below — they have no driver to call.
    if (session.agentKind !== 'shell') {
      await this.cancelInterruptedDelivery(input.sessionId, true, input.sourceMessageId)
      // EVERY interrupt goes to the driver (POD-4666). The server's phase is a
      // lagging copy of the daemon's, so gating on it skipped the interrupt of
      // a turn that was really running. The driver skips it when there is no
      // turn to cut into; a driver with no running session (`not_running`) has
      // nothing to cut into either, and the message still lands, which is the
      // point of this path.
      const interruption = await this.requestDriverInterrupt(input.sessionId)
      if (!('ok' in interruption) && interruption.reason !== 'not_running') {
        return { ok: false, reason: this.interruptRefusalReason(session, interruption) }
      }
      // The follow-up text rides the durable queue down the drain's contract
      // branch. The queue result is the caller's answer, not a silent ok:true.
      return await this.queueText({ ...input, principal })
    }
    // An idle agent has no turn to cut into, so the abort key is skipped rather
    // than refused — the message still lands, which is the point of this path.
    // Skipping matters for a harness whose key exits when idle: an
    // interrupt-urgency message must never be the thing that kills the session.
    await this.deps.prepareSend(
      input.sessionId,
      principal.attribution,
      'text',
      input.inputOrigin ?? 'controller',
    )
    if (
      this.deps.getSession(input.sessionId) !== session ||
      (session.status !== 'live' && session.status !== 'starting')
    )
      return { ok: false, reason: 'session changed during admission' }
    const currentRefusal = sessionSendRefusalReason(session, input.allowErrored === true)
    if (currentRefusal) return { ok: false, reason: currentRefusal }
    const abort = this.abortKeyFor(session)
    if (abort) {
      this.sendInput(session, abort, input.inputOrigin ?? 'controller', principal.attribution)
    }
    this.sendShellText(session, { ...input, principal })
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
  async interruptTurn(
    input: Omit<InboxSendInput, 'text'>,
  ): Promise<InterruptOutcome | Promise<InterruptOutcome>> {
    const session = this.deps.getSession(input.sessionId)
    if (!session || (session.status !== 'live' && session.status !== 'starting')) {
      return { ok: false, reason: 'session not running' }
    }
    // Contract-only stops for agents (POD-4279). Plain-terminal shells
    // (POD-4278) keep the raw abort path below — they have no driver to call.
    if (session.agentKind !== 'shell') {
      const cancelled = await this.cancelInterruptedDelivery(input.sessionId, true, input.sourceMessageId)
      // NO PHASE GATE (POD-4666): only the daemon knows whether a turn is
      // running, and the server's copy lags it — a stop gated on that copy was
      // refused while the agent ran on. The driver owns the idle guard and
      // answers; a refusal after a retraction still completed the operator's
      // stop, the same rule `sessions.interrupt` applies to a reserved send.
      const interruption = await this.requestDriverInterrupt(input.sessionId)
      if ('ok' in interruption) return { ok: true, requested: 'protocol' }
      if (cancelled) return { ok: true, requested: 'retraction' }
      return { ok: false, reason: this.interruptRefusalReason(session, interruption) }
    }
    const cancelledDelivery = await this.cancelInterruptedDelivery(
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
      if (cancelledDelivery) return { ok: true, requested: 'retraction' }
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
   * The unwired case refuses rather than confirming — a fixture without the
   * port is still a stop that did not happen. It is not `not_running`: nothing
   * says the agent is idle, only that this server cannot reach it.
   */
  private async requestDriverInterrupt(sessionId: SessionId): Promise<{ ok: true } | Refusal | { reason: 'unwired' }> {
    const request = this.deps.contractInterrupt
    if (!request) return { reason: 'unwired' }
    return await request(sessionId)
  }

  /**
   * The reason travels back VERBATIM where the driver gave one: the chat
   * composer prints this string, and 'not_running' with the driver's own detail
   * tells an operator more than a sentence this layer invented would.
   */
  private interruptRefusalReason(session: Session, refusal: Refusal | { reason: 'unwired' }): string {
    if (refusal.reason === 'unwired') {
      return `${this.deps.harnessName(session.agentKind)} is running headless and this server has no runtime connection to it, so the stop could not be delivered`
    }
    const detail = 'detail' in refusal ? refusal.detail : undefined
    return detail ? `${refusal.reason}: ${detail}` : refusal.reason
  }

  /**
   * CHANGE THE MODEL OR EFFORT OF A SESSION THAT IS ALREADY RUNNING (POD-3081).
   *
   * WHY THIS LIVES BESIDE `interruptTurn` RATHER THAN ANYWHERE ELSE: the two
   * face the same split. A terminal-family session reads its model from argv at
   * launch and there is no route that changes it, so this refuses with the
   * driver's own reason instead of typing a slash command at a TUI and hoping —
   * the same shape as an interrupt that must not be sent to an idle codex. A
   * server-family session has a driver that constructs every request it makes,
   * so the change is real and goes down the contract.
   *
   * WHAT `ok` MEANS: the DRIVER accepted the change and said when it takes
   * effect. It does not mean the session is answering as the new model yet, and
   * `effective` is how the caller tells a person which of the two they have.
   *
   * THE REQUESTED VALUE IS WRITTEN ONLY AFTER THE GRANT. Recording it first
   * would show a person the model they picked over a session that refused it,
   * which is the one failure this whole verb exists to avoid.
   */
  async configureSession(input: {
    sessionId: SessionId
    model?: string
    effort?: string
  }): Promise<ConfigureOutcome> {
    const session = this.deps.getSession(input.sessionId)
    if (!session || (session.status !== 'live' && session.status !== 'starting')) {
      return { reason: 'not_running', detail: 'session is not running' }
    }
    const request = this.deps.contractConfigure
    if (!request) {
      return {
        reason: 'not_running',
        detail: `${this.deps.harnessName(session.agentKind)} is running with no runtime connection to this server, so the change could not be delivered`,
      }
    }
    const result = await request(input)
    if ('ok' in result) {
      /**
       * WRITE IT, STORE IT, THEN SAY SO — all three, and the pair after the
       * setter is not optional (POD-3081 review).
       *
       * `setRequestedModel` moves an in-memory field and nothing more. Without
       * `persist` the change is gone at the next server restart, and the session
       * comes back displaying the model it was LAUNCHED with while its driver —
       * whose own journal DID survive — answers as the one it was configured to.
       * Without `broadcast` every client goes on rendering the old value until
       * something unrelated happens to push a session list, so the control the
       * operator just used appears to have done nothing.
       *
       * Guarded on the setter's return for the same reason every other caller of
       * this pair is: a configure to the model the session is already on changes
       * nothing, and a write plus a fan-out per no-op is cost with no news in it.
       */
      // THE ASK HAPPENS ON THE DRAFT [POD-3330]. The setter answers whether the
      // request actually moves anything, and that answer is computed against a
      // copy — so a configure that changes nothing leaves the live session
      // untouched exactly as it did before, and one that does becomes visible
      // in memory only once its row says so.
      const draft = this.deps.draft(session)
      const changed = session.setRequestedModel(
        {
          ...(input.model !== undefined ? { model: input.model } : {}),
          ...(input.effort !== undefined ? { effort: input.effort } : {}),
        },
        draft,
      )
      if (changed) {
        const persistence: Promise<void> = this.deps.persistDraft(session, draft)
        await persistence
        this.deps.broadcast()
      }
    }
    return result
  }

  /** Apply the same cancellation when the operator used the native CLI instead
   *  of Podium's stop control. Transcript parsers normalize every harness's
   *  wording to `event: interrupt`, so delivery policy stays provider-neutral. */
  async onTranscriptDelta(
    sessionId: SessionId,
    items: readonly { event?: string }[],
  ): Promise<void> {
    if (!items.some((item) => item.event === 'interrupt')) return
    await this.cancelInterruptedDelivery(sessionId)
  }

  private async cancelInterruptedDelivery(
    sessionId: SessionId,
    includeUnattempted = false,
    sourceMessageId?: string,
  ): Promise<boolean> {
    const session = this.deps.getSession(sessionId)
    if (!session) return false
    // Only the head can have crossed into the CLI. Rows behind it have not been
    // part of the interrupted interaction and remain individually retractable.
    const queuedRows: Promise<QueuedInboxMessage[]> = this.deps.queue.list(sessionId)
    const rows = await queuedRows
    const head = sourceMessageId
      ? rows.find((row) => row.sourceMessageId === sourceMessageId)
      : (rows.find((row) => row.attempts > 0) ?? (includeUnattempted ? rows[0] : undefined))
    if (!head) {
      if (includeUnattempted) {
        const retraction: Promise<void> | undefined = this.deps.authorization.interruptedPending?.({
          sessionId,
          ...(sourceMessageId ? { sourceMessageId } : {}),
        })
        await retraction
      }
      return false
    }
    // Agents cancel through the driver (POD-4279). A daemon-owned row needs a
    // successful driver cancel — retracting it locally would desync a delivery
    // the daemon still holds. A server-held row the daemon never admitted
    // retracts locally, so an idle stop still pulls back a queued send. Shells
    // keep the local-only path — they have no driver to call.
    if (session.agentKind !== 'shell') {
      const result = await this.deps.contractCancel?.(sessionId, head.id)
      if ((!result || !('ok' in result)) && head.deliveryOwner === 'daemon') return false
    }
    const deletion: Promise<void> = this.deps.queue.delete(head.id)
    await deletion
    this.forwardedRows.get(sessionId)?.ids.delete(head.id)
    const remaining = await this.deps.queue.list(sessionId)
    const persistence: Promise<void> = this.deps.write(session, (draft) => {
      draft.queuedMessageCount = remaining.length
    })
    await persistence
    this.deps.broadcast()
    const completion: Promise<void> | undefined = this.deps.authorization.interrupted?.({
      sourceMessageId: head.sourceMessageId,
      sessionId,
    })
    await completion
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

  async queueText(input: InboxSendInput & { mutationId?: MutationId }): Promise<{
    ok: boolean
    queued?: boolean
    reason?: string
  }> {
    const session = this.deps.getSession(input.sessionId)
    if (!session) return { ok: false, reason: 'unknown session' }
    const blockedReason = sessionSendRefusalReason(session, input.allowErrored === true)
    if (blockedReason) return { ok: false, reason: blockedReason }
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
    if (
      input.sourceMessageId &&
      (await this.hasQueuedMessage(input.sessionId, input.sourceMessageId))
    ) {
      if (parked) this.deps.resurrect(input.sessionId, principal)
      await this.drain(input.sessionId)
      return { ok: true, queued: true }
    }
    // Persist admission before a row can be drained or reported as queued.
    await this.deps.prepareSend(
      input.sessionId,
      principal.attribution,
      'text',
      input.inputOrigin ?? 'controller',
    )
    if (this.deps.getSession(input.sessionId) !== session)
      return { ok: false, reason: 'session changed during admission' }
    const currentRefusal = sessionSendRefusalReason(session, input.allowErrored === true)
    if (currentRefusal) return { ok: false, reason: currentRefusal }
    if (input.sourceMessageId && (await this.hasQueuedMessage(input.sessionId, input.sourceMessageId)))
      return { ok: true, queued: true }
    const insertion: Promise<boolean> = this.deps.queue.enqueue({
      id: input.mutationId ?? randomUUID(),
      sessionId: input.sessionId,
      text: input.text,
      inputOrigin: input.inputOrigin ?? 'controller',
      queuedAt: this.deps.now(),
      principal,
      sourceMessageId: input.sourceMessageId ?? null,
    })
    const inserted = await insertion
    if (inserted) {
      if (input.allowErrored) this.recoveryDrains.add(input.sessionId)
      const persistence: Promise<void> = this.deps.write(
        session,
        (draft) => {
          draft.queuedMessageCount += 1
        },
        { cancelTerminalCandidate: true },
      )
      await persistence
      this.deps.broadcast()
    }
    // Ask for the wake; the reaction decides and reports. See the port's note.
    if (parked) this.deps.resurrect(input.sessionId, principal)
    await this.drain(input.sessionId)
    return { ok: true, queued: true }
  }

  /** Current FIFO position for a message-ledger row already handed to the
   * SessionInbox queue. The lookup is intentionally live so a drained head
   * immediately moves the remaining row to its honest new ordinal. */
  async queuedMessagePosition(
    sessionId: SessionId,
    sourceMessageId: string,
  ): Promise<number | undefined> {
    const queuedRows: Promise<QueuedInboxMessage[]> = this.deps.queue.list(sessionId)
    const position = (await queuedRows).findIndex(
      (row) => row.sourceMessageId === sourceMessageId,
    )
    return position >= 0 ? position + 1 : undefined
  }

  /** Reconstruct a lost wake intent from the durable queue after liveness proof. */
  async reconcileQueuedWake(sessionId: SessionId): Promise<void> {
    const session = this.deps.getSession(sessionId)
    if (
      !session ||
      session.archived ||
      (session.status !== 'hibernated' && session.status !== 'exited') ||
      (session.agentKind !== 'shell' && !session.resume)
    )
      return
    const queuedRows: Promise<QueuedInboxMessage[]> = this.deps.queue.list(sessionId)
    const head = (await queuedRows)[0]
    if (head) this.deps.resurrect(sessionId, head.principal)
  }

  /** Remove every still-pending PTY row backed by one message-ledger intent. */
  async cancelQueuedMessage(sessionId: SessionId, sourceMessageId: string): Promise<boolean> {
    const session = this.deps.getSession(sessionId)
    if (!session) return false
    const queuedRows: Promise<QueuedInboxMessage[]> = this.deps.queue.list(sessionId)
    const matches = (await queuedRows).filter(
      (row) => row.sourceMessageId === sourceMessageId,
    )
    if (matches.length === 0) return false
    for (const row of matches) {
      // Agents cancel through the driver (POD-4279): daemon-owned rows need a
      // successful driver cancel, server-held rows retract locally. Shells
      // keep the local-only path — they have no driver to call.
      if (session.agentKind !== 'shell') {
        const result = await this.deps.contractCancel?.(sessionId, row.id)
        if ((!result || !('ok' in result)) && row.deliveryOwner === 'daemon') return false
      }
      const deletion: Promise<void> = this.deps.queue.delete(row.id)
      await deletion
      this.forwardedRows.get(sessionId)?.ids.delete(row.id)
    }
    const remaining = await this.deps.queue.list(sessionId)
    const persistence: Promise<void> = this.deps.write(session, (draft) => {
      draft.queuedMessageCount = remaining.length
      // Read off the DRAFT [POD-3330]: this asks what the count will BE, and
      // until the commit returns the live session still carries the old one.
      if (draft.queuedMessageCount === 0) this.recoveryDrains.delete(session.sessionId)
    })
    await persistence
    this.deps.broadcast()
    return true
  }

  async hasQueuedMessage(sessionId: SessionId, sourceMessageId: string): Promise<boolean> {
    const queuedRows: Promise<QueuedInboxMessage[]> = this.deps.queue.list(sessionId)
    return (await queuedRows).some(
      (row) => row.sourceMessageId === sourceMessageId,
    )
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
  async sweepQueuedInputs(): Promise<void> {
    // SINGLE-FLIGHT ON THE SWEEP, over the per-session one the fan-out already
    // has (POD-3258). `drain` is fenced by `activeDrains`, so an overlapping
    // sweep could never double-deliver a row even without this. What it fences
    // is the enumeration itself: `sessionsWithPending` is a store read, and once
    // it awaits, a second tick lands on the same durable queue and walks it
    // again to reach a fan-out that will refuse every entry. Skipped, not
    // queued — the sweep is a backstop whose subject is durable, so the next
    // tick sees whatever is still pending.
    if (this.sweepingQueuedInputs) return
    this.sweepingQueuedInputs = true
    try {
      const enumeration: Promise<SessionId[]> | undefined = this.deps.queue.sessionsWithPending?.()
      const pending = await enumeration
      if (!pending) return
      for (const sessionId of pending) await this.drain(sessionId)
    } finally {
      this.sweepingQueuedInputs = false
    }
  }

  /**
  * Deliver this session's queued rows, oldest first, through the runtime
  * contract (POD-4427).
  *
  * THE ONLY DELIVERY AN AGENT HAS. A row leaves the queue only when the driver
  * settles it: `deliveryOutcome` folds the driver's `delivery` events into
  * settle-or-keep decisions, and a row the daemon never acknowledged stays
  * durable and queued with a visible failure. The server never types at, polls
  * or retries a harness — readiness and retry are the driver's own
  * delivery-queue, one hop down.
  */
  private readonly forwardedRows = new Map<SessionId, { session: Session; machineId: string; ids: Set<string> }>()
  private readonly forwarding = new Map<SessionId, Promise<void>>()

  /** Admission only: no readiness, confirmation, retry clocks or delivery polling. */
  private async forwardContractRows(session: Session, justBound: boolean): Promise<void> {
    const sessionId = session.sessionId
    if (justBound) {
      this.forwardedRows.delete(sessionId)
      this.forwarding.delete(sessionId)
    }
    const pending = this.forwarding.get(sessionId)
    if (pending) { await pending; return this.forwardContractRows(session, false) }
    const run = async () => {
      let forwarded = this.forwardedRows.get(sessionId)
      if (!forwarded || forwarded.session !== session || forwarded.machineId !== session.machineId) {
        forwarded = { session, machineId: session.machineId, ids: new Set() }
        this.forwardedRows.set(sessionId, forwarded)
      }
      const binding = forwarded
      const current = () => !this.disposed && this.deps.getSession(sessionId) === session &&
        session.machineId === binding.machineId && this.forwardedRows.get(sessionId) === binding &&
        // A starting session WITH transcript history is rebinding after a
        // restart (POD-4360): its transcript may not yet carry the witness
        // turns the previous custody delivered, so forwarding now would
        // duplicate them. Hold until live, when hydration has landed and the
        // witness check below is reliable. New sessions (no transcript) still
        // forward from admission.
        (session.status === 'live' || (session.status === 'starting' && !session.transcriptAvailable)) &&
        // Drain only calls this for agents, and the contract is their only
        // delivery (POD-4427): there is no rollout gate and no second route.
        this.deps.nativeViewActive?.(sessionId) !== true &&
        !sessionSendRefusalReason(session, this.recoveryDrains.has(sessionId))
      const rows = await this.deps.queue.list(sessionId)
      for (const row of rows) {
        if (!current() || this.deps.nativeViewActive?.(sessionId)) return
        if (binding.ids.has(row.id)) continue
        if (!this.deps.contractDeliver || !this.deps.queue.reserveDelivery) return
        const allowed = await this.deps.authorization.authorizeAtDrain({ sessionId, principal: row.principal, sourceMessageId: row.sourceMessageId })
        if (!current()) return
        // A cancel can race asynchronous admission. The durable row remains the authority.
        if (!(await this.deps.queue.list(sessionId)).some((entry) => entry.id === row.id)) continue
        if (!current()) return
        if (!allowed.ok) {
          // Revocation cannot erase an existing owner's work or acceptance proof.
          if (row.deliveryOwner === 'daemon') {
            if (!this.deps.contractCancel) return
            const cancelled = await this.deps.contractCancel(sessionId, row.id)
            if (!current() || !('ok' in cancelled && cancelled.ok)) return
            if (!(await this.deps.queue.list(sessionId)).some((entry) => entry.id === row.id)) continue
            if (!current()) return
          }
          await this.deps.authorization.rejected({ queueId: row.id, sourceMessageId: row.sourceMessageId, principal: row.principal, reason: allowed.reason })
          await this.deps.queue.delete(row.id)
          continue
        }
        // ALREADY DELIVERED (POD-4360): a previous custody delivered it and
        // the outcome never came back. Settle it here; delivering it again is
        // the duplicate the agent would read as a replay.
        if (transcriptWitnesses(session, row)) {
          log.info('queued row already witnessed in the transcript; settling without redelivery', {
            sessionId, rowId: row.id,
          })
          await this.settleDelivered(session, row)
          continue
        }
        const recovery = row.attempts > 0 || row.deliveryOwner === 'daemon'
        // The durable reservation precedes every possible external write. On a
        // replacement owner it means confirm-or-fail, never replay the prompt.
        const reservedHere = row.deliveryOwner !== 'daemon'
        const attemptsBeforeReservation = row.attempts
        if (reservedHere) await this.deps.queue.reserveDelivery(row.id)
        if (!current()) return
        if (!(await this.deps.queue.list(sessionId)).some((entry) => entry.id === row.id)) continue
        if (!current()) return
        binding.ids.add(row.id)
        try {
          // Await custody in FIFO order. A queued receipt is NOT acceptance;
          // only the fenced delivery event can settle the durable row.
          const receipt = await this.deps.contractDeliver({
            sessionId, turnId: row.id, text: row.text, origin: row.inputOrigin,
            principal: row.principal, deliveryRecovery: recovery,
            initialPrompt: isInitialPromptRow(sessionId, row),
          })
          if (!current()) return
          if (receipt.outcome !== 'queued' && receipt.outcome !== 'accepted') {
            binding.ids.delete(row.id)
            // A refusal proves only THIS forward typed nothing. A reservation
            // an earlier forward took stays: that one may have written.
            if (receipt.outcome === 'refused' && reservedHere && REFUSALS_PROVING_NO_WRITE.has(receipt.refusal.reason)) {
              await this.deps.queue.releaseDelivery?.(row.id, attemptsBeforeReservation)
            }
            await this.reportContractUnconfirmed(sessionId, row, receipt.outcome === 'refused'
              ? receipt.refusal.detail ?? receipt.refusal.reason
              : 'the daemon did not acknowledge custody; delivery remains unconfirmed')
            return
          }
        } catch (error) {
          if (!current()) return
          binding.ids.delete(row.id)
          log.warn('contract queue forwarding failed', { sessionId, err: error })
          await this.reportContractUnconfirmed(sessionId, row, 'the daemon did not acknowledge custody; delivery remains unconfirmed')
          return
        }
      }
      if (current()) {
        const remaining = await this.deps.queue.list(sessionId)
        await this.deps.write(session, (draft) => { draft.queuedMessageCount = remaining.length })
        this.deps.broadcast()
      }
    }
    const operation = run()
    this.forwarding.set(sessionId, operation)
    try { await operation } finally { if (this.forwarding.get(sessionId) === operation) this.forwarding.delete(sessionId) }
  }

  /** The delivered half of a row's settlement: the ledger learns it was
   *  applied, a draft holding the same text clears, the row leaves the queue. */
  private async settleDelivered(session: Session, row: QueuedInboxMessage): Promise<void> {
    const sessionId = session.sessionId
    this.reportedPromptFailures.delete(row.id)
    if (row.sourceMessageId) await this.deps.authorization.applied({ sessionId, sourceMessageId: row.sourceMessageId })
    if (this.deps.draftText?.(sessionId) === row.text) await this.deps.setSessionDraft?.({ sessionId, text: '' })
    await this.deps.queue.delete(row.id)
    this.forwardedRows.get(sessionId)?.ids.delete(row.id)
  }

  /** Transport uncertainty keeps the row: a delayed proof may still settle it. */
  private async reportContractUnconfirmed(sessionId: SessionId, row: QueuedInboxMessage, reason: string): Promise<void> {
    if (this.reportedPromptFailures.has(row.id)) return
    if (!(await this.deps.queue.list(sessionId)).some((entry) => entry.id === row.id)) return
    this.reportedPromptFailures.add(row.id)
    const draft = this.deps.draftText?.(sessionId)
    if (draft === undefined || draft === '' || draft === row.text) {
      await this.deps.setSessionDraft?.({ sessionId, text: row.text })
    }
    const ownerUserId = await this.deps.ownerOf(sessionId)
    await this.deps.attention.promptFailed({ ...(ownerUserId ? { ownerUserId } : {}),
      sessionId, text: row.text, reason, initialPrompt: isInitialPromptRow(sessionId, row) })
  }

  private readonly settlingDeliveries = new Map<string, Promise<void>>()

  /** Already ownership/generation-fenced by the runtime event gate. Repeat-safe by row id. */
  async deliveryOutcome(sessionId: SessionId, event: { rowId: string; outcome: 'delivered' | 'failed' | 'dropped'; reason?: string }): Promise<void> {
    const key = `${sessionId}:${event.rowId}`
    const pending = this.settlingDeliveries.get(key)
    if (pending) { await pending; return }
    const settlement = this.settleDeliveryOutcome(sessionId, event)
    this.settlingDeliveries.set(key, settlement)
    try { await settlement } finally { this.settlingDeliveries.delete(key) }
  }

  private async settleDeliveryOutcome(sessionId: SessionId, event: { rowId: string; outcome: 'delivered' | 'failed' | 'dropped'; reason?: string }): Promise<void> {
    const session = this.deps.getSession(sessionId)
    if (!session) return
    const row = (await this.deps.queue.list(sessionId)).find((entry) => entry.id === event.rowId)
    if (!row) return
    if (event.outcome === 'delivered') {
      await this.settleDelivered(session, row)
    } else if (event.outcome === 'dropped') {
      await this.deps.authorization.interrupted?.({ sessionId, sourceMessageId: row.sourceMessageId })
    } else {
      const reason = event.reason ?? 'daemon could not confirm delivery'
      const draft = this.deps.draftText?.(sessionId)
      if (draft === undefined || draft === '' || draft === row.text) {
        await this.deps.setSessionDraft?.({ sessionId, text: row.text })
      }
      await this.deps.authorization.rejected({ queueId: row.id, sourceMessageId: row.sourceMessageId, principal: row.principal, reason })
      const ownerUserId = await this.deps.ownerOf(sessionId)
      await this.deps.attention.promptFailed({ ...(ownerUserId ? { ownerUserId } : {}), sessionId, text: row.text, reason, initialPrompt: isInitialPromptRow(sessionId, row) })
    }
    if (event.outcome !== 'delivered') {
      await this.deps.queue.delete(row.id)
      this.forwardedRows.get(sessionId)?.ids.delete(row.id)
    }
    const remaining = await this.deps.queue.list(sessionId)
    await this.deps.write(session, (draft) => { draft.queuedMessageCount = remaining.length })
    this.deps.broadcast()
    if (remaining.length) await this.drain(sessionId)
  }

  async drain(sessionId: SessionId, opts?: { justBound?: boolean }): Promise<void> {
    const session = this.deps.getSession(sessionId)
    if (!session || this.disposed) return
    // Agents always forward (POD-4427): the driver contract is the only
    // delivery. Plain-terminal shells (POD-4278) keep the raw transport below:
    // they have no driver, and chat-to-shell types into the PTY the operator
    // is watching.
    if (session.agentKind !== 'shell') {
      if (this.deps.nativeViewActive?.(sessionId) === true) return
      void this.forwardContractRows(session, opts?.justBound === true).catch((error) => {
        log.warn('contract admission failed', { sessionId, err: error })
      })
      return
    }
    if (this.deps.nativeViewActive?.(sessionId) === true) return
    await this.forwardShellRows(session)
  }

  /**
  * The shell's drain: FIFO rows onto the raw transport, settled on send.
  *
  * Shells have no driver and no transcript witness — bytes onto the PTY the
  * operator is watching ARE the delivery, exactly as a controller keystroke.
  * No readiness wait, no confirmation poll, no retry: a row its owner may no
  * longer accept is removed with a refusal, everything else is sent once and
  * settled. Single-flight per session so concurrent re-arms cannot double-send.
  */
  private async forwardShellRows(session: Session): Promise<void> {
    const sessionId = session.sessionId
    if (this.activeDrains.has(sessionId)) return
    const generation = (this.drainGenerations.get(sessionId) ?? 0) + 1
    this.drainGenerations.set(sessionId, generation)
    this.activeDrains.add(sessionId)
    const isCurrent = (): boolean =>
      !this.disposed &&
      this.drainGenerations.get(sessionId) === generation &&
      this.activeDrains.has(sessionId) &&
      this.deps.getSession(sessionId) === session
    try {
      for (;;) {
        if (!isCurrent()) return
        if (session.status !== 'live' && session.status !== 'starting') return
        const blockedReason = sessionSendRefusalReason(session, this.recoveryDrains.has(sessionId))
        const rows = await this.deps.queue.list(sessionId)
        const head = rows[0]
        if (!head) return
        if (blockedReason) {
          await this.reportShellBlocked(session, head, blockedReason)
          return
        }
        // A live menu holds the shell: bytes typed now would answer the wrong
        // question (#473). The row waits for the menu-cleared re-arm in
        // `stateChanged`, reported once so the hold is visible.
        if (session.agentState?.phase === 'needs_user') {
          await this.reportShellBlocked(
            session,
            head,
            'the agent is waiting for an answer before this input can be sent',
          )
          return
        }
        // The security boundary is HERE, immediately before the daemon gateway.
        // Nothing accepted at enqueue is trusted now.
        const authorized = await this.deps.authorization.authorizeAtDrain({
          sessionId,
          principal: head.principal,
          sourceMessageId: head.sourceMessageId,
        })
        if (!isCurrent()) return
        // A cancel can race asynchronous admission. The durable row remains the authority.
        if (!(await this.deps.queue.list(sessionId)).some((row) => row.id === head.id)) continue
        if (!authorized.ok) {
          await this.deps.queue.delete(head.id)
          await this.deps.authorization.rejected({
            queueId: head.id,
            sourceMessageId: head.sourceMessageId,
            principal: head.principal,
            reason: authorized.reason,
          })
          continue
        }
        this.sendShellText(session, {
          sessionId,
          text: head.text,
          inputOrigin: head.inputOrigin,
          principal: head.principal,
          ...(head.sourceMessageId ? { sourceMessageId: head.sourceMessageId } : {}),
        })
        await this.settleDelivered(session, head)
        if (!isCurrent()) return
        const remaining = await this.deps.queue.list(sessionId)
        await this.deps.write(session, (draft) => {
          draft.queuedMessageCount = remaining.length
          if (draft.queuedMessageCount === 0) this.recoveryDrains.delete(session.sessionId)
        })
        this.deps.broadcast()
      }
    } finally {
      if (this.drainGenerations.get(sessionId) === generation) {
        this.activeDrains.delete(sessionId)
      }
    }
  }

  /** A shell row that met a session it must not be typed into. The row stays
  *  durable and visible; the failure is reported once per row. */
  private async reportShellBlocked(
    session: Session,
    head: QueuedInboxMessage,
    reason: string,
  ): Promise<void> {
    if (this.reportedPromptFailures.has(head.id)) return
    if (!(await this.deps.queue.list(session.sessionId)).some((row) => row.id === head.id)) return
    this.reportedPromptFailures.add(head.id)
    const draft = this.deps.draftText?.(session.sessionId)
    if (draft === undefined || draft === '' || draft === head.text) {
      await this.deps.setSessionDraft?.({ sessionId: session.sessionId, text: head.text })
    }
    const ownerUserId = await this.deps.ownerOf(session.sessionId)
    await this.deps.attention.promptFailed({
      ...(ownerUserId ? { ownerUserId } : {}),
      sessionId: session.sessionId,
      text: head.text,
      reason,
      initialPrompt: isInitialPromptRow(session.sessionId, head),
    })
  }

  /**
  * Answer an interaction through the caller's delivery — in production the
  * runtime gateway's `answer`, which reaches the driver that owns the menu
  * (POD-4427). The keystroke script this method used to type lives in the
  * terminal driver now (`menuScriptFor`); the server never types menu keys.
  *
  * Admission (owner resolution, liveness, prepareSend) stays here: it is the
  * transport's gate, not the driver's.
  */
  async deliverInteractionAnswer(
    input: { sessionId: SessionId; principal: InboxPrincipalReference },
    deliver: () => Promise<import('@podium/protocol').InteractionAnswerOutcome>,
  ): Promise<import('@podium/protocol').InteractionAnswerOutcome> {
    const session = this.deps.getSession(input.sessionId)
    const ownerUserId = await this.deps.ownerOf(input.sessionId)
    if (!session || !ownerUserId || (session.status !== 'live' && session.status !== 'starting')) {
      return { ok: false, reason: 'expired' }
    }
    const origin = input.principal.kind === 'user' ? 'human' : input.principal.kind === 'agent' ? 'steward' : 'system'
    await this.deps.prepareSend(input.sessionId, input.principal.attribution, 'answer', origin)
    if (this.deps.getSession(input.sessionId) !== session ||
        await this.deps.ownerOf(input.sessionId) !== ownerUserId ||
        (session.status !== 'live' && session.status !== 'starting')) return { ok: false, reason: 'expired' }
    const result = await deliver()
    if (result.ok) await this.deps.attention.answered({ ownerUserId, sessionId: input.sessionId,
      attribution: input.principal.attribution })
    return result
  }

  async answerAskUserQuestion(input: {
    interactionId?: string
    sessionId: SessionId
    choices?: AnswerChoice[]
    skip?: boolean
    principal: InboxPrincipalReference
  }): Promise<{ ok: boolean; reason?: string }> {
    const session = this.deps.getSession(input.sessionId)
    const ownerUserId = await this.deps.ownerOf(input.sessionId)
    // Attention is per-owner. An unresolved owner is not an invitation to send
    // to an ambient operator; fail closed before bytes or notifications move.
    // Bare `{ok:false}` here is pinned by the command oracle — the NEW refusal
    // class below is the one that carries a reason.
    if (!session || !ownerUserId || (session.status !== 'live' && session.status !== 'starting')) {
      return { ok: false }
    }
    // Contract-only answers (POD-4279). The driver owns the menu script behind
    // its interaction identity; the server never types menu keys. Transcript-
    // derived choices without an authoritative interaction id fail closed
    // rather than typing blind — see POD-4292 and the terminal-answer-contract
    // test for the exercised replacement. Offer retirement still gates
    // admission, exactly as it did for typed answers.
    const attribution = input.principal.attribution
    const answerState = session.agentState
    await this.deps.prepareSend(input.sessionId, attribution, 'answer', 'human')
    if (
      this.deps.getSession(input.sessionId) !== session ||
      session.agentState !== answerState ||
      (await this.deps.ownerOf(input.sessionId)) !== ownerUserId ||
      (session.status !== 'live' && session.status !== 'starting')
    )
      return { ok: false, reason: 'session changed during answer admission' }
    if (!input.interactionId || !this.deps.contractAnswer) return { ok: false, reason: 'unknown-interaction' }
    return await this.deps.contractAnswer(input)
  }

  async stateChanged(input: {
    sessionId: SessionId
    prev: AgentRuntimeState | undefined
    next: AgentRuntimeState
    observation?: AgentObservation
  }): Promise<void> {
    // A CLEARED MENU IS A RE-ARM (POD-1703). A send never types into an
    // AskUserQuestion menu — it would answer the wrong question — and the
    // drain then waits for "the next re-arm". That used to mean a daemon bind,
    // which on a healthy long-lived session may never come, so an offer clicked
    // while the agent sat on a permission prompt hung indefinitely. The moment
    // the menu clears is the exact edge that unblocks it, and it costs nothing
    // on a session with an empty queue (a drain over no rows is a no-op).
    if (input.prev?.phase === 'needs_user' && input.next.phase !== 'needs_user') {
      // NOT awaited: this is a re-arm on a state edge, and a drain pass that
      // fails loses nothing — the row is durable and the next bind, reconnect,
      // enqueue or sweep re-arms a fresh one (rule 57; see `dispose`).
      void this.drain(input.sessionId)
    }
    const ownerUserId = await this.deps.ownerOf(input.sessionId)
    if (!ownerUserId) return
    this.deps.attention.stateChanged({ ...input, ownerUserId })
  }

  /**
   * Controller-gated PTY input. Attribution is stamped from the transport
   * principal (ADR 3 D7) and retained LIVE only (POD-1081 §2). Concurrent
   * keystrokes are a control problem, not a text merge (readiness §4).
   */
  async handleControllerInput(
    principal: ClientPrincipal,
    client: ClientConn,
    sessionId: SessionId,
    data: string,
  ): Promise<void> {
    await this.handleControllerInputBytes(principal, client, sessionId, Buffer.from(data, 'base64'))
  }

  async handleControllerInputBytes(
    principal: ClientPrincipal,
    client: ClientConn,
    sessionId: SessionId,
    bytes: Uint8Array,
  ): Promise<void> {
    if (bytes.byteLength === 0) return
    const session = this.deps.getSession(sessionId)
    if (!session) return
    // Live re-auth at apply: a revoked human (or their agent) loses control here
    // rather than via a reaper (ADR 9 D5 A1 / ADR 3 D8).
    if (this.deps.authorizeDrive && !(await this.deps.authorizeDrive(principal, sessionId))) {
      if (session.terminal.controllerId === client.id) session.terminal.revokeController()
      return
    }
    if (this.deps.getSession(sessionId) !== session) return
    // The native terminal sees the operator's abort key before the transcript
    // can report its result. Retract a chat-owned queued row at this boundary,
    // or a row admitted just ahead of the interrupt waits out a drain instead
    // of being pulled back (POD-1733). Compared as bytes: this path no longer
    // carries the base64 the check was first written for.
    const abort = this.abortKeyFor(session)
    if (session.terminal.controllerId === client.id && abort && Buffer.from(abort).equals(bytes)) {
      // Spec rule 57 (POD-3528): the callee went async and this frame handler cannot
      // yield. Left non-blocking, which is exactly today's behaviour — the
      // retraction above runs before the callee's first await.
      // Report a failed retraction without delaying the terminal input frame.
      void this.cancelInterruptedDelivery(sessionId, true).catch((error) => {
        log.warn('native interrupt retraction failed', { err: error, sessionId })
      })
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
  async requestControl(
    principal: ClientPrincipal,
    client: ClientConn,
    sessionId: SessionId,
    geometry?: Geometry,
  ): Promise<void> {
    const session = this.deps.getSession(sessionId)
    if (!session) return
    if (this.deps.authorizeDrive && !(await this.deps.authorizeDrive(principal, sessionId))) {
      client.send({
        type: 'terminalOutcome',
        sessionId,
        outcome: 'unauthorized',
      })
      return
    }
    if (this.deps.getSession(sessionId) !== session) return
    session.terminal.requestControl(client.id, geometry)
  }

  /**
   * If exactly one connection renders the native terminal, make it the driver.
   * Person-level presence intentionally collapses a user's devices, so sizing
   * policy derives from the terminal's per-connection renderer set instead.
   */
  async reconcileActiveRenderer(sessionId: SessionId): Promise<boolean> {
    const session = this.deps.getSession(sessionId)
    if (!session) return false
    const [sole, second] = session.terminal.activeNativeRenderers()
    if (!sole || second) return false
    if (this.deps.authorizeDrive && !(await this.deps.authorizeDrive(sole.principal, sessionId)))
      return false
    const [currentSole, currentSecond] = session.terminal.activeNativeRenderers()
    if (currentSole !== sole || currentSecond || this.deps.getSession(sessionId) !== session) return false
    const previous = session.terminal.controllerId
    // Never auto-transfer on a stale/unknown grid. A newly active renderer
    // reports its current viewport immediately; handleResize calls back into
    // this method after storing that measurement.
    if (previous !== sole.id && !sole.viewports.has(sessionId)) return false
    session.terminal.requestControl(sole.id)
    return previous !== session.terminal.controllerId
  }

  async handleResize(
    principal: ClientPrincipal,
    client: ClientConn,
    sessionId: SessionId,
    cols: number,
    rows: number,
  ): Promise<boolean> {
    void principal
    const session = this.deps.getSession(sessionId)
    if (!session) return false
    session.terminal.handleResize(client.id, cols, rows)
    return this.reconcileActiveRenderer(sessionId)
  }

  /**
   * THE ONE ASK (POD-3239 B6). The terminal decides; this seam adds the
   * sole-renderer promotion that follows any recorded measurement, exactly as
   * the legacy resize path does — a request that was refused still recorded its
   * viewport, and that record is what `reconcileActiveRenderer` needs.
   */
  async handleViewportRequest(
    principal: ClientPrincipal,
    client: ClientConn,
    sessionId: SessionId,
    request: ViewportRequest,
  ): Promise<boolean> {
    void principal
    const session = this.deps.getSession(sessionId)
    if (!session) return false
    const controllerChanged = session.terminal.handleViewportRequest(client.id, request)
    return (await this.reconcileActiveRenderer(sessionId)) || controllerChanged
  }

  reconcileGeometry(principal: ClientPrincipal, client: ClientConn, sessionId: SessionId): void {
    void principal
    this.deps.getSession(sessionId)?.terminal.reconcileGeometry(client.id)
  }

  /**
  * Raw bytes for a shell turn: the bracketed paste plus its submit, with no
  * timers behind them (POD-4427).
  *
  * This is transport, not delivery: the same bytes a controller keystroke
  * would put on the wire, and the reason shells are exempt from the
  * never-types rule — there is no harness here to type AT, only a PTY the
  * operator is watching. One submit, sent with the paste: the delayed-CR
  * verify loop that used to follow is gone with the agent typing path whose
  * doubled characters it produced.
  *
  * THE TRUST BOUNDARY, AND IT IS CROSSED EXACTLY HERE (POD-2708).
  *
  * `injectionPayload` is the only thing on this side that puts caller text
  * inside a bracketed paste, and it cannot do so without first removing every
  * byte a shell's line discipline would read as control — so no text arriving
  * at this line can close the envelope it is about to be wrapped in, whoever
  * sent it.
  */
  private sendShellText(session: Session, input: InboxSendInput): void {
    const principal = input.principal ?? SYSTEM_INBOX_PRINCIPAL
    this.sendInput(
      session,
      injectionPayload(input.text, { rawFirstTurn: false }),
      input.inputOrigin ?? 'controller',
      principal.attribution,
    )
    this.sendInput(session, '\r', input.inputOrigin ?? 'controller', principal.attribution)
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
