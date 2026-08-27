/**
 * Grok as a real server-family session over `grok agent stdio` (ACP).
 *
 * The child is process-per-session and its inherited pipes are the complete
 * transport: no port, socket, rendezvous file or correlation secret exists.
 * The daemon owns process launch and native-file export through the host port;
 * this package owns protocol, receipts, permissions, observation and resume.
 */
import {
  type AgentStateEvent,
  classifyGrokProviderFailure,
  initialAgentState,
  reduceAgentState,
  translateGrokUpdatePayload,
} from '@podium/harness'
import type { AgentRuntimeState, ResumeRef, SessionId, TranscriptItem } from '@podium/model'
import type { ObservationProvenance, ProviderCursor } from '@podium/protocol'
import type { QueueDrainAbandonedReason } from '@podium/protocol/daemon'
import type { AttachEndpoint, AttachRequest, SessionLease } from '../../attach.js'
import type {
  ArchiveFile,
  ProcessIdentity,
  SessionArchive,
  SessionBinding,
  SessionSnapshot,
} from '../../binding.js'
import type {
  ConfigureRequest,
  ScopeResources,
  SessionHealth,
  UsageSnapshot,
} from '../../capabilities.js'
import type { AgentSessionHandle, RuntimeDriver } from '../../driver.js'
import { DriverRefusalError } from '../../errors.js'
import {
  createRuntimeEventStream,
  type EventStreamStart,
  type RuntimeEvent,
  type RuntimeEventBody,
  type WatchLevel,
} from '../../events.js'
import { sessionHealth } from '../../health.js'
import type {
  InteractionAnswerOutcome,
  PendingInteraction,
  PermissionAnswer,
} from '../../interactions.js'
import type { OnQueueAbandoned } from '../../queue-abandonment.js'
import type { SessionSpec } from '../../session-spec.js'
import type { AnswerOptions, Refusal, SendOptions, TurnInput, TurnReceipt } from '../../turns.js'
import { stampRuntimeEvent } from '../terminal/envelope.js'
import { grokAcpCapabilities } from './capabilities.js'
import {
  createGrokAcpClient,
  type GrokAcpClient,
  type GrokAcpClientConfig,
  type GrokAcpServerRequest,
} from './client.js'
import {
  asPermissionAnswer,
  type GrokPermissionAsk,
  grokPermissionAction,
  grokPermissionAsk,
} from './map.js'
import {
  GROK_ACP_METHODS,
  type GrokAcpFrame,
  GrokAcpPermissionRequest,
  type GrokAcpPromptResult,
  GrokAcpPromptResult as GrokAcpPromptResultSchema,
  GrokAcpRpcError,
  GrokAcpSessionResult,
  grokAcpEventOrdinal,
  parseGrokAcpSessionUpdate,
} from './protocol.js'

export const GROK_ACP_DRIVER_ID = 'grok-acp'
export const GROK_ACP_EVENT_LOG_LIMIT = 512
const WHEN_READY_TIMEOUT_MS = 10 * 60_000

export interface GrokAcpEndpoint {
  transport: GrokAcpClientConfig['transport']
  process: ProcessIdentity
  stop(): Promise<void>
  kill(): Promise<void>
  /** Resource truth for this session's scope — memory, tasks, and the kernel's
   *  own OOM-kill counter. `undefined` where there is no cgroup to read. */
  resources(): ScopeResources | undefined
  alive(): boolean
}

export interface GrokAcpRuntimeHost {
  launch(input: {
    sessionId: SessionId
    workdir: string
    env?: Readonly<Record<string, string>>
  }): Promise<GrokAcpEndpoint>
  readArchive?(input: {
    sessionId: SessionId
    grokSessionId: string
    workdir: string
  }): Promise<readonly ArchiveFile[] | undefined>
  attachClient?(input: {
    sessionId: SessionId
    grokSessionId: string
    mode: AttachRequest['mode']
  }): Promise<{ streamId: string; warmTtlMs: number } | undefined>
  /**
   * TURNS THIS DRIVER ACCEPTED AND WILL NEVER DELIVER (POD-2297).
   *
   * The server family's counterpart to `TerminalInjectionPorts.onDrainAbandoned`
   * — see `../../queue-abandonment.ts`. Optional; the daemon's adapter logs every
   * abandonment either way.
   */
  onQueueAbandoned?: OnQueueAbandoned
  /** Opt-in wire evidence for a provider failure. The client has already
   * parsed the JSON-RPC frame, but no classification or projection has run. */
  onRawFrame?(sessionId: SessionId, frame: GrokAcpFrame): void
  journal: GrokAcpJournal
  now(): number
  mintSessionId(): SessionId
  makeClient?(config: GrokAcpClientConfig): GrokAcpClient
}

export interface GrokAcpJournalEntry {
  sessionId: SessionId
  grokSessionId: string
  workdir: string
  process: ProcessIdentity
  providerEventSeq: number
  seq: number
  turnEpoch: number
  bindingVersion: number
}

export interface GrokAcpJournal {
  read(sessionId: SessionId): GrokAcpJournalEntry | undefined
  write(entry: GrokAcpJournalEntry): void
  clear(sessionId: SessionId): void
}

interface QueuedTurn {
  input: TurnInput
  options: SendOptions
}

interface DriverSession {
  sessionId: SessionId
  spec: SessionSpec
  endpoint: GrokAcpEndpoint
  client: GrokAcpClient
  grokSessionId: string
  binding: SessionBinding
  observerGeneration: number
  turnEpoch: number
  openTurnEpoch: number | undefined
  providerEventSeq: number
  lastEventId: string | undefined
  seq: number
  busy: boolean
  /** The exact open prompt epoch for which Podium sent `session/cancel`. */
  interruptRequestedEpoch: number | undefined
  loading: boolean
  interactions: Map<string, GrokPermissionAsk>
  answered: Set<string>
  queue: QueuedTurn[]
  lease: SessionLease | null
  draft: string
  watchers: { coarse: number; fine: number }
  log: { seq: number; event: RuntimeEvent }[]
  wakers: Set<() => void>
  idleWaiters: Set<() => void>
  state: AgentRuntimeState
  transcriptItems: TranscriptItem[]
  transcriptIds: Set<string>
  userBuffer: { id: string; text: string; at: string } | undefined
  assistantBuffer: { id: string; text: string; at: string } | undefined
  ignoreUserEcho: string | undefined
  usage: UsageSnapshot
  disposed: boolean
  ingestChain: Promise<void>
  lastTurnFailure?: {
    turnEpoch: number
    change: Extract<AgentStateEvent, { kind: 'turn_failed' }>
  }
}

export interface GrokAcpRuntime {
  driver: RuntimeDriver
  createWithId(sessionId: SessionId, spec: SessionSpec): Promise<AgentSessionHandle>
  handleFor(sessionId: SessionId): AgentSessionHandle | undefined
  bindings(): readonly AgentSessionHandle['binding'][]
  has(sessionId: SessionId): boolean
  readonly journal: GrokAcpJournal
  /**
   * THE SUPERVISOR OBSERVED A KERNEL OOM KILL in this session's scope
   * (POD-2413).
   *
   * The fact enters through the DRIVER rather than going to the server
   * directly, because a runtime event without a causal envelope is not a
   * runtime event: only the driver holds this session's cursor, observer
   * generation and turn epoch. The supervisor knows WHAT happened; the driver
   * is what can say it in the stream's own language.
   *
   * Not a death. `OOMPolicy=continue` means the kernel killed one process
   * inside the tree and the session usually keeps serving; whether it died is
   * the `exited` arm's business.
   */
  reportOomKill(sessionId: SessionId, scopeUnit?: string): void
  forget(sessionId: SessionId): void
  dispose(): void
}

