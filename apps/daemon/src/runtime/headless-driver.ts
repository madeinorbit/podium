/**
 * THE HEADLESS RUNTIME DRIVER (POD-4392).
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS IS
 * ---------------------------------------------------------------------------
 *
 * The legacy headless port (`control/headless.ts` + `headless-drivers.ts` +
 * `durable-headless.ts`) runs superagent and shipwright turns as one-shot
 * harness invocations outside the Agent Runtime contract. This module puts that
 * exact machinery behind the contract — one `RuntimeDriver` (`id: 'headless'`,
 * per harness) whose `send()` runs one headless turn — so those turns can
 * dispatch through the driver-contract WS relay (`runtimeSendRequest` and
 * friends, with the POD-4386 per-turn fields) instead of `headlessTurnRequest`.
 *
 * ADAPTER, NOT A REWRITE. Every behavior below delegates to the functions the
 * legacy path already runs: `runHeadlessTurn` for the in-process child turns,
 * `runDurableHeadlessTurn` for the abduco-journalled ones (which keeps owning
 * replay-without-rerun, identity-checked ack and the original deadline), the
 * harness adapter registry for the no-tools verdict, the native-account fence,
 * and the observers' `bindHeadlessSession` for the transcript rebind. Nothing
 * here reimplements a harness invocation.
 *
 * ---------------------------------------------------------------------------
 * WHERE THE TRUTH LIVES (READ THIS BEFORE ADDING A FIELD)
 * ---------------------------------------------------------------------------
 *
 * - Turn OUTCOME truth is the harness transcript tail (bound via the host's
 *   `bindHeadlessSession`), read through `transcript.history`. This driver never
 *   emits `complete` transcript items: synthesizing a second item for text the
 *   tail will also deliver is the duplicate every merge rule exists to prevent.
 *   Live preview travels as turn-scoped `partial` fragments (replaced, never
 *   appended, by the history items on completion) plus turn started/completed /
 *   failed events.
 * - Turn RESULT durability is the durable function's filesystem journal, not a
 *   second journal here. This driver adds no journal of its own: replay,
 *   mismatch refusal, ack discipline and the original `createdAt` deadline all
 *   come out of `runDurableHeadlessTurn` / `acknowledgeDurableHeadlessTurn`.
 * - Turn IDENTITY (`turnId` + `requestDigest` + `accountId`) rides `TurnInput`
 *   (`id`, `requestDigest`, `accountId`, all required) exactly as the WS relay
 *   delivers it (`handlers.ts` maps the frame's `turnId` onto `TurnInput.id`).
 *   The digest is recomputed here over the turn-carried facts with
 *   `canonicalHeadlessContractFacts` and refused on mismatch BEFORE dispatch —
 *   the same fence `control/headless.ts` runs, never a rerun.
 *
 * ---------------------------------------------------------------------------
 * KNOWN GAPS (FILED, NOT HIDDEN)
 * ---------------------------------------------------------------------------
 *
 * ESTABLISHMENT. There is no dedicated WS create/resume/adopt verb for
 * headless sessions: they are established the same way every other
 * contract session is — `spawn`/`reattach` carrying
 * `runtimeContract: 'headless'`, resolved to this driver by explicit
 * preference (no manifest `select()` ever returns it) and created via
 * `runtime.create`/`resume`/`adopt` on the host-minted session id. The legacy
 * `control/headless.ts` port (`headlessTurnRequest` and friends) keeps serving
 * production turns unchanged until callers migrate; this driver is proven by
 * its tests, not by shadowing production.
 * - Per-turn `contextPrompt` and `timeoutMs` have no contract carriers: sticky
 *   instructions ride `systemPrompt`, and the turn budget stays the runner
 *   default. The caller-migration issue owns carrying them.
 * - `structuredPermissions: true` routes claude-code turns through the SDK
 *   child with its `canUseTool` callback wired to contract PendingInteractions
 *   (open/answer/close). Other harnesses refuse `unsupported`: their
 *   child-process drivers have no permission callback to route. Structured
 *   turns bypass the durable CLI journal — the durable runner speaks the
 *   non-interactive `claude -p` surface, so a permission that needs a live
 *   answer cannot survive there — and run as in-process SDK turns with the
 *   same digest fence and transcript bind, but no cross-restart replay.
 * - `export()` ships the harness-native transcript file (the same locator the
 *   terminal driver's `export()` and the handoff package use) for harnesses
 *   that declare one, and refuses `unsupported` for those that do not.
 */

import { createHash, randomUUID } from 'node:crypto'
import {
  canonicalHeadlessContractFacts,
  type AgentSessionHandle,
  type AttachEndpoint,
  type AttachmentStageResult,
  type ConfigureRequest,
  type DriverCapabilities,
  type DriverProcedureOverrides,
  type EventStreamStart,
  type InteractionAnswerOutcome,
  type PendingInteraction,
  type Refusal,
  type RuntimeDriver,
  type RuntimeEvent,
  type RuntimeEventBody,
  type SendOptions,
  type SessionArchive,
  type SessionBinding,
  type SessionHealth,
  type SessionLease,
  type SessionSnapshot,
  type SessionSpec,
  type TurnDelivery,
  type TurnInput,
  type TurnReceipt,
  type UsageSnapshot,
  createRuntimeEventStream,
  DriverRefusalError,
  driverLocalCursor,
  headlessAskAndAwait,
  stampRuntimeEvent,
} from '@podium/agent-runtime'
import {
  declaredValue,
  harnessAdapterFor,
  supported,
  unsupported,
  type ResolvedHarnessInventory,
} from '@podium/harness'
import { createLogger } from '@podium/logger'
import {
  asAccountId,
  asSessionId,
  type AccountId,
  type AgentKind,
  type AgentRuntimeState,
  type HarnessAgent,
  type Inventory,
  type ResumeRef,
  type SessionId,
} from '@podium/model'
import { PermissionAnswer, type HeadlessTurnEvent, type ObservationProvenance } from '@podium/protocol'
import type {
  DaemonMessage,
  RuntimeHistoryPage,
  RuntimeHistoryRange,
} from '@podium/protocol/daemon'
import { isRuntimeFineEvent } from '@podium/protocol/daemon'
import type { DurableProcess } from '@podium/process/durable'
import {
  type HeadlessEmit,
  type HeadlessTurnHandle,
  type HeadlessTurnSpec,
  HeadlessTurnError,
  runHeadlessTurn,
} from '../headless-drivers.js'
import {
  acknowledgeDurableHeadlessTurn,
  runDurableHeadlessTurn,
} from '../durable-headless.js'

const log = createLogger('daemon:headless-driver')

export const HEADLESS_DRIVER_ID = 'headless' as const

/** How many events one headless session's replay buffer retains. Sized for a
 *  reconnect, not for history — history is the harness transcript. */
export const HEADLESS_EVENT_LOG_LIMIT = 512

function refuse(reason: Refusal['reason'], detail?: string): Refusal {
  return detail === undefined ? { reason } : { reason, detail }
}

// ---------------------------------------------------------------------------
// Host — everything this driver needs from the daemon, named explicitly
// ---------------------------------------------------------------------------

/** Session facts the transcript-history read needs. */
export interface HeadlessHistorySession {
  sessionId: SessionId
  agentKind: AgentKind
  cwd: string
  resume?: ResumeRef
}

