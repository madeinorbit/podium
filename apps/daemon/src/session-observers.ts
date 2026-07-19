import { isDeepStrictEqual } from 'node:util'
import {
  type AgentRuntimeState,
  type AgentSession,
  type AgentStateEvent,
  type AgentStateProvider,
  ClaudeCausalObserver,
  captureClaudeTranscript,
  claudePromptHookFingerprint,
  claudeTranscriptSegmentId,
  type HarnessAdapter,
  type HarnessObservation,
  type HarnessObservationLease,
  type HarnessObserveInput,
  type HarnessObserverHost,
  type HarnessProviderRebind,
  harnessAdapterFor,
  initialAgentState,
  parseClaudeTranscriptSegmentId,
  reduceAgentState,
} from '@podium/agent-bridge'
import type {
  AgentKind,
  AgentObservation,
  ControlMessage,
  DaemonMessage,
  ObservationInputOrigin,
  TranscriptItem,
} from '@podium/protocol'
import { ObservationProvider, SessionObservationCheckpointV1 } from '@podium/protocol'
import {
  createSharedStatTick,
  recordToItemsForKind,
  type StatTick,
  type TranscriptTailer,
  tailTranscript,
} from '@podium/transcript'
import { countTail, timeTask } from './loop-attribution'
import type { SessionCwdTracker } from './worktree-resolve'

export type SpawnControl = Extract<ControlMessage, { type: 'spawn' }>
export type ReattachControl = Extract<ControlMessage, { type: 'reattach' }>

export interface SessionObserverInit {
  /** Wait for the first PTY frame before seeding boot state (fresh spawn — the
   *  CLI isn't up yet); reattach seeds immediately (survivor is at its prompt). */
  seedOnFrame: boolean
  /** Freshness floor for spawn-time session discovery (grok/codex/opencode/cursor);
   *  omitted on reattach so discovery has no floor. */
  startedAtMs?: number
}

export interface SessionObserversDeps {
  send(msg: DaemonMessage): void
  /** Test/embedding override; production creates one ticker for this registry. */
  statTick?: StatTick
  /** Discovery homeDir override (tests / isolated HOME). */
  homeDir?: string | undefined
  /** A live transcript tail appended — mark the file dirty for the active index refresh. */
  onTranscriptDirty(path: string): void
  /** The hook payload's live cwd — feeds the session cwd tracker. */
  cwdTracker: Pick<SessionCwdTracker, 'onHookCwd'>
  /** Test/embedding override for the otherwise canonical harness registry. */
  harnessAdapterFor?: typeof harnessAdapterFor
  /** Persist and replay an exact process-derived Codex P→T binding until acked. */
  onExactCodexBinding?: (sessionId: string, nativeId: string) => Promise<void>
  /** Paces each tail's FIRST backfill read (the expensive part of a reattach
   *  burst) — narrow concurrency, and held until the burst's bridge wiring has
   *  settled (POD-612). Omitted (tests) = seeds run immediately. */
  tailSeedGate?: (fn: () => Promise<void>) => Promise<void>
  /** Draft Sync v2 (POD-859): agent-idle transitions, so the composer engine only
   *  scrapes/injects while the composer is the live input. Omitted (tests) = no-op. */
  onIdleState?: (sessionId: string, idle: boolean) => void
}

/** The reattach message's recorded-path evidence; spawns don't carry one. */
export function pathHintOf(msg: SpawnControl | ReattachControl): string | undefined {
  return 'pathHint' in msg ? msg.pathHint : undefined
}

export type SessionObservers = ReturnType<typeof createSessionObservers>

/**
 * Hold before emitting a transition INTO phase `idle` on the wire.
 * Delivery fires on idle; a false-idle beat causes premature mid-turn
 * injection. Title quiet-window uses 500ms (apps/server title-filter); we sit
 * slightly longer in the design's 500–1500ms range for delivery safety.
 * [docs/agent-comms-target.html §04c]
 */
export const IDLE_TRANSITION_DEBOUNCE_MS = 1000

/**
 * All per-session observation state the daemon holds: agent-state trackers
 * (hook/observer events folded by the reducer), live transcript tails, and one
 * harness observation per session. The host is GENERIC (#249): everything
 * per-agent — what to watch, when a session id is known, which file to tail,
 * the hook re-pin policy — lives in the harness adapter's `observer`; this
 * factory owns the maps and the wire, so spawn, reattach, headless bind, hook
 * ingest, kill and dispose all mutate the SAME registry.
 */