interface BufferedConnection {
  client: GrokAcpClient
  bind(handlers: {
    promptResult(result: GrokAcpPromptResult): void
    notification(frame: GrokAcpFrame): void
    request(request: GrokAcpServerRequest): void
    closed(): void
  }): void
}

export function createGrokAcpRuntime(host: GrokAcpRuntimeHost): GrokAcpRuntime {
  const sessions = new Map<SessionId, DriverSession>()
  const handles = new Map<SessionId, AgentSessionHandle>()
  const capabilities = grokAcpCapabilities()
  const iso = (ms?: number): string => new Date(ms ?? host.now()).toISOString()

  const cursorFor = (session: DriverSession): ProviderCursor => ({
    segmentId: session.grokSessionId || session.binding.process.key,
    ...(session.lastEventId ? { pathHint: session.lastEventId } : {}),
    components: { event: session.providerEventSeq, seq: session.seq },
  })

  const persist = (session: DriverSession): void => {
    host.journal.write({
      sessionId: session.sessionId,
      grokSessionId: session.grokSessionId,
      workdir: session.spec.workdir,
      process: session.binding.process,
      providerEventSeq: session.providerEventSeq,
      seq: session.seq,
      turnEpoch: session.turnEpoch,
      bindingVersion: session.binding.bindingVersion,
    })
  }

  function emit(
    session: DriverSession,
    body: RuntimeEventBody,
    at: string,
    provenance: ObservationProvenance = 'live',
    native?: { eventId?: string; ordinal?: number },
  ): void {
    if (session.disposed) return
    if (native?.ordinal !== undefined) {
      session.providerEventSeq = Math.max(session.providerEventSeq, native.ordinal)
    }
    if (native?.eventId) session.lastEventId = native.eventId
    session.seq += 1
    const event = stampRuntimeEvent(body, at, provenance, {
      cursor: cursorFor(session),
      observerGeneration: session.observerGeneration,
      turnEpoch: session.turnEpoch,
    })
    session.log.push({ seq: session.seq, event })
    if (session.log.length > GROK_ACP_EVENT_LOG_LIMIT) {
      session.log.splice(0, session.log.length - GROK_ACP_EVENT_LOG_LIMIT)
    }
    for (const wake of [...session.wakers]) wake()
    persist(session)
  }

  function foldState(
    session: DriverSession,
    change: AgentStateEvent,
    at: string,
    provenance: ObservationProvenance,
    native?: { eventId?: string; ordinal?: number },
  ): void {
    if (change.kind === 'turn_failed') {
      const turnEpoch = session.openTurnEpoch ?? session.turnEpoch
      const previous = session.lastTurnFailure
      if (
        previous?.turnEpoch === turnEpoch &&
        previous.change.errorClass === change.errorClass &&
        previous.change.retryable === change.retryable &&
        previous.change.detail === change.detail
      )
        return
      if (
        previous?.turnEpoch === turnEpoch &&
        (change.errorClass === 'unknown' || !change.detail) &&
        previous.change.errorClass !== 'unknown' &&
        !!previous.change.detail
      )
        return
      session.lastTurnFailure = { turnEpoch, change }
    }
    const next = reduceAgentState(session.state, change, at)
    if (next === session.state) return
    // A failed retry attempt is not the outcome of the turn if Grok later
    // reports a successful completion. Clear the causal failure only after the
    // completion actually wins the reducer, so a stale replay cannot erase a
    // live error.
    if (change.kind === 'turn_completed') session.lastTurnFailure = undefined
    session.state = next
    emit(session, { t: 'state', change }, at, provenance, native)
  }

  function addItem(
    session: DriverSession,
    item: TranscriptItem,
    at: string,
    provenance: ObservationProvenance,
    native?: { eventId?: string; ordinal?: number },
  ): void {
    if (session.transcriptIds.has(item.id)) {
      const index = session.transcriptItems.findIndex((candidate) => candidate.id === item.id)
      if (index >= 0) session.transcriptItems[index] = item
    } else {
      session.transcriptIds.add(item.id)
      session.transcriptItems.push(item)
    }
    emit(session, { t: 'item', item: { kind: 'complete', item } }, at, provenance, native)
  }

  function addInterruptMarker(session: DriverSession, epoch: number, at: string): void {
    const id = `grok-interrupt-${epoch}`
    if (session.transcriptIds.has(id)) return
    addItem(
      session,
      {
        id,
        role: 'user',
        text: '[Request interrupted by user]',
        ts: at,
        event: 'interrupt',
      },
      at,
      'live',
    )
  }

  function flushUser(
    session: DriverSession,
    provenance: ObservationProvenance,
    native?: { eventId?: string; ordinal?: number },
  ): void {
    const buffer = session.userBuffer
    if (!buffer) return
    session.userBuffer = undefined
    const text = buffer.text.trim()
    if (!text) return
    if (session.ignoreUserEcho && text === session.ignoreUserEcho.trim()) {
      session.ignoreUserEcho = undefined
      return
    }
    addItem(
      session,
      { id: buffer.id, role: 'user', text, ts: buffer.at },
      buffer.at,
      provenance,
      native,
    )
  }

  function flushAssistant(
    session: DriverSession,
    provenance: ObservationProvenance,
    native?: { eventId?: string; ordinal?: number },
  ): void {
    const buffer = session.assistantBuffer
    if (!buffer) return
    session.assistantBuffer = undefined
    const text = buffer.text.trim()
    if (!text) return
    addItem(
      session,
      { id: buffer.id, role: 'assistant', text, ts: buffer.at },
      buffer.at,
      provenance,
      native,
    )
  }

  const record = (value: unknown): Record<string, unknown> | undefined =>
    typeof value === 'object' && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : undefined

  function contentText(value: unknown): string {
    if (typeof value === 'string') return value
    if (Array.isArray(value)) return value.map(contentText).filter(Boolean).join('')
    const object = record(value)
    if (!object) return ''
    for (const key of ['text', 'content', 'delta', 'chunk']) {
      const text = contentText(object[key])
      if (text) return text
    }
    return ''
  }

  function updateText(update: Record<string, unknown>): string {
    for (const key of ['content', 'text', 'delta', 'chunk']) {
      const text = contentText(update[key])
      if (text) return text
    }
    return ''
  }

  function ingestTranscriptUpdate(
    session: DriverSession,
    update: Record<string, unknown>,
    at: string,
    provenance: ObservationProvenance,
    native: { eventId?: string; ordinal?: number },
  ): void {
    const kind = typeof update.sessionUpdate === 'string' ? update.sessionUpdate : ''
    switch (kind) {
      case 'user_message_chunk': {
        const text = updateText(update)
        if (!text) return
        const current = session.userBuffer
        if (current) current.text += text
        else {
          session.userBuffer = {
            id: `grok-user-${native.eventId ?? session.seq + 1}`,
            text,
            at,
          }
        }
        return
      }
      case 'agent_message_chunk': {
        flushUser(session, provenance, native)
        const text = updateText(update)
        if (!text) return
        const current = session.assistantBuffer
        if (current) current.text += text
        else {
          session.assistantBuffer = {
            id: `grok-assistant-${native.eventId ?? session.seq + 1}`,
            text,
            at,
          }
        }
        const buffer = session.assistantBuffer
        if (!buffer) return
        // NOT INTO A CLOSED TURN (POD-2293). `finishPrompt` clears
        // `openTurnEpoch`, so an absent one means the fence already landed and
        // the viewer already has the durable item — a fragment now could only
        // revive a preview that was correctly replaced. The absorb rule, stated
        // in fragment terms. The buffer still accumulates: a late chunk is real
        // transcript content and belongs in the flushed item, it is only the
        // live PREVIEW of it that has nowhere left to go.
        if (session.watchers.fine > 0 && session.openTurnEpoch !== undefined) {
          emit(
            session,
            {
              t: 'item',
              item: {
                kind: 'delta',
                itemId: buffer.id,
                textDelta: text,
              },
            },
            at,
            provenance,
            native,
          )
        }
        return
      }
      case 'tool_call': {
        flushUser(session, provenance, native)
        flushAssistant(session, provenance, native)
        const id =
          (typeof update.toolCallId === 'string' && update.toolCallId) ||
          (typeof update.tool_call_id === 'string' && update.tool_call_id) ||
          `grok-tool-${native.eventId ?? session.seq + 1}`
        const title = typeof update.title === 'string' ? update.title : undefined
        const kindName =
          (typeof update.kind === 'string' && update.kind) ||
          (typeof update.name === 'string' && update.name) ||
          'tool'
        const rawInput = update.rawInput ?? update.raw_input ?? update.input
        let toolInput: string | undefined
        try {
          toolInput = rawInput === undefined ? title : JSON.stringify(rawInput)
        } catch {
          toolInput = title
        }
        addItem(
          session,
          {
            id,
            role: 'tool',
            text: '',
            ts: at,
            toolName: kindName,
            ...(toolInput ? { toolInput } : {}),
            ...(title ? { toolTitle: title } : {}),
            toolUseId: id,
          },
          at,
          provenance,
          native,
        )
        return
      }
      case 'response_completed':
      case 'turn_completed':
        flushUser(session, provenance, native)
        flushAssistant(session, provenance, native)
        return
      default:
        return
    }
  }

  function ingestNotification(
    session: DriverSession,
    frame: GrokAcpFrame,
    provenance: ObservationProvenance,
  ): void {
    const notification = parseGrokAcpSessionUpdate(frame)
    if (!notification || notification.params.sessionId !== session.grokSessionId) return
    const eventId = notification.params._meta?.eventId
    const ordinal = grokAcpEventOrdinal(eventId)
    // Every event Podium treats as causal must carry the provider cursor. The
    // W7 probe found uncursored `_x.ai/*` side channels; they stay side channels.
    if (ordinal === undefined) return
    const at = iso(notification.params._meta?.agentTimestampMs)
    const native = { ...(eventId ? { eventId } : {}), ordinal }
    ingestTranscriptUpdate(session, notification.params.update, at, provenance, native)
    const payload = {
      ...frame,
      timestamp: at,
    }
    session.ingestChain = session.ingestChain.then(async () => {
      const changes = await translateGrokUpdatePayload(payload, { classifyIdleVerdict: false })
      for (const change of changes) foldState(session, change, change.at ?? at, provenance, native)
    })
  }

  function answeredBy(options?: AnswerOptions): 'policy' | 'superagent' | 'human' {
    return options?.principal?.kind === 'system'
      ? 'policy'
      : options?.principal?.kind === 'agent'
        ? 'superagent'
        : 'human'
  }

  function closeAsk(
    session: DriverSession,
    id: string,
    at: string,
    by: 'policy' | 'superagent' | 'human',
  ): void {
    if (!session.interactions.delete(id)) return
    emit(session, { t: 'interaction', ev: { ev: 'answered', id, answeredBy: by, at } }, at)
    foldState(session, { kind: session.busy ? 'activity' : 'turn_completed' }, at, 'live')
    if (!session.busy) void drainQueue(session)
  }

  function expireAsk(session: DriverSession, id: string, at: string): void {
    if (!session.interactions.delete(id)) return
    emit(session, { t: 'interaction', ev: { ev: 'expired', id, at } }, at)
  }

  function ingestServerRequest(session: DriverSession, request: GrokAcpServerRequest): void {
    if (request.method !== GROK_ACP_METHODS.requestPermission) {
      // fs/read_text_file cannot legitimately arrive because initialize
      // declares it false. Still answer every request so a vendor regression
      // becomes an error instead of a deadlocked turn.
      session.client.respondError(
        request.id,
        -32601,
        `Podium does not implement '${request.method}'`,
      )
      return
    }
    const parsed = GrokAcpPermissionRequest.safeParse(request.params)
    if (!parsed.success || parsed.data.sessionId !== session.grokSessionId) {
      session.client.respondError(request.id, -32602, 'invalid Grok permission request')
      return
    }
    const at = iso()
    const ask = grokPermissionAsk({
      requestId: request.id,
      request: parsed.data,
      podiumSessionId: session.sessionId,
      at,
    })
    session.interactions.set(ask.interaction.id, ask)
    emit(session, { t: 'interaction', ev: { ev: 'asked', interaction: ask.interaction } }, at)
    const payload = ask.interaction.payload
    if ('toolName' in payload) {
      foldState(
        session,
        {
          kind: 'needs_user',
          need: 'permission',
          summary: payload.inputSummary,
          ask: {
            toolName: payload.toolName,
            ...(payload.inputSummary ? { detail: payload.inputSummary } : {}),
            canAlwaysAllow: payload.canAlwaysAllow,
          },
        },
        at,
        'live',
      )
    }
  }

  function connect(endpoint: GrokAcpEndpoint, sessionId: SessionId): BufferedConnection {
    const promptResults: GrokAcpPromptResult[] = []
    const notifications: GrokAcpFrame[] = []
    const requests: GrokAcpServerRequest[] = []
    let sawClose = false
    let handlers:
      | {
          promptResult(result: GrokAcpPromptResult): void
          notification(frame: GrokAcpFrame): void
          request(request: GrokAcpServerRequest): void
          closed(): void
        }
      | undefined
    const make = host.makeClient ?? createGrokAcpClient
    const client = make({
      transport: endpoint.transport,
      onFrame(frame) {
        host.onRawFrame?.(sessionId, frame)
      },
      onResponse(method, frame) {
        if (method !== GROK_ACP_METHODS.sessionPrompt) return
        const result = GrokAcpPromptResultSchema.safeParse(frame.result)
        if (!result.success) return
        if (handlers) handlers.promptResult(result.data)
        else promptResults.push(result.data)
      },
      onNotification(frame) {
        if (handlers) handlers.notification(frame)
        else notifications.push(frame)
      },
      onServerRequest(request) {
        if (handlers) handlers.request(request)
        else requests.push(request)
      },
      onClose() {
        if (handlers) handlers.closed()
        else sawClose = true
      },
    })
    return {
      client,
      bind(next) {
        handlers = next
        for (const result of promptResults.splice(0)) next.promptResult(result)
        for (const frame of notifications.splice(0)) next.notification(frame)
        for (const request of requests.splice(0)) next.request(request)
        if (sawClose) next.closed()
      },
    }
  }

  function attachSession(input: {
    sessionId: SessionId
    spec: SessionSpec
    endpoint: GrokAcpEndpoint
    connection: BufferedConnection
    grokSessionId: string
    bindingVersion: number
    observerGeneration: number
    providerEventSeq?: number
    seq?: number
    turnEpoch?: number
  }): AgentSessionHandle {
    const now = iso()
    const state = reduceAgentState(initialAgentState(now), { kind: 'session_started' }, now)
    const session: DriverSession = {
      sessionId: input.sessionId,
      spec: input.spec,
      endpoint: input.endpoint,
      client: input.connection.client,
      grokSessionId: input.grokSessionId,
      binding: {
        sessionId: input.sessionId,
        driver: GROK_ACP_DRIVER_ID,
        family: 'server',
        harness: 'grok',
        workdir: input.spec.workdir,
        resume: { kind: 'grok-session', value: input.grokSessionId },
        process: input.endpoint.process,
        bindingVersion: input.bindingVersion,
      },
      observerGeneration: input.observerGeneration,
      turnEpoch: input.turnEpoch ?? 0,
      openTurnEpoch: undefined,
      providerEventSeq: input.providerEventSeq ?? 0,
      lastEventId: undefined,
      seq: input.seq ?? 0,
      busy: false,
      interruptRequestedEpoch: undefined,
      loading: false,
      interactions: new Map(),
      answered: new Set(),
      queue: [],
      lease: null,
      draft: '',
      watchers: { coarse: 0, fine: 0 },
      log: [],
      wakers: new Set(),
      idleWaiters: new Set(),
      state,
      transcriptItems: [],
      transcriptIds: new Set(),
      userBuffer: undefined,
      assistantBuffer: undefined,
      ignoreUserEcho: undefined,
      usage: {},
      disposed: false,
      ingestChain: Promise.resolve(),
    }
    registerSession(input.sessionId, session)
    const handle = buildHandle(session)
    handles.set(input.sessionId, handle)
    input.connection.bind({
      promptResult(result) {
        const epoch = session.openTurnEpoch
        if (
          session.disposed ||
          epoch === undefined ||
          result.stopReason !== 'cancelled' ||
          session.interruptRequestedEpoch !== epoch
        ) {
          return
        }
        /**
         * THE CONFIRMATION BOUNDARY, NOT THE PROMISE CONTINUATION (POD-2940).
         *
         * `onFrame` calls this synchronously before the JSON-RPC client resolves
         * `session/prompt`. A `.then` continuation runs in a later microtask,
         * and two real actions can land in that gap: a late interrupt request,
         * which must not claim an already-received provider cancellation, or a
         * stop/kill, which must not erase a cancellation already confirmed for
         * the user's request. Bind the marker to this prompt's epoch and persist
         * it now. The id guard makes a duplicated response observation inert.
         *
         * Transcript chunks are dispatched synchronously before the response
         * too. Flush them first so the marker remains the final user action
         * instead of appearing before the assistant text it interrupted.
         */
        const at = iso()
        flushUser(session, 'live')
        flushAssistant(session, 'live')
        addInterruptMarker(session, epoch, at)
      },
      notification(frame) {
        ingestNotification(session, frame, session.loading ? 'replay' : 'live')
      },
      request(request) {
        ingestServerRequest(session, request)
      },
      closed() {
        if (session.disposed) return
        const at = iso()
        emit(
          session,
          {
            t: 'process',
            ev: { ev: 'exited', code: null, signal: null, classification: 'crashed' },
          },
          at,
        )
        foldState(session, { kind: 'session_ended' }, at, 'live')
        /**
         * THE QUEUE DIED WITH THE CHILD (POD-2297).
         *
         * `disposed` stays false — that is the handle owner's call, and this arm
         * has always reported the process fact and stopped. The parked turns are
         * finished regardless: the state just folded to `session_ended` and every
         * remaining drain would prompt a link that is gone, while each sender
         * holds a `queued` receipt that POD-2291 made the ledger's last word.
         */
        abandonQueue(session, 'teardown')
      },
    })
    persist(session)
    return handle
  }

  function wakeIdle(session: DriverSession): void {
    for (const resolve of [...session.idleWaiters]) resolve()
    session.idleWaiters.clear()
  }

  async function waitForIdle(session: DriverSession): Promise<boolean> {
    if (!session.busy) return true
    return new Promise<boolean>((resolve) => {
      const done = (): void => {
        clearTimeout(timer)
        session.idleWaiters.delete(done)
        resolve(!session.busy)
      }
      const timer = setTimeout(done, WHEN_READY_TIMEOUT_MS)
      if (typeof timer === 'object' && 'unref' in timer) timer.unref()
      session.idleWaiters.add(done)
    })
  }

  type PromptFailure = {
    reason:
      | 'rate-limit'
      | 'auth-expired'
      | 'context-overflow'
      | 'provider-error'
      | 'timeout'
      | 'interrupted'
    disposition: 'retryable' | 'needs-human' | 'fatal'
    errorClass?: string
    detail?: string
  }

  function compactProviderDetail(value: string): string | undefined {
    const detail = value.replace(/\s+/g, ' ').trim()
    return detail ? detail.slice(0, 1000) : undefined
  }

  function nestedProviderDetail(value: unknown, seen = new Set<object>()): string | undefined {
    if (typeof value === 'string') return compactProviderDetail(value)
    if (value instanceof Error) return compactProviderDetail(value.message)
    if (typeof value !== 'object' || value === null) return undefined
    if (seen.has(value)) return undefined
    seen.add(value)
    if (Array.isArray(value)) {
      for (const entry of value) {
        const detail = nestedProviderDetail(entry, seen)
        if (detail) return detail
      }
      return undefined
    }
    const record = value as Record<string, unknown>
    for (const key of [
      'message',
      'detail',
      'agent_result',
      'reason',
      'description',
      'error',
      'data',
    ]) {
      const detail = nestedProviderDetail(record[key], seen)
      if (detail) return detail
    }
    return undefined
  }

  function promptResultDetail(result: GrokAcpPromptResult): string | undefined {
    return nestedProviderDetail(result)
  }

  function promptErrorDetail(error: unknown): string | undefined {
    if (error instanceof GrokAcpRpcError) {
      const status = error.code >= 400 && error.code <= 599 ? `status ${error.code}` : undefined
      const detail = nestedProviderDetail(error.data)
      const message = compactProviderDetail(error.message.replace(/^grok ACP [^:]+:\s*/i, ''))
      return compactProviderDetail([status, detail ?? message].filter(Boolean).join(': '))
    }
    return nestedProviderDetail(error)
  }

  function promptFailureFromDetail(detail: string): PromptFailure {
    return causalTurnFailure(classifyGrokProviderFailure({ agent_result: detail }))
  }

  function promptFailure(result: GrokAcpPromptResult): PromptFailure | null {
    if (result.stopReason === 'end_turn') return null
    if (result.stopReason === 'cancelled')
      return { reason: 'interrupted', disposition: 'retryable' }
    const detail = promptResultDetail(result)
    if (detail) return promptFailureFromDetail(detail)
    return {
      reason: 'provider-error',
      disposition: result.stopReason === 'max_tokens' ? 'retryable' : 'fatal',
      errorClass: result.stopReason,
    }
  }

  function promptFailureFromError(error: unknown): PromptFailure {
    const detail = promptErrorDetail(error)
    if (detail) return promptFailureFromDetail(detail)
    return {
      reason: 'provider-error',
      disposition: 'retryable',
      errorClass: 'provider_error',
    }
  }

  /** Translate the already-normalized state failure back to the causal turn
   * event. The two events are one provider failure: state carries the richer
   * harness class, while the turn contract carries disposition and detail. */
  function causalTurnFailure(
    change: Extract<AgentStateEvent, { kind: 'turn_failed' }>,
  ): PromptFailure {
    const errorClass = change.errorClass.toLowerCase()
    const reason: PromptFailure['reason'] =
      /auth|login|credential|unauthor|forbidden|api[_-]?key/.test(errorClass)
        ? 'auth-expired'
        : /context|overflow|too[_-]?long|token[_-]?limit/.test(errorClass)
          ? 'context-overflow'
          : /rate[_-]?limit|429/.test(errorClass)
            ? 'rate-limit'
            : /timeout|timed[_-]?out/.test(errorClass)
              ? 'timeout'
              : 'provider-error'
    return {
      reason,
      disposition: change.retryable ? 'retryable' : 'needs-human',
      errorClass: change.errorClass,
      ...(change.detail ? { detail: change.detail } : {}),
    }
  }

  function updateUsage(session: DriverSession, result: GrokAcpPromptResult): void {
    const usage = result._meta?.usage
    if (!usage) return
    session.usage = {
      ...(usage.inputTokens !== undefined ? { inputTokens: usage.inputTokens } : {}),
      ...(usage.outputTokens !== undefined ? { outputTokens: usage.outputTokens } : {}),
      ...(usage.costUsdTicks !== undefined ? { costUsd: usage.costUsdTicks / 10_000_000_000 } : {}),
    }
  }

  async function finishPrompt(
    session: DriverSession,
    epoch: number,
    result: GrokAcpPromptResult | undefined,
    error?: unknown,
  ): Promise<void> {
    if (session.disposed || session.openTurnEpoch !== epoch) return
    // ACP sends the provider update before its prompt response. Wait for the
    // already-enqueued translation so the response settlement cannot overwrite
    // a richer causal failure with its generic stop reason.
    await session.ingestChain.catch(() => undefined)
    if (session.disposed || session.openTurnEpoch !== epoch) return
    const at = iso()
    flushUser(session, 'live')
    flushAssistant(session, 'live')
    session.busy = false
    session.openTurnEpoch = undefined
    if (session.interruptRequestedEpoch === epoch) session.interruptRequestedEpoch = undefined
    if (result) updateUsage(session, result)
    // A retry_state failure may describe an attempt that Grok recovered before
    // the prompt response. Do not carry that attempt into a successful turn.
    if (result?.stopReason === 'end_turn') session.lastTurnFailure = undefined
    const translatedFailure =
      session.lastTurnFailure?.turnEpoch === epoch
        ? causalTurnFailure(session.lastTurnFailure.change)
        : undefined
    const failure =
      translatedFailure ??
      (result
        ? promptFailure(result)
        : error !== undefined
          ? promptFailureFromError(error)
          : {
              reason: 'provider-error' as const,
              disposition: 'retryable' as const,
              errorClass: 'provider_error',
            })
    if (!failure) {
      emit(session, { t: 'turn', ev: { ev: 'completed', turnEpoch: epoch, verdict: 'done' } }, at)
      foldState(session, { kind: 'turn_completed' }, at, 'live')
    } else {
      emit(
        session,
        {
          t: 'turn',
          ev: {
            ev: 'failed',
            turnEpoch: epoch,
            reason: failure.reason,
            disposition: failure.disposition,
            ...(failure.detail
              ? { detail: failure.detail }
              : result?.stopReason
                ? { detail: result.stopReason }
                : error !== undefined
                  ? { detail: String(error) }
                  : {}),
          },
        },
        at,
      )
      if (!translatedFailure) {
        foldState(
          session,
          failure.reason === 'interrupted'
            ? { kind: 'turn_completed', verdict: { kind: 'interrupted' } }
            : {
                kind: 'turn_failed',
                errorClass: failure.errorClass ?? result?.stopReason ?? 'provider_error',
                retryable: failure.disposition === 'retryable',
                ...(failure.detail ? { detail: failure.detail } : {}),
              },
          at,
          'live',
        )
      }
    }
    wakeIdle(session)
    void drainQueue(session)
  }

  function startPrompt(
    session: DriverSession,
    input: TurnInput,
    options: SendOptions,
    deliveredAs: 'when-ready' | 'queue' | 'interrupt',
  ): TurnReceipt {
    const at = iso()
    const promise = session.client.call<unknown>(GROK_ACP_METHODS.sessionPrompt, {
      sessionId: session.grokSessionId,
      prompt: [{ type: 'text', text: input.text }],
    })
    session.turnEpoch += 1
    const epoch = session.turnEpoch
    session.openTurnEpoch = epoch
    session.interruptRequestedEpoch = undefined
    session.lastTurnFailure = undefined
    session.busy = true
    session.ignoreUserEcho = input.text
    addItem(
      session,
      { id: `grok-user-turn-${epoch}`, role: 'user', text: input.text, ts: at },
      at,
      'live',
    )
    foldState(session, { kind: 'prompt_submitted' }, at, 'live')
    emit(
      session,
      { t: 'turn', ev: { ev: 'started', turnEpoch: epoch, origin: options.origin } },
      at,
    )
    void promise.then(
      (raw) => finishPrompt(session, epoch, GrokAcpPromptResultSchema.parse(raw)),
      (error) => finishPrompt(session, epoch, undefined, error),
    )
    return {
      outcome: 'accepted',
      turnEpoch: epoch,
      deliveredAs,
      provenBy: 'protocol-ack',
      at,
    }
  }

  /**
   * THE ONE CALL TO THE HOST'S PORT, AND THE ONE GUARD AROUND IT
   * (POD-2297 review, 2).
   *
   * `endSession` is the FIRST statement of `stop`/`kill`/`hibernate`, and this
   * port is not cheap: the daemon's implementation fsyncs a durable outbox, so
   * ENOSPC, EDQUOT, EIO and a reportId collision all reach here as exceptions.
   * Letting one propagate would skip `client.close()`, `endpoint.stop()` and the
   * map deletes that follow — a live `grok agent stdio` child with nobody holding it,
   * which is a worse failure than the one being reported — and inside
   * `dispose()` it would abandon every remaining session mid-loop.
   *
   * SWALLOWING IS SAFE HERE, and only because of where the log line lives: the
   * daemon's adapter writes its `warn` BEFORE it tries to make the report
   * durable, so a turn whose report cannot be persisted has still been said out
   * loud. Silence is what this issue closes; the durable correction is the part
   * that can fail, and the host owns saying so.
   *
   * CALLERS HAVE ALREADY GIVEN THE TURNS UP by the time they reach here, so
   * report-is-the-point-of-no-return holds however this returns.
   */
  function reportAbandoned(
    session: DriverSession,
    turns: readonly QueuedTurn[],
    reason: QueueDrainAbandonedReason,
  ): void {
    if (turns.length === 0) return
    try {
      host.onQueueAbandoned?.({ sessionId: session.sessionId, turns, reason })
    } catch {
      // Intentionally terminal: see above.
    }
  }

  /**
   * SAY WHAT THIS SESSION IS LOSING (POD-2297).
   *
   * `host.onQueueAbandoned` is the server family's `onDrainAbandoned`, and its
   * one rule is the terminal port's: THE REPORT IS THE POINT OF NO RETURN. So
   * the turns leave `session.queue` here, in the same statement that hands them
   * over.
   */
  function abandonQueue(session: DriverSession, reason: QueueDrainAbandonedReason): void {
    if (session.queue.length === 0) return
    const turns = session.queue.splice(0, session.queue.length)
    reportAbandoned(session, turns, reason)
  }

  /**
   * THIS SESSION CAN NO LONGER DRAIN — the one place that becomes true, so the
   * one place its queue's fate is stated. Every caller used to be a bare
   * `session.disposed = true` that discarded the queue against a caller holding
   * a `queued` receipt.
   */
  function endSession(session: DriverSession): void {
    session.disposed = true
    abandonQueue(session, 'teardown')
    /**
     * RELEASE ANYONE WAITING ON A SESSION THAT WILL NEVER ANSWER
     * (POD-2297 review, low 2).
     *
     * A `when-ready` send parks on these waiters for up to
     * WHEN_READY_TIMEOUT_MS. Ending the session without waking them left such a
     * caller blocked on a full timeout for an answer that could not come — the
     * same state-the-fate-promptly instinct this whole issue is about, one layer
     * up. Each waiter re-evaluates its own predicate, so waking them turns a
     * ten-minute hang into the immediate refusal the caller should have had.
     */
    wakeIdle(session)
    /**
     * THE HANDLE IS GONE BEFORE THE PROCESS FINISHES GOING AWAY (POD-2942).
     *
     * A park flips the server row before this driver's asynchronous `stop()`
     * has finished waiting for Grok's child. Resurrection can therefore arrive
     * during that wait. Leaving this disposed handle indexed made the daemon
     * mistake the resurrection for a duplicate live spawn instead of loading
     * the journalled native session. The old `stop()` then deleted by session id
     * after its await, which could erase the replacement handle too.
     *
     * Unregister at the synchronous disposal boundary, and only when THIS
     * session is still the indexed owner. `registerSession` also ends a
     * displaced object; the identity guard prevents that old object from ever
     * deleting the replacement installed after it.
     */
    if (sessions.get(session.sessionId) === session) {
      sessions.delete(session.sessionId)
      handles.delete(session.sessionId)
    }
  }

  /**
   * REGISTER A SESSION UNDER AN ID, REPORTING WHATEVER IT DISPLACES (POD-2297).
   *
   * `sessions.set` is the OTHER way a session stops draining, and the one the
   * first round of this issue missed. Every `disposed = true` goes through
   * `endSession`, but `adopt()` does not set `disposed` at all — it builds a
   * fresh session object and puts it in the map, and when the id is already
   * there the live object is simply overwritten and garbage-collected with its
   * queue still in it.
   *
   * THAT IS A HOT PATH, NOT A CORNER. The daemon's reattach runs
   * `adoptServerDriverSession` before any live-session check and a server
   * reconnect can re-send a hundred reattaches at once, so a browser refresh
   * was enough to lose nudges parked behind a human's take-over lease — exactly
   * the loss this issue exists to end, through a door it had left open.
   *
   * THE DISPLACED OBJECT IS ENDED, NOT JUST DRAINED. `endSession` also marks it
   * disposed, which is what stops its own loops reading a session nobody can
   * reach any more. What it deliberately does NOT do is close the client or the
   * endpoint: an adopt re-binds the SAME child, and tearing down its transport
   * here would kill the process the new session is about to speak to.
   */
  function registerSession(sessionId: SessionId, session: DriverSession): void {
    const displaced = sessions.get(sessionId)
    if (displaced && displaced !== session) endSession(displaced)
    sessions.set(sessionId, session)
  }

  async function drainQueue(session: DriverSession): Promise<void> {
    if (
      session.disposed ||
      session.busy ||
      session.interactions.size > 0 ||
      session.queue.length === 0
    ) {
      return
    }
    if (session.lease?.kind === 'human-controller') return
    const queued = session.queue.shift()
    if (!queued) return
    try {
      startPrompt(session, queued.input, queued.options, 'queue')
    } catch {
      /**
       * UNLIKE codex AND opencode, THIS FAMILY'S SEND FAILURE IS NORMALLY A TURN
       * EVENT: `startPrompt` opens the turn synchronously — epoch, `started`,
       * transcript item — and a rejected `session/prompt` reaches the caller
       * through `finishPrompt` as a turn FAILURE, which is honest because a turn
       * really did open.
       *
       * This arm is the other case: `startPrompt` threw before any of that, so
       * no turn opened, nothing was emitted, and the shifted turn would simply
       * cease to exist (as a rejected promise `void drainQueue` never reads).
       * That is the POD-2297 shape, and it gets the POD-2297 answer.
       */
      reportAbandoned(session, [queued], 'delivery-failed')
    }
  }

  function buildHandle(session: DriverSession): AgentSessionHandle {
    const refused = (reason: Refusal['reason'], detail?: string): TurnReceipt => ({
      outcome: 'refused',
      refusal: { reason, ...(detail ? { detail } : {}) },
    })

    return {
      get binding() {
        return session.binding
      },

      async stop() {
        endSession(session)
        session.client.close()
        await session.endpoint.stop()
        wakeIdle(session)
      },

      async hibernate() {
        if (!session.binding.resume) return { reason: 'no_resume_ref' as const }
        endSession(session)
        session.client.close()
        await session.endpoint.stop()
        wakeIdle(session)
        return { ok: true as const }
      },

      async kill() {
        endSession(session)
        session.client.close()
        await session.endpoint.kill()
        host.journal.clear(session.sessionId)
        wakeIdle(session)
      },

      async health(): Promise<SessionHealth> {
        return sessionHealth({
          alive: session.endpoint.alive(),
          resources: session.endpoint.resources(),
          ...(session.binding.process.scopeUnit
            ? { scopeUnit: session.binding.process.scopeUnit }
            : {}),
        })
      },

      async snapshot(): Promise<SessionSnapshot> {
        return {
          binding: session.binding,
          state: session.state,
          cursor: cursorFor(session),
          observerGeneration: session.observerGeneration,
          turnEpoch: session.turnEpoch,
          interactions: [...session.interactions.values()].map((ask) => ask.interaction),
          ...(session.draft ? { draft: session.draft } : {}),
          at: iso(),
        }
      },

      async export(): Promise<SessionArchive> {
        /**
         * TWO WORLDS HID BEHIND ONE `!files`, AND THEY CALL FOR OPPOSITE ANSWERS
         * (POD-2703, review 2).
         *
         * This arm used to answer `unsupported` to both, which is the
         * classification backwards on the common one. `unsupported` means never;
         * a caller that reads it stops asking. Grok writes `updates.jsonl` and
         * its siblings AS THE CONVERSATION HAPPENS, so a session that has not
         * spoken yet has no files — and answering "never" there talks a caller
         * out of the retry that would have worked. Getting this backwards is
         * worse than leaving it untyped: an untyped throw is at least not
         * trusted.
         */
        if (!host.readArchive) {
          // PERMANENT, for this machine's wiring: no reader exists, so no turn
          // and no wait will produce one. `unsupported` is the honest answer and
          // the caller is right to stop asking.
          throw new DriverRefusalError(
            { reason: 'unsupported', detail: 'this host wires no Grok session-file reader' },
            'grok-acp export',
          )
        }
        const files = await host.readArchive({
          sessionId: session.sessionId,
          grokSessionId: session.grokSessionId,
          workdir: session.spec.workdir,
        })
        if (!files || files.length === 0) {
          // NOT YET. The reader is there and the harness has written nothing to
          // read. Refused rather than answered with an empty archive, because a
          // backup that reports success carrying nothing is the failure this
          // whole refusal exists to make visible — but refused as a condition
          // that CLEARS, which is what a caller needs to know.
          throw new DriverRefusalError(
            {
              reason: 'no_archive_yet',
              detail: "Grok has not written this session's files yet",
            },
            'grok-acp export',
          )
        }
        const resume: ResumeRef = { kind: 'grok-session', value: session.grokSessionId }
        return {
          harness: 'grok',
          formatVersion: 1,
          resume,
          files,
          binding: {
            sessionId: session.sessionId,
            driver: GROK_ACP_DRIVER_ID,
            family: 'server',
            harness: 'grok',
            workdir: session.spec.workdir,
            resume,
            ...(session.binding.principal ? { principal: session.binding.principal } : {}),
          },
        }
      },

      async send(input: TurnInput, options: SendOptions): Promise<TurnReceipt> {
        if (session.disposed || !session.endpoint.alive()) return refused('not_running')
        if (session.interactions.size > 0) return refused('needs_user')
        if (!input.text.trim()) return refused('unsupported', 'Grok ACP requires a text prompt')
        if (input.attachments?.length) {
          return refused('unsupported', 'Grok ACP attachment mapping is not implemented')
        }
        const deliveredAs = options.delivery === 'steer' ? 'queue' : options.delivery
        if (session.lease?.kind === 'human-controller') {
          session.queue.push({ input, options })
          return {
            outcome: 'queued',
            position: session.queue.length,
            deliveredAs: 'queue',
            at: iso(),
          }
        }
        if (session.busy) {
          /**
           * THE SESSION MAY HAVE ENDED WHILE THIS SEND WAS PARKED
           * (POD-2297 review, low 3). Governs the `not_running` re-check in BOTH
           * arms below, which is why it sits here rather than being said twice.
           *
           * Each arm awaits `waitForIdle`, and an adopt, a stop or a kill can
           * land inside that await. Without the re-check the send delivered
           * through a session nobody can reach any more and answered `accepted`
           * carrying the DEAD object's turnEpoch — an epoch no consumer can match
           * to anything. The entry guard cannot cover it: that ran before the
           * await.
           */
          if (options.delivery === 'interrupt') {
            await this.interrupt()
            if (!(await waitForIdle(session)))
              return refused('busy', 'Grok did not confirm cancellation')
            if (session.disposed || !session.endpoint.alive()) return refused('not_running')
            return startPrompt(session, input, options, 'interrupt')
          }
          if (options.delivery === 'when-ready') {
            if (!(await waitForIdle(session))) return refused('busy', 'Grok turn did not finish')
            if (session.interactions.size > 0) return refused('needs_user')
            if (session.disposed || !session.endpoint.alive()) return refused('not_running')
            return startPrompt(session, input, options, 'when-ready')
          }
          session.queue.push({ input, options })
          return {
            outcome: 'queued',
            position: session.queue.length,
            deliveredAs: 'queue',
            at: iso(),
          }
        }
        return startPrompt(session, input, options, deliveredAs)
      },

      async stageAttachment() {
        return {
          reason: 'unsupported',
          detail: 'Grok ACP reports promptCapabilities.image=false and no file input',
        }
      },

      async interrupt() {
        if (!session.busy || session.disposed) return
        session.interruptRequestedEpoch = session.openTurnEpoch
        for (const [id, ask] of [...session.interactions]) {
          session.client.respond(ask.requestId, { outcome: { outcome: 'cancelled' } })
          expireAsk(session, id, iso())
        }
        // ACP defines session/cancel as a notification. The pending
        // session/prompt response carrying stopReason=cancelled is the fence.
        session.client.notify(GROK_ACP_METHODS.sessionCancel, {
          sessionId: session.grokSessionId,
        })
      },

      async answer(
        interactionId: string,
        answer: unknown,
        options?: AnswerOptions,
      ): Promise<InteractionAnswerOutcome> {
        if (session.answered.has(interactionId)) {
          return { ok: false, reason: 'already-answered' }
        }
        const ask = session.interactions.get(interactionId)
        if (!ask) return { ok: false, reason: 'unknown-interaction' }
        if (
          typeof answer === 'object' &&
          answer !== null &&
          'index' in answer &&
          typeof answer.index === 'number'
        ) {
          const option = ask.request.options[answer.index]
          if (!option) {
            return {
              ok: false,
              reason: 'not-yet-supported',
              detail: 'permission option index is unavailable',
            }
          }
          try {
            session.client.respond(ask.requestId, {
              outcome: { outcome: 'selected', optionId: option.optionId },
            })
          } catch (error) {
            return { ok: false, reason: 'delivery-failed', detail: String(error) }
          }
          session.answered.add(interactionId)
          closeAsk(session, interactionId, iso(), answeredBy(options))
          return { ok: true }
        }
        const normalized: PermissionAnswer | undefined =
          asPermissionAnswer(answer) ??
          (typeof answer === 'object' && answer !== null && 'decision' in answer
            ? {
                kind: 'permission',
                decision:
                  answer.decision === 'allow' || answer.decision === 'once'
                    ? 'allow-once'
                    : answer.decision === 'always'
                      ? 'allow-always'
                      : answer.decision === 'deny' || answer.decision === 'reject'
                        ? 'deny'
                        : ('' as 'deny'),
              }
            : undefined)
        if (!normalized || !['allow-once', 'allow-always', 'deny'].includes(normalized.decision)) {
          return {
            ok: false,
            reason: 'not-yet-supported',
            detail: 'permission answer shape mismatch',
          }
        }
        const action = grokPermissionAction(ask, normalized)
        if (!action.ok) {
          return { ok: false, reason: 'not-yet-supported', detail: action.refusal.detail }
        }
        try {
          session.client.respond(ask.requestId, {
            outcome: { outcome: 'selected', optionId: action.option.optionId },
          })
        } catch (error) {
          return { ok: false, reason: 'delivery-failed', detail: String(error) }
        }
        session.answered.add(interactionId)
        closeAsk(session, interactionId, iso(), answeredBy(options))
        return { ok: true }
      },

      async interactions(): Promise<readonly PendingInteraction[]> {
        return [...session.interactions.values()].map((ask) => ask.interaction)
      },

      events(after: EventStreamStart): AsyncIterable<RuntimeEvent> {
        return createRuntimeEventStream(after, {
          log: session.log,
          wakers: session.wakers,
          currentSeq: () => session.seq,
          isDisposed: () => session.disposed,
        })
      },

      async watch(level: WatchLevel): Promise<() => void> {
        session.watchers[level] += 1
        let released = false
        return () => {
          if (released) return
          released = true
          session.watchers[level] = Math.max(0, session.watchers[level] - 1)
        }
      },

      async state() {
        return session.state
      },

      transcript: {
        async history(range): Promise<readonly TranscriptItem[]> {
          if (!range.from || range.from.segmentId !== session.grokSessionId) {
            return session.transcriptItems.slice(-range.limit)
          }
          const anchor = range.from.components.item
          if (anchor === undefined) return session.transcriptItems.slice(-range.limit)
          return session.transcriptItems.slice(anchor + 1, anchor + 1 + range.limit)
        },
      },

      async attach(req: AttachRequest): Promise<AttachEndpoint | Refusal> {
        if (
          req.mode === 'takeover' &&
          session.lease &&
          (session.lease.holder !== req.holder || session.lease.kind !== 'human-controller')
        ) {
          return { reason: 'lease_held', detail: `control is held by ${session.lease.holder}` }
        }
        const previousLease = session.lease
        const acquired = req.mode === 'takeover' && previousLease == null
        if (acquired) {
          session.lease = {
            holder: req.holder,
            kind: 'human-controller',
            acquiredAt: iso(),
          }
        }
        let endpoint: Awaited<ReturnType<NonNullable<typeof host.attachClient>>>
        try {
          endpoint = await host.attachClient?.({
            sessionId: session.sessionId,
            grokSessionId: session.grokSessionId,
            mode: req.mode,
          })
        } catch (err) {
          if (acquired && session.lease?.holder === req.holder) session.lease = previousLease
          throw err
        }
        if (!endpoint) {
          if (acquired && session.lease?.holder === req.holder) session.lease = previousLease
          return {
            reason: 'unsupported',
            detail: 'this machine cannot host a Grok ACP client terminal',
          }
        }
        return {
          kind: 'client',
          placement: 'on-machine',
          stream: { id: endpoint.streamId },
          warm: { ttlMs: endpoint.warmTtlMs },
        }
      },

      lease: {
        async acquire(holder, kind) {
          if (session.lease && session.lease.holder !== holder) {
            return {
              reason: 'lease_held' as const,
              detail: `control is held by ${session.lease.holder}`,
            }
          }
          session.lease = { holder, kind, acquiredAt: iso() }
          return session.lease
        },
        async release(holder) {
          if (session.lease?.holder !== holder) return
          session.lease = null
          void drainQueue(session)
        },
        async state() {
          return session.lease
        },
      },

      draft: {
        async get() {
          return session.draft
        },
        async set(text) {
          session.draft = text
          return { ok: true as const }
        },
      },

      async configure(request: ConfigureRequest) {
        if (request.model !== undefined || request.effort !== undefined) {
          return {
            reason: 'unsupported' as const,
            detail: 'Grok ACP exposes no sticky model/effort RPC',
          }
        }
        if (request.permissionMode !== undefined) {
          try {
            await session.client.call(GROK_ACP_METHODS.sessionSetMode, {
              sessionId: session.grokSessionId,
              modeId: request.permissionMode,
            })
          } catch (error) {
            return { reason: 'unsupported' as const, detail: String(error) }
          }
        }
        return { ok: true as const }
      },

      async usage() {
        return session.usage
      },
    }
  }

  async function initializedConnection(
    endpoint: GrokAcpEndpoint,
    sessionId: SessionId,
  ): Promise<BufferedConnection> {
    const connection = connect(endpoint, sessionId)
    const initialized = await connection.client.initialize()
    if (initialized.agentCapabilities?.loadSession === false) {
      throw new Error('Grok ACP initialize declined session/load')
    }
    return connection
  }

  async function setInteractivePermissionMode(session: DriverSession): Promise<void> {
    try {
      // A user's config may default to auto-approve. `default` makes the
      // server→client permission channel authoritative for this session.
      await session.client.call(GROK_ACP_METHODS.sessionSetMode, {
        sessionId: session.grokSessionId,
        modeId: 'default',
      })
    } catch {
      // Older admitted builds may omit the optional mode switch. The ACP
      // permission request handler remains correct whenever an ask occurs.
    }
  }

  async function createWithId(
    sessionId: SessionId,
    spec: SessionSpec,
  ): Promise<AgentSessionHandle> {
    const endpoint = await host.launch({
      sessionId,
      workdir: spec.workdir,
      ...(spec.env ? { env: spec.env } : {}),
    })
    const connection = await initializedConnection(endpoint, sessionId)
    const created = GrokAcpSessionResult.parse(
      await connection.client.call(GROK_ACP_METHODS.sessionNew, {
        cwd: spec.workdir,
        mcpServers: [],
      }),
    )
    const handle = attachSession({
      sessionId,
      spec,
      endpoint,
      connection,
      grokSessionId: created.sessionId,
      bindingVersion: 1,
      observerGeneration: 1,
    })
    const session = sessions.get(sessionId)
    if (session) await setInteractivePermissionMode(session)
    if (spec.initialPrompt) {
      await handle.send({ text: spec.initialPrompt }, { origin: 'human', delivery: 'when-ready' })
    }
    return handle
  }

  async function loadSession(input: {
    sessionId: SessionId
    spec: SessionSpec
    grokSessionId: string
    bindingVersion: number
    observerGeneration: number
    providerEventSeq?: number
    seq?: number
    turnEpoch?: number
  }): Promise<AgentSessionHandle> {
    const endpoint = await host.launch({
      sessionId: input.sessionId,
      workdir: input.spec.workdir,
      ...(input.spec.env ? { env: input.spec.env } : {}),
    })
    const connection = await initializedConnection(endpoint, input.sessionId)
    const handle = attachSession({
      ...input,
      endpoint,
      connection,
    })
    const session = sessions.get(input.sessionId)
    if (!session) throw new Error('Grok ACP session disappeared during load')
    session.loading = true
    try {
      await connection.client.call(GROK_ACP_METHODS.sessionLoad, {
        sessionId: input.grokSessionId,
        cwd: input.spec.workdir,
        mcpServers: [],
      })
      await session.ingestChain
    } finally {
      session.loading = false
    }
    await setInteractivePermissionMode(session)
    return handle
  }

  const adoptedSpec = (workdir: string): SessionSpec => ({
    harness: 'grok',
    selection: { auth: 'subscription', platform: 'linux', available: [GROK_ACP_DRIVER_ID] },
    workdir,
    model: {},
    instructions: { supported: false, reason: 'adopted session carries its own context' },
    mcpServers: { supported: false, reason: 'adopted session carries its own config' },
  })

  const driver: RuntimeDriver = {
    id: GROK_ACP_DRIVER_ID,
    harness: 'grok',
    family: 'server',
    capabilities: () => capabilities,
    create: (spec) => createWithId(host.mintSessionId(), spec),
    resume: (ref, spec) =>
      loadSession({
        sessionId: host.mintSessionId(),
        spec,
        grokSessionId: ref.value,
        bindingVersion: 1,
        observerGeneration: 1,
      }),
    async adopt(binding) {
      const entry = host.journal.read(binding.sessionId)
      if (!entry) {
        throw new Error(
          `grok-acp cannot adopt ${binding.sessionId}: no binding journal entry to resume from`,
        )
      }
      if (entry.process.key !== binding.process.key) {
        throw new Error(
          `grok-acp cannot adopt ${binding.sessionId}: journal names process ${entry.process.key}, binding names ${binding.process.key}`,
        )
      }
      const handle = await loadSession({
        sessionId: binding.sessionId,
        spec: adoptedSpec(entry.workdir),
        grokSessionId: entry.grokSessionId,
        bindingVersion: binding.bindingVersion + 1,
        observerGeneration: binding.bindingVersion + 1,
        providerEventSeq: entry.providerEventSeq,
        seq: entry.seq,
        turnEpoch: entry.turnEpoch,
      })
      const session = sessions.get(binding.sessionId)
      if (session) {
        emit(
          session,
          { t: 'process', ev: { ev: 'adopted', bindingVersion: session.binding.bindingVersion } },
          iso(),
        )
      }
      return handle
    },
  }

  return {
    driver,
    createWithId,
    journal: host.journal,
    handleFor: (sessionId) => handles.get(sessionId),
    has: (sessionId) => handles.has(sessionId),
    bindings: () => [...handles.values()].map((handle) => handle.binding),
    reportOomKill: (sessionId, scopeUnit) => {
      const session = sessions.get(sessionId)
      if (!session) return
      emit(
        session,
        { t: 'process', ev: { ev: 'oomKilled', ...(scopeUnit ? { scopeUnit } : {}) } },
        iso(),
      )
    },
    forget(sessionId) {
      const session = sessions.get(sessionId)
      if (!session) return
      endSession(session)
      wakeIdle(session)
    },
    dispose() {
      for (const session of sessions.values()) {
        endSession(session)
        session.client.close()
        wakeIdle(session)
      }
      sessions.clear()
      handles.clear()
    },
  }
}