export interface HeadlessDriverHost {
  /** Outbound daemon frames. The driver's only path to the server. */
  send(msg: DaemonMessage): void
  /** This generation's harness inventory (executables, command environment). */
  snapshot(): Promise<ResolvedHarnessInventory>
  /** The daemon's durable host, or undefined when this daemon runs backend=none
   *  and every turn is an in-process child. */
  durable(): DurableProcess | undefined
  /** Fail closed when the live native login no longer matches a tool-less turn.
   *  Throws with the same wording `control/headless.ts` reports today. The
   *  inventory slice comes from the same snapshot the dispatch runs under, so
   *  the check cannot pass on a login the launch does not see. */
  assertNativeAccount(
    agent: HarnessAgent,
    accountId: AccountId,
    inventory: Pick<Inventory, 'agents'>,
  ): void
  /** The instance-owned child environment for one turn (HOME + relay routing +
   *  tool-less account HOME). Mirrors the `spawnEnv` composition the legacy
   *  path builds per request, over the same snapshot the dispatch runs under. */
  sessionEnv(input: {
    sessionId: SessionId
    agent: HarnessAgent
    toolPolicyNone: boolean
    snapshot: ResolvedHarnessInventory
  }): Record<string, string>
  /** The exact durable host label for a session (stable across restarts — it is
   *  the process identity `adopt()` matches on). */
  durableLabel(sessionId: SessionId): string
  /** (Re)establish the per-kind transcript observers/tails — the reattach
   *  equivalent for sessions with no PTY. Best-effort at the call site. */
  bindHeadlessSession(
    sessionId: SessionId,
    agentKind: AgentKind,
    cwd: string,
    resumeValue: string,
  ): void
  /** A cursor-anchored harness-transcript slice, via the same source layer the
   *  `transcriptRead` frame uses. Must refuse foreign history cursors with a
   *  `DriverRefusalError` (`invalid_value`), exactly as the terminal host does. */
  readHistory(
    session: HeadlessHistorySession,
    range: Omit<RuntimeHistoryRange, 'direction'> & {
      direction?: RuntimeHistoryRange['direction']
    },
  ): Promise<RuntimeHistoryPage>
  /** Locate the harness-native transcript for an archive, or throw with the
   *  harness's own reason when it declares none. Same locator the terminal
   *  driver's `export()` uses (`transcriptForExport`). */
  archiveTranscript(input: {
    agentKind: AgentKind
    cwd: string
    resumeValue: string
  }): Promise<{ path: string; relativeDir?: string }>
  readFileBytes(path: string): Promise<Uint8Array>
  now(): number
}

/** One SDK permission ask, as the `canUseTool` callback reports it. */
export interface HeadlessPermissionRequest {
  id: string
  toolName: string
  input?: unknown
  suggestions?: readonly unknown[]
}

/** Live SDK callbacks a structured-permission turn routes into interactions.
 *  Only honoured on the in-process SDK path; the durable CLI runner has no
 *  permission channel and never receives these. */
export interface HeadlessRunnerHooks {
  onPermission?: (request: HeadlessPermissionRequest) => void
}

/** The turn-execution seam. Production passes the real headless functions;
 *  tests inject fakes that record specs and simulate outcomes. */
export interface HeadlessDriverRunners {
  runTurn(
    spec: HeadlessTurnSpec,
    emit: HeadlessEmit,
    snapshot: ResolvedHarnessInventory,
    hooks?: HeadlessRunnerHooks,
  ): HeadlessTurnHandle
  runDurableTurn(
    turnId: string,
    sessionId: SessionId,
    spec: HeadlessTurnSpec,
    emit: HeadlessEmit,
    snapshot: ResolvedHarnessInventory,
    durable: DurableProcess,
  ): HeadlessTurnHandle
}

const defaultRunners: HeadlessDriverRunners = {
  runTurn: (spec, emit, snapshot, hooks) => runHeadlessTurn(spec, emit, snapshot, hooks),
  runDurableTurn: (turnId, sessionId, spec, emit, snapshot, durable) =>
    runDurableHeadlessTurn(turnId, sessionId, spec, emit, snapshot, durable),
}

// ---------------------------------------------------------------------------
// Session state
// ---------------------------------------------------------------------------

interface LiveTurn {
  turnId: string
  rowId?: string
  requestDigest: string
  accountId: string
  turnEpoch: number
  deliveredAs: TurnDelivery
  startedAt: string
  /** Set by `interrupt()` (or an interrupt delivery): the rejection below is
   *  the requested fence, reported as completed/interrupted rather than failed. */
  interrupted: boolean
  handle: HeadlessTurnHandle
  /** Harness-minted conversation id, once the turn reports it. */
  harnessSessionId?: string
  /** The transcript tail is bound to `harnessSessionId` already. */
  bound: boolean
}

interface HeadlessDriverSession {
  sessionId: SessionId
  agentKind: AgentKind
  cwd: string
  label: string
  resume: ResumeRef | null
  bindingVersion: number
  observerGeneration: number
  turnEpoch: number
  seq: number
  log: { seq: number; event: RuntimeEvent }[]
  wakers: Set<() => void>
  watchers: Map<'coarse' | 'fine', number>
  /** Open structured permission asks for the live SDK turn, by interaction id.
   *  Only populated for claude-code `structuredPermissions` turns; every other
   *  harness never opens one. */
  interactions: Map<string, PendingInteraction>
  /** Answered interaction ids, for idempotent `answer()` (`already-answered`). */
  answered: Set<string>
  liveTurn?: LiveTurn
  /** The harness conversation id the transcript tail is bound to. Binding once
   *  per id (and re-arming only when the id changes) mirrors the legacy path:
   *  a redundant rebind per turn would restart the observation it just built. */
  boundResume?: string
  lastVerdict?:
    | { kind: 'done' }
    | { kind: 'interrupted' }
    | { kind: 'failed'; error: string; retryable: boolean }
  /** Sticky session policy (POD-4386 `SessionSpec` headless defaults);
   *  per-turn `TurnInput` values win over these at dispatch. */
  sticky: {
    model?: string
    effort?: string
    permissionMode?: string
    allowedTools?: string[]
    toolPolicy?: 'none'
    mcpConfig?: string
    executablePath?: string
    structuredPermissions?: true
  }
  ended: boolean
  disposed: boolean
}

// ---------------------------------------------------------------------------
// Capabilities
// ---------------------------------------------------------------------------

/** Whether this harness can open a structured permission ask on a headless
 *  turn. Only the Claude Agent SDK exposes a `canUseTool` callback to route;
 *  every child-process driver speaks a non-interactive CLI surface. */
function headlessSupportsStructuredPermissions(harness: string): boolean {
  return harness === 'claude-code'
}

/** Whether this harness declares a locatable harness-native transcript — the
 *  thing that makes `export()` byte-faithful. Mirrors the terminal family's
 *  `archivable` profile, derived from the same `handoffTranscript` axis. */
function headlessArchivable(harness: string): boolean {
  const manifest = harnessAdapterFor(harness as AgentKind)
  if (!manifest) return false
  return declaredValue(manifest.handoffTranscript) !== undefined
}