export function createSessionObservers(deps: SessionObserversDeps) {
  const { send } = deps
  const adapterForKind = deps.harnessAdapterFor ?? harnessAdapterFor
  // One timer fans out every transcript/native-state stat poll in this daemon;
  // observer lifecycle only adds/removes callbacks. [spec:SP-c29e]
  const statTick = deps.statTick ?? createSharedStatTick()
  const trackers = new Map<string, { provider: AgentStateProvider; state: AgentRuntimeState }>()
  // Per-session pending →idle wire emissions. Cancelled on non-idle transition
  // or session teardown so timers never leak across sessions.
  const pendingIdleEmits = new Map<string, ReturnType<typeof setTimeout>>()
  // Live structured-transcript tails, keyed by Podium session id. Adapters point
  // the tail at their harness's live file (claude via hook payloads and the
  // resume-transcript bootstrap; grok/codex/cursor once their observer learns
  // the harness session id), so reattached chat gets history before new activity.
  const tails = new Map<string, TranscriptTailer>()
  // One live observation per session — the adapter-owned watch over the
  // harness's native session store (state observers, tail bootstrap, and for
  // codex the hook re-pin policy). The adapter rides along so the hook ingest
  // can resolve the session's resumeKind and record mapper without per-agent
  // branches.
  const observations = new Map<
    string,
    { adapter: HarnessAdapter; observation: HarnessObservation }
  >()
  type CausalLease = HarnessObservationLease & {
    cwd: string
  }
  type ClaudeCausalTracker = {
    observerGeneration: number
    providerSessionId: string
    transcriptPath: string
    observer: ClaudeCausalObserver
    bootstrapTransitionId: string
    bootstrapCursor: AgentObservation['providerCursor']
    awaitingBootstrapAck: boolean
    bufferedHooks: unknown[]
    processing: Promise<void>
    acceptedCursor: AgentObservation['providerCursor'] | null
    pendingTransitionId: string | null
    confirming: boolean
    stopConfirmationPoll?: () => void
  }
  const causalLeases = new Map<string, CausalLease>()
  const claudeCausal = new Map<string, ClaudeCausalTracker>()
  const pendingRebinds = new Map<
    string,
    {
      request: HarnessProviderRebind
      observerGeneration: number
      bindingVersion: number
      bufferedObservations: AgentObservation[]
      queuedRebinds: HarnessProviderRebind[]
    }
  >()
  const pendingClaudeOrigins = new Map<string, ObservationInputOrigin[]>()
  const claudeStarting = new Map<string, unknown[]>()
  const pendingBindingHooks = new Map<string, Map<string, unknown>>()
  const liveConfirmationStates = new Map<
    string,
    { signature: string; sequence: number; emitted: number; lastEmittedAt: number }
  >()

  const emitLiveConfirmation = (
    sessionId: string,
    providerCursor: AgentObservation['providerCursor'],
  ): void => {
    const lease = causalLeases.get(sessionId)
    if (!lease) return
    const signature = JSON.stringify({
      provider: lease.provider,
      providerSessionId: lease.providerSessionId,
      bindingVersion: lease.bindingVersion,
      observerGeneration: lease.observerGeneration,
      providerCursor,
    })
    const prior = liveConfirmationStates.get(sessionId)
    const state =
      prior?.signature === signature
        ? prior
        : { signature, sequence: 0, emitted: 0, lastEmittedAt: 0 }
    const now = Date.now()
    if (state.emitted >= 2 && now - state.lastEmittedAt < 60_000) return
    const livePollSequence = state.sequence + 1
    liveConfirmationStates.set(sessionId, {
      ...state,
      sequence: livePollSequence,
      emitted: state.emitted + 1,
      lastEmittedAt: now,
    })
    send({
      type: 'agentObserverLiveConfirmation',
      sessionId,
      provider: lease.provider,
      providerSessionId: lease.providerSessionId,
      bindingVersion: lease.bindingVersion,
      observerGeneration: lease.observerGeneration,
      providerCursor,
      livePollSequence,
      confirmedAt: new Date().toISOString(),
    })
  }

  const emitObservation = (
    sessionId: string,
    observation: Extract<DaemonMessage, { type: 'agentObservation' }>['observation'],
  ): void => {
    const pending = pendingRebinds.get(sessionId)
    if (pending) {
      pending.bufferedObservations.push(observation)
      return
    }
    const lease = causalLeases.get(sessionId)
    if (
      !lease ||
      observation.podiumSessionId !== sessionId ||
      observation.provider !== lease.provider ||
      observation.observerGeneration !== lease.observerGeneration ||
      observation.bindingVersion !== lease.bindingVersion ||
      (lease.providerSessionId !== null &&
        observation.providerSessionId !== lease.providerSessionId)
    )
      return
    send({ type: 'agentObservation', observation })
  }

  const applyClaudeHook = async (causal: ClaudeCausalTracker, payload: unknown): Promise<void> => {
    const p = payload as Record<string, unknown>
    const path = typeof p.transcript_path === 'string' ? p.transcript_path : ''
    let capture: Awaited<ReturnType<typeof captureClaudeTranscript>>
    try {
      capture = await captureClaudeTranscript(path)
    } catch {
      return
    }
    const baseSegmentId = claudeTranscriptSegmentId(String(p.session_id), capture)
    const promptFingerprint = claudePromptHookFingerprint(payload)
    const promptEvidence = promptFingerprint
      ? capture.prompts.findLast((prompt) => prompt.payloadFingerprint === promptFingerprint)
      : undefined
    const observation = await causal.observer.observeHook(
      payload,
      causal.observer.nextHookOffset(capture.boundary),
      undefined,
      baseSegmentId,
      promptEvidence
        ? {
            recordBoundary: promptEvidence.recordBoundary,
            payloadFingerprint: promptEvidence.payloadFingerprint,
          }
        : undefined,
    )
    if (observation) {
      causal.pendingTransitionId = observation.transitionId
      emitObservation(observation.podiumSessionId, observation)
    }
  }

  const startClaudeCausal = async (sessionId: string, payload: unknown): Promise<void> => {
    const lease = causalLeases.get(sessionId)
    const tracker = trackers.get(sessionId)
    const p = payload as Record<string, unknown> | null
    const providerSessionId = typeof p?.session_id === 'string' ? p.session_id : ''
    const transcriptPath = typeof p?.transcript_path === 'string' ? p.transcript_path : ''
    if (!lease || !tracker || !providerSessionId || !transcriptPath) {
      claudeStarting.delete(sessionId)
      return
    }

    const checkpoint =
      lease.acceptedCheckpoint &&
      (lease.acceptedCheckpoint.providerSessionId === null ||
        lease.acceptedCheckpoint.providerSessionId === providerSessionId)
        ? lease.acceptedCheckpoint
        : undefined
    const acceptedCursor = checkpoint?.providerCursor
    const acceptedOffset = acceptedCursor?.components.transcript
    const acceptedIdentity = parseClaudeTranscriptSegmentId(acceptedCursor?.segmentId)
    let capture: Awaited<ReturnType<typeof captureClaudeTranscript>>
    try {
      capture = await captureClaudeTranscript(
        transcriptPath,
        checkpoint && p?.hook_event_name !== 'UserPromptSubmit'
          ? {
              promptScanStart:
                acceptedIdentity && Number.isSafeInteger(acceptedOffset)
                  ? (acceptedOffset ?? 0)
                  : 0,
              ...(acceptedIdentity ? { promptScanIdentity: acceptedIdentity } : {}),
            }
          : {},
      )
    } catch {
      capture = {
        boundary: 0,
        capturedSize: 0,
        path: transcriptPath,
        device: 'missing',
        inode: 'missing',
        fileIdentity: 'missing',
        bootEvents: [{ kind: 'session_started' as const }],
        prompts: [],
        promptCount: 0,
        latestPrompt: null,
      }
    }
    const bootstrapOffset = capture.boundary
    const baseSegmentId = claudeTranscriptSegmentId(providerSessionId, capture)
    const acceptedSameFile = Boolean(
      acceptedCursor &&
        acceptedIdentity &&
        acceptedIdentity.path === capture.path &&
        acceptedIdentity.device === capture.device &&
        acceptedIdentity.inode === capture.inode,
    )
    const acceptedSameSegment = Boolean(
      acceptedSameFile &&
        Number.isSafeInteger(acceptedOffset) &&
        bootstrapOffset >= (acceptedOffset ?? 0),
    )
    const segmentId =
      acceptedSameSegment && acceptedCursor
        ? acceptedCursor.segmentId
        : checkpoint
          ? `${baseSegmentId}:after:${checkpoint.lastTransitionId ?? 'checkpoint'}`
          : baseSegmentId
    const bootstrapAdvanced = Boolean(
      checkpoint &&
        (acceptedSameSegment ? bootstrapOffset > (acceptedOffset ?? 0) : bootstrapOffset > 0),
    )
    const gapPromptCount =
      bootstrapAdvanced && p?.hook_event_name !== 'UserPromptSubmit' ? capture.promptCount : 0
    const latestPrompt = gapPromptCount > 0 ? capture.latestPrompt : null
    const bootstrapPromptOrigin = latestPrompt?.origin
    let bootstrapState = checkpoint?.turnState ?? initialAgentState(new Date().toISOString())
    if (!checkpoint || bootstrapAdvanced) {
      bootstrapState = initialAgentState(new Date().toISOString())
      for (const event of capture.bootEvents) {
        bootstrapState = reduceAgentState(bootstrapState, event, new Date().toISOString())
      }
      if (latestPrompt?.hasAssistantOutputAfter === false) {
        bootstrapState = reduceAgentState(
          initialAgentState(new Date().toISOString()),
          { kind: 'prompt_submitted' },
          new Date().toISOString(),
        )
      }
    }
    // UserPromptSubmit is the causal boundary. Claude may append the prompt to
    // JSONL before posting the hook, so a tail classification at hook receipt
    // can already say working. Snapshot the pre-signal side of that boundary;
    // the buffered provider hook then owns the sole live working edge.
    if (
      p?.hook_event_name === 'UserPromptSubmit' &&
      (bootstrapState.phase === 'working' || bootstrapState.phase === 'compacting')
    ) {
      bootstrapState = reduceAgentState(
        bootstrapState,
        { kind: 'turn_completed' },
        new Date().toISOString(),
      )
    }
    const observer = new ClaudeCausalObserver({
      podiumSessionId: sessionId,
      observerGeneration: lease.observerGeneration,
      bindingVersion: lease.bindingVersion,
      providerSessionId,
      transcriptPath,
      transcriptSegmentId: segmentId,
      bootstrapState,
      ...(checkpoint ? { acceptedCheckpoint: checkpoint } : {}),
      bootstrapAdvanced,
      bootstrapPromptCount: gapPromptCount,
      ...(bootstrapPromptOrigin !== undefined ? { bootstrapPromptOrigin } : {}),
      bootstrapOffset,
    })
    for (const origin of pendingClaudeOrigins.get(sessionId) ?? [])
      observer.recordInputOrigin(origin)
    pendingClaudeOrigins.delete(sessionId)

    const snapshot = observer.bootstrap()
    if (!snapshot) return
    const causal: ClaudeCausalTracker = {
      observerGeneration: snapshot.observerGeneration,
      providerSessionId,
      transcriptPath,
      observer,
      bootstrapTransitionId: snapshot.transitionId,
      bootstrapCursor: snapshot.providerCursor,
      awaitingBootstrapAck: true,
      bufferedHooks: claudeStarting.get(sessionId) ?? [payload],
      processing: Promise.resolve(),
      acceptedCursor: null,
      pendingTransitionId: null,
      confirming: false,
    }
    claudeCausal.set(sessionId, causal)
    claudeStarting.delete(sessionId)
    tracker.state = bootstrapState
    emitObservation(sessionId, snapshot)
  }

  const onObservationAck = (
    msg: Extract<ControlMessage, { type: 'agentObservationAck' }>,
  ): void => {
    const lease = causalLeases.get(msg.sessionId)
    if (!lease || msg.observerGeneration !== lease.observerGeneration) return
    const bound = observations.get(msg.sessionId)
    // Claude accepted one-release acks before bindingVersion existed. New
    // generic adapters require the exact binding fence.
    if (msg.bindingVersion === undefined && bound?.adapter.kind !== 'claude-code') return
    if (msg.bindingVersion !== undefined && msg.bindingVersion !== lease.bindingVersion) return
    bound?.observation.onObservationAck?.(msg)
    const causal = claudeCausal.get(msg.sessionId)
    if (!causal) return
    if (msg.transitionId !== causal.bootstrapTransitionId || !causal.awaitingBootstrapAck) {
      causal.observer.acknowledgeCursor(msg.acceptedCursor)
      if (msg.transitionId !== causal.pendingTransitionId) return
      causal.pendingTransitionId = null
      if (msg.acceptedCursor !== undefined && msg.acceptedCursor !== null) {
        causal.acceptedCursor = msg.acceptedCursor
      }
      return
    }
    const reconciledBootstrap =
      msg.result === 'rejected' &&
      msg.acceptedCursor !== undefined &&
      (msg.rejectionReason === 'cursor_not_after_checkpoint' ||
        msg.rejectionReason === 'terminal_epoch_closed')
    const duplicateBootstrap =
      msg.result === 'rejected' &&
      msg.rejectionReason === 'duplicate_transition' &&
      msg.acceptedCursor !== undefined &&
      isDeepStrictEqual(msg.acceptedCursor, causal.bootstrapCursor)
    if (msg.result === 'rejected' && !reconciledBootstrap && !duplicateBootstrap) return
    causal.observer.acknowledgeCursor(msg.acceptedCursor)
    if (msg.acceptedCursor !== undefined && msg.acceptedCursor !== null) {
      causal.acceptedCursor = msg.acceptedCursor
    }
    if ((msg.result !== 'rejected' || duplicateBootstrap) && lease.providerSessionId === null) {
      causalLeases.set(msg.sessionId, { ...lease, providerSessionId: causal.providerSessionId })
    }
    causal.pendingTransitionId = null
    causal.awaitingBootstrapAck = false
    const buffered = causal.bufferedHooks.splice(0)
    for (const payload of buffered) {
      causal.processing = causal.processing.then(() => applyClaudeHook(causal, payload))
    }
    if (!causal.stopConfirmationPoll) {
      causal.stopConfirmationPoll = statTick.subscribe(() => {
        if (causal.awaitingBootstrapAck || causal.confirming || !causal.acceptedCursor) return
        causal.confirming = true
        void causal.processing
          .then(async () => {
            if (
              causal.bufferedHooks.length > 0 ||
              causal.pendingTransitionId !== null ||
              !causal.acceptedCursor
            )
              return
            const cursor = causal.acceptedCursor
            const identity = parseClaudeTranscriptSegmentId(cursor.segmentId)
            if (!identity) return
            const capture = await captureClaudeTranscript(causal.transcriptPath, {
              promptScanStart: cursor.components.transcript ?? 0,
              promptScanIdentity: identity,
            })
            if (
              identity.path === capture.path &&
              identity.device === capture.device &&
              identity.inode === capture.inode &&
              capture.capturedSize === capture.boundary &&
              capture.boundary >= (cursor.components.transcript ?? 0) &&
              !capture.prompts.some(
                (prompt) => prompt.recordBoundary > (cursor.components.transcript ?? 0),
              )
            ) {
              emitLiveConfirmation(msg.sessionId, cursor)
            }
          })
          .catch(() => {})
          .finally(() => {
            causal.confirming = false
          })
      })
    }
  }

  const sendProviderRebind = (sessionId: string, rebind: HarnessProviderRebind): void => {
    const lease = causalLeases.get(sessionId)
    if (!lease) return
    const pending = pendingRebinds.get(sessionId)
    if (pending) {
      if (
        pending.request.rebindId === rebind.rebindId &&
        pending.request.nextProviderSessionId === rebind.nextProviderSessionId
      ) {
        send({
          type: 'agentObservationRebind',
          sessionId,
          provider: lease.provider,
          providerSessionId: lease.providerSessionId,
          observerGeneration: pending.observerGeneration,
          bindingVersion: pending.bindingVersion,
          nextProviderSessionId: rebind.nextProviderSessionId,
          resumeKind: rebind.resumeKind,
          rebindId: rebind.rebindId,
        })
      } else if (!pending.queuedRebinds.some((queued) => queued.rebindId === rebind.rebindId)) {
        pending.queuedRebinds.push(rebind)
      }
      return
    }
    pendingRebinds.set(sessionId, {
      request: rebind,
      observerGeneration: lease.observerGeneration,
      bindingVersion: lease.bindingVersion,
      bufferedObservations: [],
      queuedRebinds: [],
    })
    send({
      type: 'agentObservationRebind',
      sessionId,
      provider: lease.provider,
      providerSessionId: lease.providerSessionId,
      observerGeneration: lease.observerGeneration,
      bindingVersion: lease.bindingVersion,
      nextProviderSessionId: rebind.nextProviderSessionId,
      resumeKind: rebind.resumeKind,
      rebindId: rebind.rebindId,
    })
  }

  const onProviderRebindAck = (
    msg: Extract<ControlMessage, { type: 'agentObservationRebindAck' }>,
  ): void => {
    const lease = causalLeases.get(msg.sessionId)
    const pending = pendingRebinds.get(msg.sessionId)
    if (!lease || !pending) return
    if (
      msg.provider !== lease.provider ||
      msg.rebindId !== pending.request.rebindId ||
      msg.priorObserverGeneration !== lease.observerGeneration ||
      msg.priorBindingVersion !== lease.bindingVersion ||
      msg.nextProviderSessionId !== pending.request.nextProviderSessionId
    )
      return
    const acceptedAdvanced =
      msg.providerSessionId === msg.nextProviderSessionId &&
      msg.observerGeneration === pending.observerGeneration + 1 &&
      msg.bindingVersion === pending.bindingVersion + 1
    const acceptedUnchanged =
      msg.providerSessionId === msg.nextProviderSessionId &&
      lease.providerSessionId === msg.nextProviderSessionId &&
      msg.observerGeneration === pending.observerGeneration &&
      msg.bindingVersion === pending.bindingVersion
    if (msg.result === 'accepted' && !acceptedAdvanced && !acceptedUnchanged) return
    if (
      msg.result === 'rejected' &&
      (msg.observerGeneration < pending.observerGeneration ||
        msg.bindingVersion < pending.bindingVersion)
    )
      return
    pendingRebinds.delete(msg.sessionId)
    const acceptedCheckpoint =
      msg.checkpoint &&
      msg.checkpoint.podiumSessionId === msg.sessionId &&
      msg.checkpoint.provider === msg.provider &&
      msg.checkpoint.providerSessionId === msg.providerSessionId &&
      msg.checkpoint.bindingVersion === msg.bindingVersion &&
      msg.checkpoint.lifecycleObservationGeneration <= msg.observerGeneration
        ? msg.checkpoint
        : null
    causalLeases.set(msg.sessionId, {
      provider: msg.provider,
      providerSessionId: msg.providerSessionId,
      observerGeneration: msg.observerGeneration,
      bindingVersion: msg.bindingVersion,
      acceptedCheckpoint,
      cwd: lease.cwd,
    })
    liveConfirmationStates.delete(msg.sessionId)
    observations.get(msg.sessionId)?.observation.onProviderRebindAck?.(msg)
    for (const observation of pending.bufferedObservations) {
      emitObservation(msg.sessionId, observation)
    }
    const bindingHooks = pendingBindingHooks.get(msg.sessionId)
    const pendingBindingHook =
      msg.providerSessionId === null
        ? undefined
        : (bindingHooks?.get(msg.providerSessionId) as Record<string, unknown> | undefined)
    if (pendingBindingHook) {
      const transcriptPath = pendingBindingHook.transcript_path
      const adapter = observations.get(msg.sessionId)?.adapter
      if (adapter && typeof transcriptPath === 'string' && transcriptPath) {
        ensureTranscriptTail(msg.sessionId, transcriptPath, recordToItemsForKind(adapter.kind))
      }
      bindingHooks?.delete(msg.providerSessionId!)
      if (bindingHooks?.size === 0) pendingBindingHooks.delete(msg.sessionId)
    }
    const pendingClaude = claudeStarting.get(msg.sessionId)
    const pendingClaudeSessionId = (pendingClaude?.[0] as Record<string, unknown> | undefined)
      ?.session_id
    if (
      observations.get(msg.sessionId)?.adapter.kind === 'claude-code' &&
      typeof pendingClaudeSessionId === 'string'
    ) {
      claudeCausal.get(msg.sessionId)?.stopConfirmationPoll?.()
      claudeCausal.delete(msg.sessionId)
      if (pendingClaudeSessionId === msg.providerSessionId) {
        void startClaudeCausal(msg.sessionId, pendingClaude![0])
      } else {
        sendProviderRebind(msg.sessionId, pending.request)
      }
    }
    for (const queued of pending.queuedRebinds) sendProviderRebind(msg.sessionId, queued)
  }

  const recordInputOrigin = (
    sessionId: string,
    origin: ObservationInputOrigin | undefined,
  ): void => {
    if (!origin) return
    const causal = claudeCausal.get(sessionId)
    if (causal) causal.observer.recordInputOrigin(origin)
    else
      pendingClaudeOrigins.set(sessionId, [...(pendingClaudeOrigins.get(sessionId) ?? []), origin])
  }

  // Live-tail SEED window (POD-613): the first read only refills the server's
  // gap-bridging per-session buffer (chat-capability flag, first-prompt title
  // fallback, knownPaths file-read hints) — clients page real history off disk
  // via the cursor read source (transcriptRead), which is untouched. Sized to
  // match the 2000-item window the already-held reattach re-seed reads
  // (control/session.ts readSlice limit), so the two boot paths stay in step.
  const TAIL_SEED_WINDOW_BYTES = 2 * 1024 * 1024
  const TAIL_SEED_MAX_ITEMS = 2000

  const ensureTranscriptTail = (
    sessionId: string,
    path: string,
    recordToItems: (record: unknown) => TranscriptItem[],
  ): void => {
    const existing = tails.get(sessionId)
    if (existing?.path === path) return
    existing?.stop()
    tails.set(
      sessionId,
      tailTranscript(
        path,
        (items, meta) => {
          if (items.length === 0 && !meta.reset) return
          countTail()
          // The per-batch delta publish (encode + ws send + dirty-mark) is
          // synchronous loop work — timed so a chatty transcript shows up in
          // the stall attribution.
          timeTask(`tailBatch(${items.length})`, () => {
            send({
              type: 'transcriptDelta',
              sessionId,
              items,
              ...(meta.tail ? { tail: meta.tail } : {}),
              ...(meta.reset ? { reset: true } : {}),
            })
            // The tail fired because this transcript file was appended to — mark it
            // dirty so the worker re-summarizes JUST it (coalesced, ~1s) and keeps the
            // search index near-real-time, instead of waiting for the periodic scan.
            deps.onTranscriptDirty(path)
          })
        },
        {
          recordToItems,
          statTick,
          // The agent's `/color` accent rides the same transcript tail.
          onColor: (color) => send({ type: 'agentColor', sessionId, color }),
          ...(deps.tailSeedGate ? { seedGate: deps.tailSeedGate } : {}),
          initialWindowBytes: TAIL_SEED_WINDOW_BYTES,
          maxInitialItems: TAIL_SEED_MAX_ITEMS,
        },
      ),
    )
  }
  const stopTranscriptTail = (sessionId: string): void => {
    tails.get(sessionId)?.stop()
    tails.delete(sessionId)
  }
  const cancelPendingIdleEmit = (sessionId: string): void => {
    const timer = pendingIdleEmits.get(sessionId)
    if (timer === undefined) return
    clearTimeout(timer)
    pendingIdleEmits.delete(sessionId)
  }
  const applyAgentStateEvents = (sessionId: string, events: AgentStateEvent[]): void => {
    const tracker = trackers.get(sessionId)
    if (!tracker) return
    for (const event of events) {
      const prev = tracker.state
      const next = reduceAgentState(prev, event, new Date().toISOString())
      if (next === prev) continue
      tracker.state = next

      // Debounce only transitions INTO idle. Non-idle phases emit immediately
      // so working/needs_user/errored stay snappy; a false-idle beat must not
      // reach the wire (delivery fires on idle).
      const enteringIdle = prev.phase !== 'idle' && next.phase === 'idle'
      if (enteringIdle) {
        cancelPendingIdleEmit(sessionId)
        const timer = setTimeout(() => {
          pendingIdleEmits.delete(sessionId)
          const current = trackers.get(sessionId)?.state
          // Still tracked and still idle → emit the authoritative current
          // state (may differ from `next` if a later idle refined the verdict
          // without leaving the phase; non-idle would have cancelled us).
          if (current?.phase === 'idle') {
            send({ type: 'agentState', sessionId, state: current })
            deps.onIdleState?.(sessionId, true)
          }
        }, IDLE_TRANSITION_DEBOUNCE_MS)
        pendingIdleEmits.set(sessionId, timer)
        continue
      }

      cancelPendingIdleEmit(sessionId)
      send({ type: 'agentState', sessionId, state: next })
      deps.onIdleState?.(sessionId, next.phase === 'idle')
    }
  }

  // The daemon services an adapter's observation drives, closed over one
  // session. Every per-agent difference is behind these five callbacks.
  const hostFor = (sessionId: string, adapter: HarnessAdapter): HarnessObserverHost => ({
    tailFile: (path) => ensureTranscriptTail(sessionId, path, recordToItemsForKind(adapter.kind)),
    // Recording a resume ref marks the session resumable (→ hibernate button);
    // the first transcript frame marks it chat-capable (→ chat switcher + BTW
    // button). The kind comes off the adapter — never a literal.
    onResumeValue: (value, confidence) => {
      if (adapter.kind === 'codex' && confidence === 'exact' && deps.onExactCodexBinding) {
        void deps
          .onExactCodexBinding(sessionId, value)
          .catch((err) =>
            console.warn(`[podium] codex identity receipt failed for ${sessionId}:`, err),
          )
        return
      }
      send({
        type: 'sessionResumeRef',
        sessionId,
        resume: { kind: adapter.resumeKind, value },
        ...(confidence ? { confidence } : {}),
      })
    },
    onTitle: (title) => send({ type: 'title', sessionId, title }),
    onStateEvents: (events) => applyAgentStateEvents(sessionId, events),
    onObservation: (observation) => emitObservation(sessionId, observation),
    onLiveObservationCycle: (cursor) => emitLiveConfirmation(sessionId, cursor),
    onExactProviderRebind: (rebind) => sendProviderRebind(sessionId, rebind),
    onTranscriptItems: (items, reset) => {
      if (items.length === 0 && !reset) return
      // Items arrive already cursor-stamped by the observer (opencode:
      // stampOpencodeItems), so the live delta carries the same cursors the
      // on-demand read produces.
      const tail = items.at(-1)?.cursor
      send({
        type: 'transcriptDelta',
        sessionId,
        items,
        ...(reset ? { reset: true } : {}),
        ...(tail ? { tail } : {}),
      })
    },
  })

  const stopObservation = (sessionId: string): void => {
    observations.get(sessionId)?.observation.stop()
    observations.delete(sessionId)
  }
  const startObservation = (
    sessionId: string,
    adapter: HarnessAdapter,
    input: HarnessObserveInput,
  ): void => {
    stopObservation(sessionId)
    observations.set(sessionId, {
      adapter,
      observation: adapter.observer(input, hostFor(sessionId, adapter)),
    })
  }

  // Seed agent state for a session whose CLI is already running but hasn't fired a
  // hook yet. Claude Code emits no SessionStart at interactive boot, so both a
  // fresh spawn and a post-restart reattach would otherwise sit at phase 'unknown'
  // — which the home board reads as 'working', flagging an idle survivor as active.
  // bootEvents reports idle (a resume value classifies the live transcript for a
  // richer verdict). Guarded on phase still 'unknown' so a real hook that already
  // landed always wins; best-effort, hooks remain authoritative.
  const seedBootState = async (
    sessionId: string,
    provider: AgentStateProvider,
    cwd: string,
    resumeValue?: string,
    pathHint?: string,
  ): Promise<void> => {
    if (!provider.bootEvents) return
    let events: AgentStateEvent[]
    try {
      events = await provider.bootEvents({
        cwd,
        ...(resumeValue ? { resumeValue } : {}),
        ...(pathHint ? { pathHint } : {}),
      })
    } catch {
      return
    }
    const tracker = trackers.get(sessionId)
    if (!tracker) return
    for (const event of events) {
      if (tracker.state.phase !== 'unknown') return
      const next = reduceAgentState(tracker.state, event, new Date().toISOString())
      if (next === tracker.state) continue
      tracker.state = next
      send({ type: 'agentState', sessionId, state: next })
      deps.onIdleState?.(sessionId, next.phase === 'idle')
    }
  }

  // (Re)build the per-session observers a fresh daemon must stand up right after
  // wiring the PTY bridge: the agent-state tracker, the adapter's observation
  // (harness state observer and/or resume transcript tail), and a seeded phase.
  // Spawn AND reattach both call this so the two paths can't silently diverge —
  // that drift left idle survivors shown 'working' with an empty chat after a
  // redeploy. 'shell' (and unknown kinds) have no adapter → no observation.
  const initSessionObservers = (
    msg: SpawnControl | ReattachControl,
    session: AgentSession,
    provider: AgentStateProvider | undefined,
    init: SessionObserverInit,
  ): void => {
    if (provider) {
      trackers.set(msg.sessionId, {
        provider,
        state: initialAgentState(new Date().toISOString()),
      })
    }
    const adapter = adapterForKind(msg.agentKind)
    const observationProvider = ObservationProvider.safeParse(adapter?.kind)
    if (
      observationProvider.success &&
      msg.observationGeneration !== undefined &&
      msg.observationBindingVersion !== undefined
    ) {
      pendingRebinds.delete(msg.sessionId)
      pendingBindingHooks.delete(msg.sessionId)
      claudeStarting.delete(msg.sessionId)
      claudeCausal.get(msg.sessionId)?.stopConfirmationPoll?.()
      claudeCausal.delete(msg.sessionId)
      const checkpoint = SessionObservationCheckpointV1.safeParse(msg.observationCheckpoint)
      const providerSessionId =
        msg.observationProviderSessionId !== undefined
          ? msg.observationProviderSessionId
          : checkpoint.success
            ? checkpoint.data.providerSessionId
            : (msg.resume?.value ?? null)
      const resumeMatchesLease = msg.resume === undefined || msg.resume.value === providerSessionId
      const acceptedCheckpoint =
        checkpoint.success &&
        resumeMatchesLease &&
        checkpoint.data.podiumSessionId === msg.sessionId &&
        checkpoint.data.provider === observationProvider.data &&
        checkpoint.data.providerSessionId === providerSessionId &&
        checkpoint.data.bindingVersion === msg.observationBindingVersion &&
        checkpoint.data.lifecycleObservationGeneration <= msg.observationGeneration
          ? checkpoint.data
          : null
      causalLeases.set(msg.sessionId, {
        provider: observationProvider.data,
        providerSessionId,
        observerGeneration: msg.observationGeneration,
        bindingVersion: msg.observationBindingVersion,
        cwd: msg.cwd,
        acceptedCheckpoint,
      })
    }
    if (adapter) {
      const pathHint = pathHintOf(msg)
      const observationLease = causalLeases.get(msg.sessionId)
      startObservation(msg.sessionId, adapter, {
        cwd: msg.cwd,
        statTick,
        podiumSessionId: msg.sessionId,
        ...(msg.resume?.value ? { resumeValue: msg.resume.value } : {}),
        ...(deps.homeDir ? { homeDir: deps.homeDir } : {}),
        ...(init.startedAtMs !== undefined ? { startedAtMs: init.startedAtMs } : {}),
        // Reattach carries the session's original spawn time — the codex
        // lazy-rollout discovery floor (see HarnessObserveInput.createdAtMs).
        ...('createdAtMs' in msg && msg.createdAtMs !== undefined
          ? { createdAtMs: msg.createdAtMs }
          : {}),
        // Reattach carries the server's recorded segment path — evidence beats
        // cwd derivation after a worktree move (conversation registry §3.3).
        ...(pathHint ? { pathHint } : {}),
        ...(observationLease
          ? {
              observationLease: {
                provider: observationLease.provider,
                providerSessionId: observationLease.providerSessionId,
                bindingVersion: observationLease.bindingVersion,
                observerGeneration: observationLease.observerGeneration,
                acceptedCheckpoint: observationLease.acceptedCheckpoint,
              },
            }
          : {}),
      })
    }
    if (provider?.bootEvents && !causalLeases.has(msg.sessionId)) {
      // const capture so the narrowing survives into the onFrame closure.
      const bootProvider = provider
      const seed = (): void => {
        const run = () =>
          seedBootState(msg.sessionId, bootProvider, msg.cwd, msg.resume?.value, pathHintOf(msg))
        // Reattach can enqueue 100+ full-rollout reads/classifications at once.
        // Pace those boot-state seeds with transcript backfills so their synchronous
        // parse completions cannot starve watchdog/interaction timers. [spec:SP-c29e]
        if (!init.seedOnFrame && deps.tailSeedGate) void deps.tailSeedGate(run)
        else void run()
      }
      if (init.seedOnFrame) {
        const offFirstFrame = session.onFrame(() => {
          offFirstFrame()
          seed()
        })
      } else {
        seed()
      }
    }
  }

  /** Stand up the per-kind transcript observation for a headless session — the
   *  same setup initSessionObservers does on reattach, minus the PTY and state
   *  tracker (headless sessions have no hook channel; observations that emit
   *  state events no-op without a tracker). No discovery floor: the harness
   *  session id is always known here, so observers pin rather than discover. */
  const bindHeadlessSession = (
    sessionId: string,
    agentKind: AgentKind,
    cwd: string,
    resumeValue: string,
  ): void => {
    const adapter = adapterForKind(agentKind)
    if (!adapter) throw new Error(`agent kind ${agentKind} has no headless transcript binding`)
    startObservation(sessionId, adapter, {
      cwd,
      statTick,
      resumeValue,
      ...(deps.homeDir ? { homeDir: deps.homeDir } : {}),
    })
  }

  // The shared hook ingest's onPayload: Claude AND Codex (≥0.142 native hooks)
  // both post here with the same core shape (session_id + transcript_path +
  // hook_event_name). The session's live observation carries its adapter, so
  // the routing is generic: the adapter names the resume kind and the record
  // mapper, and `bindHookThread` (codex) owns the re-pin policy.
  const onHookPayload = (sessionId: string, payload: unknown): void => {
    const tracker = trackers.get(sessionId)
    if (!tracker) return
    // A tracker implies an adapter (the provider comes off the adapter) and the
    // two registries are populated/cleared together, so `bound` is always set
    // when the tracker is; guard anyway rather than assume.
    const bound = observations.get(sessionId)
    if (!bound) return
    const fields = payload as Record<string, unknown> | null
    const harnessSessionId = fields?.session_id
    const causalLease = causalLeases.get(sessionId)
    const changedCausalBinding = Boolean(
      typeof harnessSessionId === 'string' &&
        harnessSessionId &&
        causalLease &&
        causalLease.providerSessionId !== null &&
        harnessSessionId !== causalLease.providerSessionId,
    )
    if (changedCausalBinding) {
      const hookEventName = fields?.hook_event_name
      const confirmsNewBinding =
        hookEventName === 'SessionStart' || hookEventName === 'UserPromptSubmit'
      if (!confirmsNewBinding) return
      const bindingHooks = pendingBindingHooks.get(sessionId) ?? new Map<string, unknown>()
      bindingHooks.set(harnessSessionId as string, payload)
      pendingBindingHooks.set(sessionId, bindingHooks)
      bound.observation.bindHookThread?.(harnessSessionId as string)
      if (bound.adapter.kind === 'claude-code') {
        const starting = claudeStarting.get(sessionId)
        if (starting) starting.push(payload)
        else claudeStarting.set(sessionId, [payload])
        sendProviderRebind(sessionId, {
          nextProviderSessionId: harnessSessionId as string,
          resumeKind: bound.adapter.resumeKind,
          rebindId: [
            'rebind',
            causalLease!.bindingVersion,
            causalLease!.observerGeneration,
            harnessSessionId,
          ].join(':'),
        })
      }
      return
    }

    const transcriptPath = fields?.transcript_path
    if (typeof transcriptPath === 'string' && transcriptPath) {
      ensureTranscriptTail(sessionId, transcriptPath, recordToItemsForKind(bound.adapter.kind))
    }
    if (typeof harnessSessionId === 'string' && harnessSessionId) {
      send({
        type: 'sessionResumeRef',
        sessionId,
        resume: { kind: bound.adapter.resumeKind, value: harnessSessionId },
        confidence: 'exact',
        ...(bound.adapter.kind === 'codex' ? { ackRequested: true } : {}),
      })
      bound.observation.bindHookThread?.(harnessSessionId)
    }
    // The agent's live working directory — follows EnterWorktree and `cd`. The
    // tracker resolves it to the containing worktree root and tells the server
    // only when THAT changes, so the sidebar re-groups on real worktree moves
    // but not on subdirectory cds within the same checkout.
    const hookCwd = fields?.cwd
    if (typeof hookCwd === 'string' && hookCwd) {
      void deps.cwdTracker.onHookCwd(sessionId, hookCwd)
    }
    if (bound.adapter.kind === 'claude-code' && causalLeases.has(sessionId)) {
      const causal = claudeCausal.get(sessionId)
      if (!causal) {
        const starting = claudeStarting.get(sessionId)
        if (starting) starting.push(payload)
        else {
          claudeStarting.set(sessionId, [payload])
          void startClaudeCausal(sessionId, payload)
        }
      } else if (causal.awaitingBootstrapAck) {
        causal.bufferedHooks.push(payload)
      } else {
        causal.processing = causal.processing.then(() => applyClaudeHook(causal, payload))
      }
      return
    }
    void tracker.provider
      .translate(payload)
      .then((events) => applyAgentStateEvents(sessionId, events))
      .catch((err) => console.warn(`[podium] hook translate failed for ${sessionId}:`, err))
  }

  /** Current tracked agent state, if the session has a live tracker. */
  const trackedState = (sessionId: string): AgentRuntimeState | undefined =>
    trackers.get(sessionId)?.state

  /** Tear down every observer + tail + tracker one session holds (exit/kill path). */
  const clearSession = (sessionId: string): void => {
    cancelPendingIdleEmit(sessionId)
    trackers.delete(sessionId)
    stopObservation(sessionId)
    causalLeases.delete(sessionId)
    pendingRebinds.delete(sessionId)
    pendingBindingHooks.delete(sessionId)
    claudeCausal.get(sessionId)?.stopConfirmationPoll?.()
    claudeCausal.delete(sessionId)
    claudeStarting.delete(sessionId)
    pendingClaudeOrigins.delete(sessionId)
    liveConfirmationStates.delete(sessionId)
    stopTranscriptTail(sessionId)
  }

  const stopAllTails = (): void => {
    for (const id of [...tails.keys()]) stopTranscriptTail(id)
  }

  /** Stop every observation + tracker (daemon dispose). Tails are stopped
   *  separately by close() — matching the pre-split shutdown order. */
  const disposeObservers = (): void => {
    for (const id of [...pendingIdleEmits.keys()]) cancelPendingIdleEmit(id)
    for (const id of [...observations.keys()]) stopObservation(id)
    trackers.clear()
  }

  return {
    initSessionObservers,
    bindHeadlessSession,
    onHookPayload,
    trackedState,
    onObservationAck,
    onProviderRebindAck,
    recordInputOrigin,
    clearSession,
    stopAllTails,
    disposeObservers,
    /** The live observation's adapter — how sessionId-scoped services (browser-
     *  open classification) reach harness-specific behavior. */
    adapterFor: (sessionId: string): HarnessAdapter | undefined =>
      observations.get(sessionId)?.adapter,
  }
}
