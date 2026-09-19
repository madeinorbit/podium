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
 * - No WS create/resume/adopt frame exists for headless sessions yet, so nothing
 *   in production constructs these handles today; `control/headless.ts` keeps
 *   serving the legacy port unchanged. The driver is proven by its tests, not by
 *   shadowing production.
 * - Per-turn `contextPrompt` and `timeoutMs` have no contract carriers: sticky
 *   instructions ride `systemPrompt`, and the turn budget stays the runner
 *   default. The caller-migration issue owns carrying them.
 * - `structuredPermissions: true` is REFUSED `unsupported` here. The legacy wire
 *   never carried it either, and accepting it without a permission-answer
 *   channel would silently park the turn on a prompt nobody answers.
 * - `export()` is `unsupported`: headless handoff archives stay with the
 *   transcript-archive path until a per-harness versioned form is proven.
 */

import { createHash, randomUUID } from 'node:crypto'
import {
  canonicalHeadlessContractFacts,
  type AgentSessionHandle,
  type AttachEndpoint,
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
  type HarnessAgent,
  type ResolvedHarnessInventory,
} from '@podium/harness'
import { createLogger } from '@podium/logger'
import {
  asAccountId,
  asSessionId,
  type AccountId,
  type AgentKind,
  type AgentRuntimeState,
  type ResumeRef,
  type SessionId,
} from '@podium/model'
import type { HeadlessTurnEvent, ObservationProvenance } from '@podium/protocol'
import type {
  DaemonMessage,
  RuntimeHistoryPage,
  RuntimeHistoryRange,
} from '@podium/protocol/daemon'
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
   *  Throws with the same wording `control/headless.ts` reports today. */
  assertNativeAccount(agent: HarnessAgent, accountId: AccountId): void
  /** The instance-owned child environment for one turn (HOME + relay routing +
   *  tool-less account HOME). Mirrors the `spawnEnv` composition the legacy
   *  path builds per request. */
  sessionEnv(input: {
    sessionId: SessionId
    agent: HarnessAgent
    toolPolicyNone: boolean
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
  now(): number
}

/** The turn-execution seam. Production passes the real headless functions;
 *  tests inject fakes that record specs and simulate outcomes. */
export interface HeadlessDriverRunners {
  runTurn(
    spec: HeadlessTurnSpec,
    emit: HeadlessEmit,
    snapshot: ResolvedHarnessInventory,
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
  runTurn: (spec, emit, snapshot) => runHeadlessTurn(spec, emit, snapshot),
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
  liveTurn?: LiveTurn
  /** The harness conversation id the transcript tail is bound to. Binding once
   *  per id (and re-arming only when the id changes) mirrors the legacy path:
   *  a redundant rebind per turn would restart the observation it just built. */
  boundResume?: string
  lastVerdict?: { kind: 'done' } | { kind: 'interrupted' } | { kind: 'failed'; error: string }
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
  }
  ended: boolean
  disposed: boolean
}

// ---------------------------------------------------------------------------
// Capabilities
// ---------------------------------------------------------------------------

export function headlessCapabilities(): DriverCapabilities {
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
    interactions: {
      supported: false,
      reason:
        'headless turns open no contract interactions in v1; structured permission routing is a filed gap, so structuredPermissions refuses unsupported rather than parking on an unanswered prompt',
    },
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
    archive: {
      supported: false,
      reason:
        'headless handoff archives stay with the transcript-archive path until a per-harness versioned form is proven',
    },
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
    if (event.t === 'item' && event.item.kind === 'partial') {
      host.send({ type: 'runtimeFineEvent', sessionId, event })
    } else {
      host.send({ type: 'runtimeEvent', sessionId, event })
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

  function stateFor(session: HeadlessDriverSession): AgentRuntimeState {
    const at = new Date(host.now()).toISOString()
    if (session.ended) {
      return { phase: 'ended', since: at, nativeSubagentCount: 0 }
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
        error: { class: 'provider-error', detail: verdict.error },
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
    if (session.liveTurn !== live) return
    session.liveTurn = undefined
    if (outcome.harnessSessionId) bindTranscript(session, outcome.harnessSessionId)
    if (outcome.error === undefined) {
      session.lastVerdict = { kind: 'done' }
      emit(
        session,
        { t: 'turn', ev: { ev: 'completed', turnEpoch: live.turnEpoch, verdict: 'done' } },
        'live',
      )
      return
    }
    if (live.interrupted || outcome.error === 'turn interrupted') {
      session.lastVerdict = { kind: 'interrupted' }
      emit(
        session,
        { t: 'turn', ev: { ev: 'completed', turnEpoch: live.turnEpoch, verdict: 'interrupted' } },
        'live',
      )
      return
    }
    session.lastVerdict = { kind: 'failed', error: outcome.error }
    const timedOut = /timed out/i.test(outcome.error)
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
      env: host.sessionEnv({
        sessionId: session.sessionId,
        agent,
        toolPolicyNone: identity.toolPolicy === 'none',
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
    if (input.structuredPermissions !== undefined) {
      return {
        outcome: 'refused',
        refusal: refuse(
          'unsupported',
          'structured permission routing has no answer channel on headless turns yet',
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
        host.assertNativeAccount(agent, asAccountId(accountId))
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
      // a rerun; a same-turnId collision with different identity refuses
      // outright (never a reuse); anything else while a turn is open is a busy
      // collision, never a queue — except an explicit interrupt delivery, which
      // fences the live turn first (interrupt-and-send).
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
        return { outcome: 'refused', refusal: refuse('busy', 'turn already running') }
      }
      live.interrupted = true
      try {
        await live.handle.interrupt()
      } catch {
        // Fencing is best-effort; the old turn's rejection still reports it.
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

    const spec = buildTurnSpec(session, input, {
      accountId: asAccountId(accountId),
      toolPolicy,
    })
    let handle: HeadlessTurnHandle
    try {
      const snapshot = await host.snapshot()
      const durable = host.durable()
      const emitFn: HeadlessEmit = (event) => {
        const current = session.liveTurn
        if (current && current.turnEpoch === turnEpoch) onTurnEvent(session, current, event)
      }
      handle =
        durable !== undefined
          ? runners.runDurableTurn(turnId, session.sessionId, spec, emitFn, snapshot, durable)
          : runners.runTurn(spec, emitFn, snapshot)
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
    const live = session.liveTurn
    if (live) {
      live.interrupted = true
      try {
        live.handle.interrupt()
      } catch {
        // Teardown is best-effort; the rejection still fences the turn below.
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
          interactions: [],
          at: new Date(host.now()).toISOString(),
        }
      },
      async export(): Promise<SessionArchive> {
        throw new DriverRefusalError(
          {
            reason: 'unsupported',
            detail: 'headless handoff archives stay with the transcript-archive path',
          },
          'headless export',
        )
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
      async answer(): Promise<InteractionAnswerOutcome> {
        return { ok: false, reason: 'unknown-interaction' }
      },
      async interactions(): Promise<readonly PendingInteraction[]> {
        return []
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
    const procedures: DriverProcedureOverrides = {
      // The generic composition cannot name a headless turn: the durable
      // identity rides `TurnInput.id` on the wire, so the override carries it
      // into the procedure that owns the journal and the deadline, and returns
      // only the terminal event the override contract promises.
      askAndAwait: (handle, input, options) => {
        const turnId = input.id
        if (!turnId) throw new Error('headless askAndAwait requires TurnInput.id turn identity')
        return headlessAskAndAwait(handle, input, { ...options, turnId }).then(
          (outcome) => outcome.terminal,
        )
      },
    }
    return {
      id: HEADLESS_DRIVER_ID,
      harness,
      family: 'server',
      capabilities: headlessCapabilities,
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