export function headlessCapabilities(harness?: string): DriverCapabilities {
  const permissionHarness = harness ?? 'claude-code'
  const archivableHarness = harness ?? 'claude-code'
  return {
    instrumentation: 'none',
    send: {
      readiness: { kind: 'driver-managed' },
      // One live turn per session; a second send refuses `busy` rather than
      // queueing behind it. `interrupt` carries interrupt-and-send: it fences
      // the live turn first instead of joining it.
      native: ['when-ready', 'interrupt'],
      // The turn is accepted once the harness child / durable runner is
      // dispatched; the harness's own session identity arrives on the event
      // stream (and re-arms the transcript bind) before the terminal event.
      proof: ['protocol-ack'],
      mayReturnUnverified: false,
    },
    interrupt: {
      // `interrupt()` kills the harness child / durable label and the turn's
      // rejection IS the fence. No provider round-trip confirms it.
      fenceOnProviderConfirmation: false,
    },
    interactions: headlessSupportsStructuredPermissions(permissionHarness)
      ? supported({
          kinds: ['permission'],
          source: 'sdk-callback',
          answerable: 'structured',
          atLeastOnce: false,
        })
      : unsupported(
          'only claude-code headless turns expose an SDK permission callback; structuredPermissions refuses unsupported elsewhere',
        ),
    observation: { watchLevels: ['coarse', 'fine'], cursorMaterial: 'event-seq' },
    transcript: { supported: true, value: { history: true } },
    staging: {
      supported: false,
      reason: 'headless turns carry text only; attachment refs refuse unsupported',
    },
    attach: {
      supported: false,
      reason: 'headless sessions have no terminal to attach',
    },
    lease: {
      supported: false,
      reason: 'no human terminal to take over on a headless session',
    },
    snapshot: { supported: true, value: { includesDraft: false } },
    archive: headlessArchivable(archivableHarness)
      ? supported({ formatVersion: 1, byteFaithful: true })
      : unsupported('this harness declares no handoff transcript locator'),
    resumeRefTiming: 'first-turn',
    placement: 'dedicated',
    draft: { supported: false, reason: 'headless sessions have no composer' },
    configure: {
      supported: true,
      value: { fields: ['model', 'effort', 'permissionMode'], effective: 'next-turn' },
    },
    usage: { supported: false, reason: 'headless turns report no usage accounting' },
    openUrl: { supported: false, reason: 'headless sessions open no browser surface' },
    title: { supported: false, reason: 'the driver observes no title channel' },
    accentColor: { supported: false, reason: 'headless sessions have no terminal theme' },
  }
}

// ---------------------------------------------------------------------------
// The runtime
// ---------------------------------------------------------------------------

export interface HeadlessRuntime {
  driverFor(harness: string): RuntimeDriver
  handleFor(sessionId: SessionId): AgentSessionHandle | undefined
  bindings(): readonly SessionBinding[]
  createWithId(sessionId: SessionId, spec: SessionSpec): Promise<AgentSessionHandle>
  resumeWithId(sessionId: SessionId, ref: ResumeRef, spec: SessionSpec): Promise<AgentSessionHandle>
  adopt(binding: SessionBinding): Promise<AgentSessionHandle>
  /** Release a durable turn journal on exact identity match; throws otherwise
   *  and retains. The WS ack verb for this is a filed gap — today the legacy
   *  `headlessTurnAck` frame and this method are the two callers. */
  acknowledge(identity: {
    sessionId: SessionId
    turnId: string
    requestDigest: string
    accountId: AccountId
  }): void
  clear(sessionId: SessionId): void
  dispose(): void
}

export function createHeadlessRuntime(
  host: HeadlessDriverHost,
  runners: HeadlessDriverRunners = defaultRunners,
): HeadlessRuntime {
  const sessions = new Map<SessionId, HeadlessDriverSession>()
  const handles = new Map<SessionId, AgentSessionHandle>()

  function publish(sessionId: SessionId, event: RuntimeEvent): void {
    // The one predicate every producer and the server's durable gate reads
    // (POD-2293): partial previews ride the live-only fine plane, everything
    // else the durable coarse one. A producer disagreeing with the gate strands
    // acks or restart heads, so this never grows a local second copy.
    host.send(
      isRuntimeFineEvent(event)
        ? { type: 'runtimeFineEvent', sessionId, event }
        : { type: 'runtimeEvent', sessionId, event },
    )
    // A protocol ask opens in the W2 aggregate through `runtimeInteractionAsked`;
    // the coarse stream above carries all three arms so the same driver also
    // retires it. Without this second frame the session would park on a prompt
    // no surface ever shows — the exact silence the old `unsupported` refusal
    // was fenced against.
    if (event.t === 'interaction' && event.ev.ev === 'asked') {
      host.send({ type: 'runtimeInteractionAsked', sessionId, interaction: event.ev.interaction })
    }
  }

  function emit(
    session: HeadlessDriverSession,
    body: RuntimeEventBody,
    provenance: ObservationProvenance,
    at?: string,
  ): void {
    if (session.disposed) return
    session.seq += 1
    const event = stampRuntimeEvent(body, at ?? new Date(host.now()).toISOString(), provenance, {
      cursor: driverLocalCursor(session.label, session.seq),
      observerGeneration: session.observerGeneration,
      turnEpoch: session.turnEpoch,
    })
    session.log.push({ seq: session.seq, event })
    if (session.log.length > HEADLESS_EVENT_LOG_LIMIT) {
      session.log.splice(0, session.log.length - HEADLESS_EVENT_LOG_LIMIT)
    }
    for (const wake of [...session.wakers]) wake()
    publish(session.sessionId, event)
  }

  function summarizePermissionInput(input: unknown): string | undefined {
    if (input === undefined) return undefined
    try {
      const text = typeof input === 'string' ? input : JSON.stringify(input)
      return text.length > 240 ? `${text.slice(0, 237)}...` : text
    } catch {
      return undefined
    }
  }

  /** Open one structured permission ask around the SDK's `canUseTool` callback.
   *  The interaction id IS the SDK callback's id: `answer()` routes back to
   *  `handle.answerPermission` under the same id, so no mapping table is needed
   *  and a wrong id is `unknown-interaction` rather than a misdelivered grant. */
  function openPermission(
    session: HeadlessDriverSession,
    request: HeadlessPermissionRequest,
  ): void {
    if (!session.liveTurn || session.disposed || session.ended) return
    if (session.interactions.has(request.id) || session.answered.has(request.id)) return
    const summary = summarizePermissionInput(request.input)
    const interaction: PendingInteraction = {
      id: request.id,
      sessionId: session.sessionId,
      kind: 'permission',
      payload: {
        v: 1,
        toolName: request.toolName,
        ...(summary ? { inputSummary: summary } : {}),
        canAlwaysAllow: (request.suggestions?.length ?? 0) > 0,
        ...(request.suggestions?.length ? { suggestions: request.suggestions } : {}),
      },
      askedAt: new Date(host.now()).toISOString(),
      source: 'sdk-callback',
      answerable: 'structured',
    }
    session.interactions.set(request.id, interaction)
    emit(session, { t: 'interaction', ev: { ev: 'asked', interaction } }, 'live')
  }

  /** Retire every open ask when its turn stops owning the SDK callback — an
   *  interrupt, a failure, or a teardown. The callback promise is denied
   *  host-side (the SDK child's teardown denies pending permissions), so the
   *  grant can never land late; `expired` says visibly that the question died
   *  with the turn rather than leaving the session parked on it. */
  function expireOpenPermissions(session: HeadlessDriverSession): void {
    if (session.interactions.size === 0) return
    const at = new Date(host.now()).toISOString()
    for (const id of [...session.interactions.keys()]) {
      session.interactions.delete(id)
      session.answered.add(id)
      emit(session, { t: 'interaction', ev: { ev: 'expired', id, at } }, 'live')
    }
  }

  function stateFor(session: HeadlessDriverSession): AgentRuntimeState {
    const at = new Date(host.now()).toISOString()
    if (session.ended) {
      return { phase: 'ended', since: at, nativeSubagentCount: 0 }
    }
    if (session.interactions.size > 0) {
      const first = [...session.interactions.values()][0]
      const summary =
        first?.kind === 'permission' ? first.payload.toolName : (first?.kind ?? 'permission')
      return {
        phase: 'needs_user',
        since: at,
        nativeSubagentCount: 0,
        need: {
          kind: 'permission',
          summary,
          ...(first?.kind === 'permission' && first.payload.inputSummary
            ? { ask: { toolName: first.payload.toolName, detail: first.payload.inputSummary } }
            : {}),
        },
      }
    }
    if (session.liveTurn) {
      return { phase: 'working', since: session.liveTurn.startedAt, nativeSubagentCount: 0 }
    }
    const verdict = session.lastVerdict
    if (verdict?.kind === 'failed') {
      return {
        phase: 'errored',
        since: at,
        nativeSubagentCount: 0,
        error: { class: 'provider-error', retryable: verdict.retryable, detail: verdict.error },
      }
    }
    return {
      phase: 'idle',
      since: at,
      nativeSubagentCount: 0,
      idle: { kind: verdict?.kind === 'interrupted' ? 'interrupted' : 'done' },
    }
  }

  function bindingFor(session: HeadlessDriverSession): SessionBinding {
    return {
      sessionId: session.sessionId,
      driver: HEADLESS_DRIVER_ID,
      family: 'server',
      harness: session.agentKind,
      workdir: session.cwd,
      resume: session.resume,
      process: { key: session.label },
      bindingVersion: session.bindingVersion,
    }
  }

  /** Bind the transcript tail the first time a harness id is known — the
   *  conversation exists under that id from now on, and rebinding on success
   *  AND on failure is what keeps an errored turn from orphaning its thread
   *  (legacy `wireTurnResult` does exactly this). Best-effort: a later
   *  resume/adopt rebind retries. */
  function bindTranscript(session: HeadlessDriverSession, harnessSessionId: string): void {
    if (session.boundResume === harnessSessionId) return
    const live = session.liveTurn
    if (live) {
      live.harnessSessionId = harnessSessionId
      live.bound = true
    }
    session.resume = {
      kind: harnessAdapterFor(session.agentKind)?.resumeKind ?? 'headless-session',
      value: harnessSessionId,
    }
    try {
      host.bindHeadlessSession(session.sessionId, session.agentKind, session.cwd, harnessSessionId)
      session.boundResume = harnessSessionId
    } catch (error) {
      if (live) live.bound = false
      log.warn('headless transcript bind failed; a later rebind retries', {
        err: error,
        sessionId: session.sessionId,
      })
    }
  }

  function finishLiveTurn(
    session: HeadlessDriverSession,
    live: LiveTurn,
    outcome: { harnessSessionId?: string; error?: string },
  ): void {
    // An interrupt-and-send supersedes the fenced turn before its rejection
    // lands: the terminal event for the old epoch must still reach whoever is
    // waiting on it (epoch-fenced, so nobody else can mistake it for theirs).
    // Only the CURRENT turn may move the session's own state.
    const current = session.liveTurn === live
    if (current) session.liveTurn = undefined
    // The SDK callback died with the turn: retire any ask it opened before the
    // terminal event, so the session never parks on a question nobody can answer.
    // Only the current turn owns the callback; a superseded epoch's late
    // rejection must not expire the replacement turn's fresh ask.
    if (current) expireOpenPermissions(session)
    if (outcome.harnessSessionId) bindTranscript(session, outcome.harnessSessionId)
    if (outcome.error === undefined) {
      if (current) session.lastVerdict = { kind: 'done' }
      emit(
        session,
        { t: 'turn', ev: { ev: 'completed', turnEpoch: live.turnEpoch, verdict: 'done' } },
        'live',
      )
      return
    }
    if (live.interrupted || outcome.error === 'turn interrupted') {
      if (current) session.lastVerdict = { kind: 'interrupted' }
      emit(
        session,
        { t: 'turn', ev: { ev: 'completed', turnEpoch: live.turnEpoch, verdict: 'interrupted' } },
        'live',
      )
      return
    }
    const timedOut = /timed out/i.test(outcome.error)
    if (current) session.lastVerdict = { kind: 'failed', error: outcome.error, retryable: timedOut }
    emit(
      session,
      {
        t: 'turn',
        ev: {
          ev: 'failed',
          turnEpoch: live.turnEpoch,
          reason: timedOut ? 'timeout' : 'provider-error',
          disposition: timedOut ? 'retryable' : 'fatal',
          detail: outcome.error,
        },
      },
      'live',
    )
  }

  /** Translate one legacy turn event into contract preview state. `partial-text`
   *  is cumulative per assistant message, so each emission replaces the
   *  turn-scoped preview fragment; `status` carries the harness session id that
   *  arms the transcript bind. Terminal results never flow through here — the
   *  tail owns them. */
  function onTurnEvent(
    session: HeadlessDriverSession,
    live: LiveTurn,
    event: HeadlessTurnEvent,
  ): void {
    if (session.liveTurn !== live || session.disposed) return
    if (event.kind === 'partial-text') {
      emit(
        session,
        {
          t: 'item',
          item: {
            kind: 'partial',
            item: {
              id: `headless:${live.turnId}:${event.itemHint ?? 'text'}`,
              role: 'assistant',
              text: event.text,
              ts: new Date(host.now()).toISOString(),
            },
          },
        },
        'live',
      )
      return
    }
    if (event.harnessSessionId) bindTranscript(session, event.harnessSessionId)
  }

  function headlessNoTools(agent: string): 'enforced' | 'unsupported' {
    const manifest = harnessAdapterFor(agent as AgentKind)
    if (!manifest) {
      throw new DriverRefusalError(
        { reason: 'invalid_value', detail: `no harness manifest for '${agent}'` },
        'headless send',
      )
    }
    const headless = declaredValue(manifest.headless)
    if (!headless) {
      throw new DriverRefusalError(
        { reason: 'unsupported', detail: `harness '${agent}' declares headless unsupported` },
        'headless send',
      )
    }
    return headless.noTools
  }

  /** The digest the server minted must recompute here over the SAME
   *  turn-carried facts — prompt, per-turn policy, conversation ids and durable
   *  identity — and refuse on mismatch BEFORE anything spawns. Session-sticky
   *  defaults are session identity, not turn identity: they resolve for
   *  execution below but are deliberately excluded from the digest, exactly as
   *  `canonicalHeadlessContractFacts` defines it. */
  function verifyDigest(input: TurnInput, turnId: string, sessionId: SessionId): string {
    const accountId = input.accountId
    const requestDigest = input.requestDigest
    if (!turnId || !requestDigest || !accountId) {
      throw new DriverRefusalError(
        {
          reason: 'invalid_value',
          detail: 'headless turn requires TurnInput.id, requestDigest and accountId',
        },
        'headless send',
      )
    }
    const model = input.overrides?.supported === true ? input.overrides.value.model : undefined
    const effort = input.overrides?.supported === true ? input.overrides.value.effort : undefined
    const actual = createHash('sha256')
      .update(
        canonicalHeadlessContractFacts({
          prompt: input.text,
          ...(model !== undefined ? { model } : {}),
          ...(effort !== undefined ? { effort } : {}),
          ...(input.allowedTools !== undefined ? { allowedTools: [...input.allowedTools] } : {}),
          ...(input.permissionMode !== undefined ? { permissionMode: input.permissionMode } : {}),
          ...(input.toolPolicy !== undefined ? { toolPolicy: input.toolPolicy } : {}),
          ...(input.mcpConfig !== undefined ? { mcpConfig: input.mcpConfig } : {}),
          ...(input.resumeValue !== undefined ? { resumeValue: input.resumeValue } : {}),
          ...(input.sessionUuid !== undefined ? { sessionUuid: input.sessionUuid } : {}),
          ...(input.structuredPermissions !== undefined
            ? { structuredPermissions: input.structuredPermissions }
            : {}),
          turnId,
          sessionId,
          accountId,
        }),
      )
      .digest('hex')
    if (actual !== requestDigest) {
      throw new DriverRefusalError(
        { reason: 'invalid_value', detail: 'headless request digest mismatch' },
        'headless send',
      )
    }
    return accountId
  }

  /** Resolve turn-carried values over session-sticky defaults (turn wins,
   *  absent-means-absent) into the exact spec the legacy path builds. Per-turn
   *  `contextPrompt` and `timeoutMs` have no contract carriers (filed gap):
   *  sticky instructions ride `systemPrompt`, and the turn budget stays the
   *  runner default. */
  function buildTurnSpec(
    session: HeadlessDriverSession,
    input: TurnInput,
    identity: { accountId: AccountId; toolPolicy: 'none' | undefined },
    snapshot: ResolvedHarnessInventory,
  ): HeadlessTurnSpec {
    const agent = session.agentKind as HarnessAgent
    const overridesModel =
      input.overrides?.supported === true ? input.overrides.value.model : undefined
    const overridesEffort =
      input.overrides?.supported === true ? input.overrides.value.effort : undefined
    const instructions = undefined
    void instructions
    return {
      agent,
      accountId: identity.accountId,
      requestDigest: input.requestDigest ?? '',
      cwd: session.cwd,
      prompt: input.text,
      ...(session.sticky.executablePath !== undefined
        ? { executablePath: session.sticky.executablePath }
        : {}),
      ...((overridesModel ?? session.sticky.model) !== undefined
        ? { model: (overridesModel ?? session.sticky.model) as string }
        : {}),
      ...((overridesEffort ?? session.sticky.effort) !== undefined
        ? { effort: (overridesEffort ?? session.sticky.effort) as string }
        : {}),
      ...((input.allowedTools ?? session.sticky.allowedTools) !== undefined
        ? { allowedTools: (input.allowedTools ?? session.sticky.allowedTools) as string[] }
        : {}),
      ...((input.permissionMode ?? session.sticky.permissionMode) !== undefined
        ? { permissionMode: (input.permissionMode ?? session.sticky.permissionMode) as string }
        : {}),
      ...(identity.toolPolicy !== undefined ? { toolPolicy: identity.toolPolicy } : {}),
      ...((input.mcpConfig ?? session.sticky.mcpConfig) !== undefined
        ? { mcpConfig: (input.mcpConfig ?? session.sticky.mcpConfig) as string }
        : {}),
      ...((input.resumeValue ?? session.resume?.value) !== undefined
        ? { resumeValue: (input.resumeValue ?? session.resume?.value) as string }
        : {}),
      ...(input.sessionUuid !== undefined ? { sessionUuid: input.sessionUuid } : {}),
      ...((input.structuredPermissions ?? session.sticky.structuredPermissions) !== undefined
        ? {
            structuredPermissions: (input.structuredPermissions ??
              session.sticky.structuredPermissions) as true,
          }
        : {}),
      env: host.sessionEnv({
        sessionId: session.sessionId,
        agent,
        toolPolicyNone: identity.toolPolicy === 'none',
        snapshot,
      }),
      durableLabel: session.label,
    }
  }

  async function send(
    session: HeadlessDriverSession,
    input: TurnInput,
    options: SendOptions,
  ): Promise<TurnReceipt> {
    const at = new Date(host.now()).toISOString()
    if (session.disposed || session.ended) {
      return { outcome: 'refused', refusal: refuse('not_running', 'headless session has ended') }
    }
    // No daemon-held queue, no steer verb, no boundary continuation: refusing
    // is the honest answer, and `at-boundary` MUST refuse rather than degrade.
    if (
      options.delivery === 'steer' ||
      options.delivery === 'at-boundary' ||
      options.delivery === 'queue'
    ) {
      return {
        outcome: 'refused',
        refusal: refuse(
          'unsupported',
          `headless turns do not implement '${options.delivery}' delivery`,
        ),
      }
    }
    if (input.attachments !== undefined && input.attachments.length > 0) {
      return {
        outcome: 'refused',
        refusal: refuse('unsupported', 'headless turns carry text only'),
      }
    }
    const structured =
      (input.structuredPermissions ?? session.sticky.structuredPermissions) === true
    if (structured && !headlessSupportsStructuredPermissions(session.agentKind)) {
      return {
        outcome: 'refused',
        refusal: refuse(
          'unsupported',
          `structuredPermissions needs an SDK permission callback; harness '${session.agentKind}' has none`,
        ),
      }
    }
    const turnId = input.id ?? ''
    let accountId: string
    try {
      accountId = verifyDigest(input, turnId, session.sessionId)
    } catch (error) {
      if (error instanceof DriverRefusalError) return { outcome: 'refused', refusal: error.refusal }
      throw error
    }

    const agent = session.agentKind as HarnessAgent
    const toolPolicy = input.toolPolicy ?? session.sticky.toolPolicy
    // One snapshot per send, shared by the account fence and the dispatch
    // below — the check cannot pass on a login the launch does not see, and a
    // refused send pays no inventory read at all (digest first, snapshot after).
    let snapshot: ResolvedHarnessInventory
    try {
      snapshot = await host.snapshot()
    } catch (error) {
      return {
        outcome: 'refused',
        refusal: refuse('not_running', error instanceof Error ? error.message : String(error)),
      }
    }
    if (toolPolicy === 'none') {
      // Fail closed before anything spawns: the harness must own a tested
      // all-tools-off mode AND the turn must carry the exact native login the
      // server selected, verified against the live inventory at dispatch.
      let noTools: 'enforced' | 'unsupported'
      try {
        noTools = headlessNoTools(session.agentKind)
      } catch (error) {
        if (error instanceof DriverRefusalError) {
          return { outcome: 'refused', refusal: error.refusal }
        }
        throw error
      }
      if (noTools !== 'enforced') {
        return {
          outcome: 'refused',
          refusal: refuse(
            'invalid_value',
            `harness ${session.agentKind} cannot enforce a no-tools headless turn`,
          ),
        }
      }
      try {
        host.assertNativeAccount(agent, asAccountId(accountId), snapshot.inventory)
      } catch (error) {
        return {
          outcome: 'refused',
          refusal: refuse('invalid_value', error instanceof Error ? error.message : String(error)),
        }
      }
    }

    const live = session.liveTurn
    if (live) {
      // Reconnect replay of the exact same turn re-arms the same epoch without
      // a rerun — even while a permission ask is open, where the reconnect is
      // rejoining the wait rather than piling on; a same-turnId collision with
      // different identity refuses outright (never a reuse); anything else
      // while a turn is open is a collision, never a queue — except an explicit
      // interrupt delivery, which fences the live turn first (interrupt-and-send).
      if (live.turnId === turnId) {
        if (live.requestDigest === input.requestDigest && live.accountId === accountId) {
          return {
            outcome: 'accepted',
            turnEpoch: live.turnEpoch,
            deliveredAs: live.deliveredAs,
            provenBy: 'protocol-ack',
            at,
          }
        }
        return {
          outcome: 'refused',
          refusal: refuse('invalid_value', 'running headless turn identity mismatch'),
        }
      }
      if (options.delivery !== 'interrupt') {
        // An open permission blocks the next write until it is answered — the
        // same `needs_user` fence every other driver honours. Without it a
        // second send would pile a new turn onto a model that is still waiting
        // for a verdict on the last tool call. A running turn with no open ask
        // is plain `busy`.
        if (session.interactions.size > 0) {
          return {
            outcome: 'refused',
            refusal: refuse('needs_user', 'a permission ask is waiting for an answer'),
          }
        }
        return { outcome: 'refused', refusal: refuse('busy', 'turn already running') }
      }
      live.interrupted = true
      try {
        await live.handle.interrupt()
      } catch {
        // Fencing is best-effort; the old turn's rejection still reports it.
      }
    }

    // Defensive: the turn fence above expires open asks with the turn, so an
    // ask with no live turn is an orphan that must never be silently orphaned
    // further by dispatching over it.
    if (session.interactions.size > 0) {
      return {
        outcome: 'refused',
        refusal: refuse('needs_user', 'a permission ask is waiting for an answer'),
      }
    }

    const turnEpoch = session.turnEpoch + 1
    session.turnEpoch = turnEpoch
    const startedAt = new Date(host.now()).toISOString()
    emit(
      session,
      { t: 'turn', ev: { ev: 'started', turnEpoch, origin: options.origin } },
      'live',
      startedAt,
    )

    const spec = buildTurnSpec(
      session,
      input,
      {
        accountId: asAccountId(accountId),
        toolPolicy,
      },
      snapshot,
    )
    let handle: HeadlessTurnHandle
    try {
      const durable = structured ? undefined : host.durable()
      const emitFn: HeadlessEmit = (event) => {
        const current = session.liveTurn
        if (current && current.turnEpoch === turnEpoch) onTurnEvent(session, current, event)
      }
      // A structured turn needs the SDK's live `canUseTool` callback, which the
      // durable CLI runner cannot offer — it speaks the non-interactive `claude
      // -p` surface. So structured turns bypass the durable journal and run as
      // in-process SDK turns, with the same digest fence and transcript bind
      // but no cross-restart replay. The bypass is deliberate and visible: the
      // capability declares the permission channel, and the receipt still proves
      // `protocol-ack`.
      const hooks: HeadlessRunnerHooks | undefined = structured
        ? {
            onPermission: (request) => {
              const current = session.liveTurn
              if (current && current.turnEpoch === turnEpoch) openPermission(session, request)
            },
          }
        : undefined
      handle =
        durable !== undefined
          ? runners.runDurableTurn(turnId, session.sessionId, spec, emitFn, snapshot, durable)
          : runners.runTurn(spec, emitFn, snapshot, hooks)
    } catch (error) {
      // Dispatch itself failed (no spawn, no journal beyond the durable
      // identity the durable runner owns exactly as the legacy path does):
      // rewind the epoch the failed dispatch claimed so the next send keeps
      // the stream's numbering dense, and report what is true — nothing ran.
      session.turnEpoch = turnEpoch - 1
      return {
        outcome: 'refused',
        refusal: refuse('not_running', error instanceof Error ? error.message : String(error)),
      }
    }

    const next: LiveTurn = {
      turnId,
      ...(input.rowId !== undefined ? { rowId: input.rowId } : {}),
      requestDigest: input.requestDigest ?? '',
      accountId,
      turnEpoch,
      deliveredAs: options.delivery,
      startedAt,
      interrupted: false,
      handle,
      bound: false,
    }
    session.liveTurn = next
    // A first-turn server-minted UUID binds the transcript tail before the
    // harness reports anything (legacy `bindFirstTurn(msg.sessionUuid)`).
    if (!input.resumeValue && input.sessionUuid) bindTranscript(session, input.sessionUuid)
    void handle.done.then(
      (outcome) => finishLiveTurn(session, next, outcome),
      (error: unknown) => {
        const harnessSessionId =
          error instanceof HeadlessTurnError ? error.harnessSessionId : undefined
        finishLiveTurn(session, next, {
          ...(harnessSessionId !== undefined ? { harnessSessionId } : {}),
          error: error instanceof Error ? error.message : String(error),
        })
      },
    )
    return {
      outcome: 'accepted',
      turnEpoch,
      deliveredAs: options.delivery,
      provenBy: 'protocol-ack',
      at,
    }
  }

  function endSession(session: HeadlessDriverSession, killed: boolean): void {
    if (session.ended) return
    expireOpenPermissions(session)
    const live = session.liveTurn
    if (live) {
      // No interrupted flag: the live record is dropped first, so the turn's
      // late rejection is ignored rather than fenced — the process exit below
      // is the session's terminal event, and a fence for a dead session would
      // have nobody waiting on it.
      try {
        live.handle.interrupt()
      } catch {
        // Teardown is best-effort.
      }
      session.liveTurn = undefined
    }
    session.ended = true
    emit(
      session,
      {
        t: 'process',
        ev: {
          ev: 'exited',
          code: null,
          signal: null,
          classification: live && killed ? 'killed' : 'clean',
        },
      },
      'live',
    )
    // The stream ends here: no further turn can open, and a reader holding
    // `events()` must terminate instead of hanging on a dead session.
    session.disposed = true
    for (const wake of [...session.wakers]) wake()
  }

  function makeHandle(session: HeadlessDriverSession): AgentSessionHandle {
    return {
      // A getter, not a snapshot: resume/adopt bump the binding behind this
      // handle, and a stale copy would answer the old generation forever.
      get binding(): SessionBinding {
        return bindingFor(session)
      },
      async stop(): Promise<void> {
        endSession(session, false)
      },
      async hibernate(): Promise<Refusal | { ok: true }> {
        if (!session.resume) return refuse('no_resume_ref', 'hibernating would lose the session')
        if (session.interactions.size > 0)
          return refuse('needs_user', 'a permission ask is waiting for an answer')
        if (session.liveTurn) return refuse('busy', 'a turn is running')
        // Between turns a headless session holds no process: the harness owns
        // the conversation on disk and the durable journal (where there is one)
        // survives the handle either way.
        return { ok: true }
      },
      async kill(): Promise<void> {
        endSession(session, true)
      },
      async health(): Promise<SessionHealth> {
        return { alive: !session.ended && !session.disposed, oomEvents: 0 }
      },
      async snapshot(): Promise<SessionSnapshot> {
        return {
          binding: bindingFor(session),
          state: stateFor(session),
          cursor: driverLocalCursor(session.label, session.seq),
          observerGeneration: session.observerGeneration,
          turnEpoch: session.turnEpoch,
          interactions: [...session.interactions.values()],
          at: new Date(host.now()).toISOString(),
        }
      },
      async export(): Promise<SessionArchive> {
        // THE DECLARATION IS CHECKED FIRST, same order as the terminal driver:
        // "no locator" is permanent (`unsupported`, never retry), "not written
        // yet" is `no_resume_ref` (retry after a turn). Reporting `no_resume_ref`
        // for a harness that will never have an archive sends a scheduler round
        // a loop it cannot leave.
        if (!headlessArchivable(session.agentKind)) {
          throw new DriverRefusalError(
            {
              reason: 'unsupported',
              detail: `${session.agentKind} declares no handoff transcript locator`,
            },
            'headless export',
          )
        }
        if (!session.resume) {
          throw new DriverRefusalError({ reason: 'no_resume_ref' }, 'headless export')
        }
        const located = await host.archiveTranscript({
          agentKind: session.agentKind,
          cwd: session.cwd,
          resumeValue: session.resume.value,
        })
        const bytes = await host.readFileBytes(located.path)
        const name = located.path.split('/').pop() ?? `${session.sessionId}.jsonl`
        return {
          harness: session.agentKind,
          formatVersion: 1,
          resume: session.resume,
          files: [
            {
              // ARCHIVE-RELATIVE. An absolute path is a promise about the
              // DESTINATION machine that the source machine cannot make.
              path: located.relativeDir ? `${located.relativeDir}/${name}` : name,
              bytes,
            },
          ],
          binding: {
            sessionId: session.sessionId,
            driver: HEADLESS_DRIVER_ID,
            family: 'server',
            harness: session.agentKind,
            workdir: session.cwd,
            resume: session.resume,
          },
        }
      },
      send: (input, options) => send(session, input, options),
      async cancelDelivery(rowId: string): Promise<Refusal | { ok: true }> {
        const live = session.liveTurn
        if (!live || live.rowId !== rowId) {
          return refuse('not_running', 'no live delivery for this row')
        }
        live.interrupted = true
        try {
          await live.handle.interrupt()
        } catch {
          // Best-effort; the rejection fences the turn.
        }
        return { ok: true }
      },
      async stageAttachment(): Promise<AttachmentStageResult> {
        return refuse('unsupported', 'headless turns carry text only')
      },
      async interrupt(): Promise<void> {
        const live = session.liveTurn
        if (!live) return
        live.interrupted = true
        try {
          await live.handle.interrupt()
        } catch {
          // The turn's rejection is the fence; a throw here would report a
          // request failure that never happened.
        }
      },
      async answer(
        interactionId: string,
        answer: unknown,
        options?: { principal?: { kind: 'user' | 'agent' | 'system'; ref: string } },
      ): Promise<InteractionAnswerOutcome> {
        if (session.answered.has(interactionId)) return { ok: false, reason: 'already-answered' }
        const interaction = session.interactions.get(interactionId)
        if (!interaction) return { ok: false, reason: 'unknown-interaction' }
        if (interaction.kind !== 'permission') {
          return {
            ok: false,
            reason: 'not-yet-supported',
            detail: `headless turns open only permission asks; cannot answer '${interaction.kind}'`,
          }
        }
        const raw =
          typeof answer === 'object' && answer !== null ? (answer as Record<string, unknown>) : {}
        // Accept the UI's shorthand `allow` as `allow-once`; the contract's
        // `PermissionAnswer` is the same shape the embedded SDK driver parses.
        const decision = raw.decision
        const candidate =
          decision === 'allow'
            ? { ...raw, kind: 'permission', decision: 'allow-once' }
            : decision === 'allow-once' || decision === 'allow-always' || decision === 'deny'
              ? { ...raw, kind: 'permission' }
              : answer
        const parsed = PermissionAnswer.safeParse(candidate)
        if (!parsed.success) {
          return { ok: false, reason: 'not-yet-supported', detail: parsed.error.message }
        }
        if (parsed.data.decision === 'allow-always' && !interaction.payload.canAlwaysAllow) {
          return {
            ok: false,
            reason: 'not-yet-supported',
            detail: 'provider offered no persistent permission rule',
          }
        }
        const live = session.liveTurn
        if (!live?.handle.answerPermission) {
          return {
            ok: false,
            reason: 'delivery-failed',
            detail: 'the SDK turn no longer owns this interaction',
          }
        }
        try {
          await live.handle.answerPermission(interactionId, {
            decision:
              parsed.data.decision === 'allow-once'
                ? 'allow-once'
                : parsed.data.decision === 'allow-always'
                  ? 'allow-always'
                  : 'deny',
            ...(parsed.data.feedback ? { feedback: parsed.data.feedback } : {}),
          })
        } catch (error) {
          return {
            ok: false,
            reason: 'delivery-failed',
            detail: error instanceof Error ? error.message : String(error),
          }
        }
        session.interactions.delete(interactionId)
        session.answered.add(interactionId)
        emit(
          session,
          {
            t: 'interaction',
            ev: {
              ev: 'answered',
              id: interactionId,
              answeredBy: options?.principal?.kind === 'agent' ? 'superagent' : 'human',
              at: new Date(host.now()).toISOString(),
            },
          },
          'live',
        )
        return { ok: true }
      },
      async interactions(): Promise<readonly PendingInteraction[]> {
        return [...session.interactions.values()]
      },
      events(after: EventStreamStart): AsyncIterable<RuntimeEvent> {
        return createRuntimeEventStream(after, {
          get log() {
            return session.log
          },
          get wakers() {
            return session.wakers
          },
          currentSeq: () => session.seq,
          isDisposed: () => session.disposed,
        })
      },
      async watch(level: 'coarse' | 'fine'): Promise<() => void> {
        session.watchers.set(level, (session.watchers.get(level) ?? 0) + 1)
        let released = false
        return () => {
          if (released) return
          released = true
          const count = (session.watchers.get(level) ?? 1) - 1
          if (count <= 0) session.watchers.delete(level)
          else session.watchers.set(level, count)
        }
      },
      async state(): Promise<AgentRuntimeState> {
        return stateFor(session)
      },
      transcript: {
        history: (
          range: Omit<RuntimeHistoryRange, 'direction'> & {
            direction?: RuntimeHistoryRange['direction']
          },
        ): Promise<RuntimeHistoryPage> =>
          host.readHistory(
            {
              sessionId: session.sessionId,
              agentKind: session.agentKind,
              cwd: session.cwd,
              ...(session.resume ? { resume: session.resume } : {}),
            },
            range,
          ),
      },
      async attach(): Promise<AttachEndpoint | Refusal> {
        return refuse('unsupported', 'headless sessions have no terminal to attach')
      },
      lease: {
        async acquire(): Promise<SessionLease | Refusal> {
          return refuse('unsupported', 'no human terminal to take over on a headless session')
        },
        async release(): Promise<void> {},
        async state(): Promise<SessionLease | null> {
          return null
        },
      },
      draft: {
        async get(): Promise<string | Refusal> {
          return refuse('unsupported', 'headless sessions have no composer')
        },
        async set(): Promise<Refusal | { ok: true }> {
          return refuse('unsupported', 'headless sessions have no composer')
        },
      },
      async configure(request: ConfigureRequest): Promise<Refusal | { ok: true }> {
        if (session.disposed || session.ended) return refuse('not_running', 'session has ended')
        // Sticky for the session, effective from the next turn: every headless
        // request carries the session's policy, so the change provably cannot
        // reach inside an open turn (capability says `next-turn` for the same
        // reason).
        if (request.model !== undefined) session.sticky.model = request.model
        if (request.effort !== undefined) session.sticky.effort = request.effort
        if (request.permissionMode !== undefined) {
          session.sticky.permissionMode = request.permissionMode
        }
        return { ok: true }
      },
      async usage(): Promise<UsageSnapshot | Refusal> {
        return refuse('unsupported', 'headless turns report no usage accounting')
      },
    }
  }

  function register(session: HeadlessDriverSession): AgentSessionHandle {
    sessions.set(session.sessionId, session)
    const handle = makeHandle(session)
    handles.set(session.sessionId, handle)
    return handle
  }

  function openSession(
    sessionId: SessionId,
    spec: SessionSpec,
    resume: ResumeRef | null,
  ): HeadlessDriverSession {
    const agentKind = spec.harness as AgentKind
    // Fail fast on a harness this build cannot drive headlessly — creating a
    // session that can never turn is worse than refusing.
    headlessNoTools(spec.harness)
    if (spec.structuredPermissions !== undefined && !headlessSupportsStructuredPermissions(spec.harness)) {
      throw new DriverRefusalError(
        {
          reason: 'unsupported',
          detail: `structuredPermissions needs an SDK permission callback; harness '${spec.harness}' has none`,
        },
        'headless create',
      )
    }
    if (spec.initialPrompt !== undefined) {
      throw new DriverRefusalError(
        {
          reason: 'unsupported',
          detail: 'headless sessions take their first prompt as a turn, not at creation',
        },
        'headless create',
      )
    }
    return {
      sessionId,
      agentKind,
      cwd: spec.workdir,
      label: spec.durableLabel ?? host.durableLabel(sessionId),
      resume,
      bindingVersion: 1,
      observerGeneration: 1,
      turnEpoch: 0,
      seq: 0,
      log: [],
      wakers: new Set(),
      watchers: new Map(),
      interactions: new Map(),
      answered: new Set(),
      sticky: {
        ...(spec.model.model !== undefined ? { model: spec.model.model } : {}),
        ...(spec.model.effort !== undefined ? { effort: spec.model.effort } : {}),
        ...(spec.permissionMode !== undefined ? { permissionMode: spec.permissionMode } : {}),
        ...(spec.allowedTools !== undefined ? { allowedTools: [...spec.allowedTools] } : {}),
        ...(spec.toolPolicy !== undefined ? { toolPolicy: spec.toolPolicy } : {}),
        ...(spec.mcpServers.supported === true && spec.mcpServers.value.transport === 'inline'
          ? { mcpConfig: spec.mcpServers.value.config }
          : {}),
        ...(spec.executablePath !== undefined ? { executablePath: spec.executablePath } : {}),
        ...(spec.structuredPermissions !== undefined
          ? { structuredPermissions: spec.structuredPermissions }
          : {}),
      },
      ended: false,
      disposed: false,
    }
  }

  async function createWithId(sessionId: SessionId, spec: SessionSpec): Promise<AgentSessionHandle> {
    if (sessions.has(sessionId)) {
      throw new DriverRefusalError(
        { reason: 'invalid_value', detail: `headless session '${sessionId}' already exists` },
        'headless create',
      )
    }
    const session = openSession(sessionId, spec, null)
    const handle = register(session)
    emit(
      session,
      {
        t: 'state',
        change: { kind: 'state_snapshot', state: stateFor(session), at: new Date(host.now()).toISOString() },
      },
      'bootstrap',
    )
    return handle
  }

  async function resumeWithId(
    sessionId: SessionId,
    ref: ResumeRef,
    spec: SessionSpec,
  ): Promise<AgentSessionHandle> {
    const existing = sessions.get(sessionId)
    if (existing && !existing.disposed && !existing.ended) {
      existing.resume = ref
      existing.bindingVersion += 1
      existing.observerGeneration += 1
      try {
        host.bindHeadlessSession(sessionId, existing.agentKind, existing.cwd, ref.value)
        existing.boundResume = ref.value
      } catch (error) {
        log.warn('headless resume rebind failed', { err: error, sessionId })
      }
      const handle = handles.get(sessionId)
      if (!handle) throw new Error(`headless session '${sessionId}' lost its handle`)
      return handle
    }
    const session = openSession(sessionId, spec, ref)
    const handle = register(session)
    try {
      host.bindHeadlessSession(sessionId, session.agentKind, session.cwd, ref.value)
      session.boundResume = ref.value
    } catch (error) {
      log.warn('headless resume bind failed', { err: error, sessionId })
    }
    emit(
      session,
      {
        t: 'state',
        change: { kind: 'state_snapshot', state: stateFor(session), at: new Date(host.now()).toISOString() },
      },
      'bootstrap',
    )
    return handle
  }

  /** Rebind a SURVIVING session after a supervisor restart. Matches on the
   *  exact durable label — a prefix or heuristic match here adopts the wrong
   *  process, which is worse than not adopting at all. Turn-level recovery
   *  needs no handle work: the next send with the same turn identity reattaches
   *  to the running durable turn (or replays its journal) inside
   *  `runDurableHeadlessTurn`, preserving the original deadline. */
  async function adoptBinding(binding: SessionBinding): Promise<AgentSessionHandle> {
    if (binding.driver !== HEADLESS_DRIVER_ID) {
      throw new DriverRefusalError(
        {
          reason: 'invalid_value',
          detail: `headless adopt cannot take a '${binding.driver}' binding`,
        },
        'headless adopt',
      )
    }
    const expected = host.durableLabel(binding.sessionId)
    if (binding.process.key !== expected) {
      throw new DriverRefusalError(
        { reason: 'not_running', detail: 'exact process identity mismatch; refusing adopt' },
        'headless adopt',
      )
    }
    const existing = sessions.get(binding.sessionId)
    if (existing && !existing.disposed) {
      existing.bindingVersion += 1
      existing.observerGeneration += 1
      if (binding.resume) {
        existing.resume = binding.resume
        try {
          host.bindHeadlessSession(
            existing.sessionId,
            existing.agentKind,
            existing.cwd,
            binding.resume.value,
          )
          existing.boundResume = binding.resume.value
        } catch (error) {
          log.warn('headless adopt rebind failed', { err: error, sessionId: existing.sessionId })
        }
      }
      emit(
        existing,
        { t: 'process', ev: { ev: 'adopted', bindingVersion: existing.bindingVersion } },
        'bootstrap',
      )
      const handle = handles.get(binding.sessionId)
      if (!handle) throw new Error(`headless session '${binding.sessionId}' lost its handle`)
      return handle
    }
    // A restart dropped the record but the label (and the harness conversation
    // behind the resume ref) survived: re-index the session so the next send
    // for the running turn finds it instead of minting a duplicate.
    const agentKind = binding.harness as AgentKind
    headlessNoTools(binding.harness)
    const session: HeadlessDriverSession = {
      sessionId: binding.sessionId,
      agentKind,
      cwd: binding.workdir,
      label: expected,
      resume: binding.resume,
      bindingVersion: binding.bindingVersion + 1,
      observerGeneration: 1,
      turnEpoch: 0,
      seq: 0,
      log: [],
      wakers: new Set(),
      watchers: new Map(),
      interactions: new Map(),
      answered: new Set(),
      sticky: {},
      ended: false,
      disposed: false,
    }
    const handle = register(session)
    if (binding.resume) {
      try {
        host.bindHeadlessSession(session.sessionId, agentKind, session.cwd, binding.resume.value)
        session.boundResume = binding.resume.value
      } catch (error) {
        log.warn('headless adopt rebind failed', { err: error, sessionId: session.sessionId })
      }
    }
    emit(
      session,
      { t: 'process', ev: { ev: 'adopted', bindingVersion: session.bindingVersion } },
      'bootstrap',
    )
    return handle
  }

  function driverFor(harness: string): RuntimeDriver {
    // Partial on purpose: the generic one-shot cannot mint headless durable
    // identity (no digest, no turnId), so it would only refuse at the send —
    // the askAndAwait override below is the procedure this driver offers.
    const procedures: Partial<DriverProcedureOverrides> = {
      // The generic composition cannot name a headless turn: the durable
      // identity rides `TurnInput.id` on the wire, so the override carries it
      // into the procedure that owns the journal and the deadline, and returns
      // only the terminal event the override contract promises.
      askAndAwait: (handle, input, options) => {
        const turnId = input.id
        if (!turnId)
          return Promise.reject(new Error('headless askAndAwait requires TurnInput.id turn identity'))
        return headlessAskAndAwait(handle, input, { ...options, turnId }).then(
          (outcome) => outcome.terminal,
        )
      },
    }
    return {
      id: HEADLESS_DRIVER_ID,
      harness,
      family: 'server',
      // Per-harness: claude-code opens structured permission asks and (like
      // codex) ships a locatable native transcript; other harnesses declare
      // both gaps as `unsupported` rather than a silent absence.
      capabilities: () => headlessCapabilities(harness),
      create: (spec) => createWithId(asSessionId(randomUUID()), spec),
      resume: (ref, spec) => resumeWithId(asSessionId(randomUUID()), ref, spec),
      adopt: (binding) => adoptBinding(binding),
      procedures,
    }
  }

  return {
    driverFor,
    handleFor: (sessionId) => handles.get(sessionId),
    bindings: () => [...sessions.values()].map(bindingFor),
    createWithId,
    resumeWithId,
    adopt: adoptBinding,
    acknowledge: (identity) => {
      acknowledgeDurableHeadlessTurn({
        sessionId: identity.sessionId,
        turnId: identity.turnId,
        accountId: identity.accountId,
        requestDigest: identity.requestDigest,
      })
    },
    clear: (sessionId) => {
      const session = sessions.get(sessionId)
      if (session) {
        session.disposed = true
        for (const wake of [...session.wakers]) wake()
      }
      sessions.delete(sessionId)
      handles.delete(sessionId)
    },
    dispose: () => {
      for (const session of sessions.values()) {
        session.disposed = true
        for (const wake of [...session.wakers]) wake()
      }
      sessions.clear()
      handles.clear()
    },
  }
}
