import type { AgentRuntimeState, ResumeRef, SessionId, TranscriptItem } from '@podium/model'
import type { ProviderCursor } from '@podium/protocol'
import { PermissionAnswer } from '@podium/protocol'
import type { QueueDrainAbandonedReason } from '@podium/protocol/daemon'
import { DriverRefusalError } from '../../errors.js'
import { createRuntimeEventStream } from '../../events.js'
import type {
  AgentSessionHandle,
  AttachmentStageResult,
  EventStreamStart,
  InteractionAnswerOutcome,
  InteractionAskSpec,
  ModelPolicy,
  PendingInteraction,
  ProcessEvent,
  Refusal,
  RuntimeDriver,
  RuntimeEvent,
  RuntimeEventBody,
  SendOptions,
  SessionArchive,
  SessionBinding,
  SessionHealth,
  SessionLease,
  SessionSnapshot,
  SessionSpec,
  TurnDelivery,
  TurnInput,
  TurnReceipt,
  WatchLevel,
} from '../../index.js'
import type { OnQueueAbandoned } from '../../queue-abandonment.js'
import { claudeSdkCapabilities } from './capabilities.js'
import { classifyClaudeSdkFailure, redactClaudeSdkFailureDetail } from './classify.js'

export const CLAUDE_SDK_DRIVER_ID = 'claude-sdk' as const

export interface ClaudeSdkPermissionRequest {
  id: string
  toolName: string
  input?: unknown
  suggestions?: readonly unknown[]
}

export interface ClaudeSdkTurnResult {
  resumeValue: string
  output: string
  itemId?: string
}

export interface ClaudeSdkTurnHandle {
  done: Promise<ClaudeSdkTurnResult>
  interrupt(): void | Promise<void>
  answerPermission(
    interactionId: string,
    answer: { decision: 'allow-once' | 'allow-always' | 'deny'; feedback?: string },
  ): void | Promise<void>
  dispose?(): void | Promise<void>
}

/** Process and native-transcript operations owned by the daemon. */
export interface ClaudeSdkRuntimeHost {
  mintSessionId(): SessionId
  mintResumeValue(): string
  now(): string
  startTurn(input: {
    sessionId: SessionId
    spec: SessionSpec
    turn: TurnInput
    resumeValue: string
    newConversation: boolean
    onPartialText(text: string, itemHint?: string): void
    onPermission(request: ClaudeSdkPermissionRequest): void
  }): ClaudeSdkTurnHandle
  readTranscript(input: {
    sessionId: SessionId
    workdir: string
    resumeValue: string
    limit: number
  }): Promise<readonly TranscriptItem[]>
  readArchive(input: {
    workdir: string
    resumeValue: string
  }): Promise<{ path: string; bytes: Uint8Array } | undefined>
  /** Report accepted turns that cannot be delivered after teardown or failure. */
  onQueueAbandoned?: OnQueueAbandoned
}

interface QueuedTurn {
  input: TurnInput
  options: SendOptions
}

interface SessionCore {
  sessionId: SessionId
  spec: SessionSpec
  binding: SessionBinding
  state: AgentRuntimeState
  seq: number
  turnEpoch: number
  turnOpen: boolean
  fenced: Set<number>
  observerGeneration: number
  log: { seq: number; event: RuntimeEvent }[]
  wakers: Set<() => void>
  interactions: Map<string, PendingInteraction>
  answered: Set<string>
  interactionResponders: Map<string, (answer: unknown) => void | Promise<void>>
  queue: QueuedTurn[]
  lease: SessionLease | null
  alive: boolean
  disposed: boolean
  oomEvents: number
  watchers: Map<WatchLevel, number>
  active?: ClaudeSdkTurnHandle
  interruptRequested: boolean
  partialText: string
  partialItemId: string
  handleGeneration: number
  textDeliveries: number
  lastRequestedModel?: ModelPolicy
  conversationStarted: boolean
}

export interface ClaudeSdkRuntime extends RuntimeDriver {
  /** The RuntimeDriver view used by daemon registries that accept several concrete runtimes. */
  readonly driver: RuntimeDriver
  createWithId(sessionId: SessionId, spec: SessionSpec): Promise<AgentSessionHandle>
  resumeWithId(sessionId: SessionId, ref: ResumeRef, spec: SessionSpec): Promise<AgentSessionHandle>
  handleFor(sessionId: SessionId): AgentSessionHandle | undefined
  bindings(): readonly SessionBinding[]
  dispose(): void
  permissionRequested(sessionId: SessionId, request: ClaudeSdkPermissionRequest): void
  testInteractionRequested(sessionId: SessionId, spec: InteractionAskSpec): string
  processEvent(sessionId: SessionId, event: ProcessEvent): void
  restartSupervisor(): void
  textDeliveries(sessionId: SessionId): number
  requestedModel(sessionId: SessionId): ModelPolicy | undefined
}

const refuse = (reason: Refusal['reason'], detail?: string): Refusal => ({ reason, detail })

function summarizeInput(input: unknown): string | undefined {
  if (input === undefined) return undefined
  try {
    const text = typeof input === 'string' ? input : JSON.stringify(input)
    return text.length > 240 ? `${text.slice(0, 237)}...` : text
  } catch {
    return undefined
  }
}

export function createClaudeSdkRuntime(host: ClaudeSdkRuntimeHost): ClaudeSdkRuntime {
  const cores = new Map<SessionId, SessionCore>()
  const handles = new Map<SessionId, AgentSessionHandle>()
  const processCores = new Map<string, SessionCore>()

  const cursorAt = (core: SessionCore, seq = core.seq): ProviderCursor => ({
    segmentId: core.binding.process.key,
    components: { seq },
  })

  function push(core: SessionCore, body: RuntimeEventBody): void {
    core.seq += 1
    core.log.push({
      seq: core.seq,
      event: {
        ...body,
        at: host.now(),
        provenance: 'live',
        cursor: cursorAt(core, core.seq),
        observerGeneration: core.observerGeneration,
        turnEpoch: core.turnEpoch,
      },
    })
    if (core.log.length > 512) core.log.splice(0, core.log.length - 512)
    for (const wake of [...core.wakers]) wake()
  }

  function openTurn(core: SessionCore, origin: SendOptions['origin']): number {
    core.turnEpoch += 1
    core.turnOpen = true
    core.state = { ...core.state, phase: 'working', since: host.now() }
    push(core, { t: 'turn', ev: { ev: 'started', turnEpoch: core.turnEpoch, origin } })
    return core.turnEpoch
  }

  function closeTurn(core: SessionCore, result: 'done' | 'interrupted' | Error): void {
    const epoch = core.turnEpoch
    if (!core.turnOpen || core.fenced.has(epoch)) return
    core.fenced.add(epoch)
    core.turnOpen = false
    core.active = undefined
    if (result instanceof Error) {
      const interrupted = core.interruptRequested
      const failure = interrupted
        ? { errorClass: 'interrupted' as const, retryable: true }
        : classifyClaudeSdkFailure(result.message)
      const detail = redactClaudeSdkFailureDetail(result.message)
      const reason = interrupted
        ? ('interrupted' as const)
        : failure.errorClass === 'authentication'
          ? ('auth-expired' as const)
          : failure.errorClass === 'usage_limit' || failure.errorClass === 'rate_limit'
            ? ('rate-limit' as const)
            : ('provider-error' as const)
      const disposition = interrupted
        ? ('retryable' as const)
        : failure.errorClass === 'authentication'
          ? ('needs-human' as const)
          : failure.retryable
            ? ('retryable' as const)
            : ('fatal' as const)
      push(core, {
        t: 'turn',
        ev: {
          ev: 'failed',
          turnEpoch: epoch,
          reason,
          disposition,
          detail,
        },
      })
      core.state = {
        ...core.state,
        phase: 'errored',
        since: host.now(),
        error: {
          class: failure.errorClass,
          retryable: failure.retryable,
          ...(detail ? { detail } : {}),
        },
      }
      push(core, {
        t: 'state',
        change: {
          kind: 'turn_failed',
          errorClass: failure.errorClass,
          retryable: failure.retryable,
          ...(detail ? { detail } : {}),
        },
      })
    } else {
      push(core, { t: 'turn', ev: { ev: 'completed', turnEpoch: epoch, verdict: result } })
      core.state = { ...core.state, phase: 'idle', since: host.now() }
      push(core, { t: 'state', change: { kind: 'turn_completed', verdict: { kind: result } } })
    }
    core.interruptRequested = false
    void drain(core)
  }

  function openPermission(core: SessionCore, request: ClaudeSdkPermissionRequest): void {
    if (!core.alive || core.interactions.has(request.id) || core.answered.has(request.id)) return
    const summary = summarizeInput(request.input)
    const interaction: PendingInteraction = {
      id: request.id,
      sessionId: core.sessionId,
      kind: 'permission',
      payload: {
        v: 1,
        toolName: request.toolName,
        ...(summary ? { inputSummary: summary } : {}),
        canAlwaysAllow: (request.suggestions?.length ?? 0) > 0,
        ...(request.suggestions?.length ? { suggestions: request.suggestions } : {}),
      },
      askedAt: host.now(),
      source: 'sdk-callback',
      answerable: 'structured',
    }
    core.interactions.set(request.id, interaction)
    core.state = {
      ...core.state,
      phase: 'needs_user',
      since: host.now(),
      need: {
        kind: 'permission',
        summary: request.toolName,
        ask: { toolName: request.toolName, ...(summary ? { detail: summary } : {}) },
      },
    }
    push(core, { t: 'interaction', ev: { ev: 'asked', interaction } })
    push(core, {
      t: 'state',
      change: {
        kind: 'needs_user',
        need: 'permission',
        summary: request.toolName,
        ask: { toolName: request.toolName, ...(summary ? { detail: summary } : {}) },
      },
    })
  }

  function openTestInteraction(core: SessionCore, spec: InteractionAskSpec): string {
    const id = `claude-sdk-test-${core.sessionId}-${core.seq + 1}`
    const interaction = {
      ...spec,
      id,
      sessionId: core.sessionId,
      askedAt: host.now(),
      source: 'sdk-callback' as const,
      answerable: 'structured' as const,
    } as PendingInteraction
    core.interactions.set(id, interaction)
    core.interactionResponders.set(id, () => {})
    const need = spec.kind === 'question' ? 'question' : 'permission'
    core.state = {
      ...core.state,
      phase: 'needs_user',
      since: host.now(),
      need: { kind: need, summary: spec.kind },
    }
    push(core, { t: 'interaction', ev: { ev: 'asked', interaction } })
    push(core, {
      t: 'state',
      change: { kind: 'needs_user', need, summary: spec.kind },
    })
    return id
  }

  function deliver(core: SessionCore, input: TurnInput, options: SendOptions): TurnReceipt {
    const epoch = core.turnEpoch + 1
    core.partialText = ''
    core.partialItemId = `claude-sdk-${core.sessionId}-${epoch}`
    let child: ClaudeSdkTurnHandle
    try {
      child = host.startTurn({
        sessionId: core.sessionId,
        spec: core.spec,
        turn: input,
        resumeValue: core.binding.resume?.value ?? host.mintResumeValue(),
        newConversation: !core.conversationStarted,
        onPartialText(text, itemHint) {
          if (!core.turnOpen || core.turnEpoch !== epoch) return
          const delta = text.startsWith(core.partialText)
            ? text.slice(core.partialText.length)
            : text
          core.partialText = text
          if (itemHint) core.partialItemId = itemHint
          if (delta && (core.watchers.get('fine') ?? 0) > 0) {
            push(core, {
              t: 'item',
              item: { kind: 'delta', itemId: core.partialItemId, textDelta: delta },
            })
          }
        },
        onPermission(request) {
          openPermission(core, request)
        },
      })
    } catch (error) {
      return {
        outcome: 'refused',
        refusal: refuse('not_running', error instanceof Error ? error.message : String(error)),
      }
    }
    openTurn(core, options.origin)
    core.textDeliveries += 1
    core.lastRequestedModel = input.overrides?.supported ? input.overrides.value : core.spec.model
    core.conversationStarted = true
    core.active = child
    void child.done.then(
      (result) => {
        if (!core.turnOpen || core.turnEpoch !== epoch) return
        core.binding = {
          ...core.binding,
          resume: { kind: 'claude-session', value: result.resumeValue },
        }
        const text = result.output || core.partialText
        if (text) {
          push(core, {
            t: 'item',
            item: {
              kind: 'complete',
              item: {
                id: result.itemId ?? core.partialItemId,
                role: 'assistant',
                text,
                ts: host.now(),
              },
            },
          })
        }
        void child.dispose?.()
        closeTurn(core, core.interruptRequested ? 'interrupted' : 'done')
      },
      (error) => {
        if (!core.turnOpen || core.turnEpoch !== epoch) return
        void child.dispose?.()
        closeTurn(core, error instanceof Error ? error : new Error(String(error)))
      },
    )
    return {
      outcome: 'accepted',
      turnEpoch: epoch,
      deliveredAs: options.delivery === 'steer' ? 'queue' : options.delivery,
      provenBy: 'sdk-callback',
      at: host.now(),
    }
  }

  async function drain(core: SessionCore): Promise<void> {
    if (!core.alive || core.turnOpen || core.interactions.size > 0) return
    const next = core.queue.shift()
    if (!next) return
    const receipt = deliver(core, next.input, { ...next.options, delivery: 'when-ready' })
    if (receipt.outcome === 'refused') abandonTurn(core, next, 'delivery-failed')
  }

  function reportAbandoned(
    core: SessionCore,
    turns: readonly QueuedTurn[],
    reason: QueueDrainAbandonedReason,
  ): void {
    if (turns.length === 0) return
    try {
      host.onQueueAbandoned?.({ sessionId: core.sessionId, turns, reason })
    } catch {
      // Queue reporting is diagnostic/durable correction; it must not strand the
      // child or prevent the rest of teardown when the host report itself fails.
    }
  }
  function abandonQueue(core: SessionCore, reason: QueueDrainAbandonedReason): void {
    if (core.queue.length === 0) return
    const turns = core.queue.splice(0, core.queue.length)
    reportAbandoned(core, turns, reason)
  }
  function abandonTurn(
    core: SessionCore,
    turn: QueuedTurn,
    reason: QueueDrainAbandonedReason,
  ): void {
    reportAbandoned(core, [turn], reason)
  }
  function end(core: SessionCore, exit?: RuntimeEventBody): void {
    if (core.disposed) return
    core.alive = false
    core.turnOpen = false
    core.fenced.add(core.turnEpoch)
    core.active = undefined
    abandonQueue(core, 'teardown')
    if (exit) push(core, exit)
    core.disposed = true
    core.interactions.clear()
    core.interactionResponders.clear()
    handles.delete(core.sessionId)
    cores.delete(core.sessionId)
    processCores.delete(core.binding.process.key)
    for (const wake of [...core.wakers]) wake()
  }

  function makeHandle(core: SessionCore): AgentSessionHandle {
    const mintedAt = core.handleGeneration
    const assertCurrent = (): void => {
      if (mintedAt !== core.handleGeneration) {
        throw new Error('claude-sdk: stale handle; adopt the exact surviving binding')
      }
    }
    const handle: AgentSessionHandle = {
      get binding() {
        return core.binding
      },
      async stop() {
        assertCurrent()
        const active = core.active
        end(core, {
          t: 'process',
          ev: { ev: 'exited', code: 0, signal: null, classification: 'clean' },
        })
        await active?.interrupt()
        await active?.dispose?.()
      },
      async hibernate() {
        assertCurrent()
        if (!core.binding.resume) return refuse('no_resume_ref')
        const active = core.active
        end(core)
        await active?.interrupt()
        await active?.dispose?.()
        return { ok: true as const }
      },
      async kill() {
        assertCurrent()
        const active = core.active
        end(core, {
          t: 'process',
          ev: { ev: 'exited', code: null, signal: 'SIGKILL', classification: 'killed' },
        })
        await active?.interrupt()
        await active?.dispose?.()
      },
      async health(): Promise<SessionHealth> {
        return { alive: core.alive, oomEvents: core.oomEvents }
      },
      async snapshot(): Promise<SessionSnapshot> {
        assertCurrent()
        return {
          binding: core.binding,
          state: core.state,
          cursor: cursorAt(core),
          observerGeneration: core.observerGeneration,
          turnEpoch: core.turnEpoch,
          interactions: [...core.interactions.values()],
          at: host.now(),
        }
      },
      async export(): Promise<SessionArchive> {
        assertCurrent()
        const resume = core.binding.resume
        if (!resume) throw new DriverRefusalError({ reason: 'no_resume_ref' }, 'claude-sdk export')
        const archive = await host.readArchive({
          workdir: core.spec.workdir,
          resumeValue: resume.value,
        })
        return {
          harness: 'claude-code',
          formatVersion: 1,
          resume,
          files: archive ? [{ path: archive.path, bytes: archive.bytes }] : [],
          binding: {
            sessionId: core.binding.sessionId,
            driver: core.binding.driver,
            family: core.binding.family,
            harness: core.binding.harness,
            workdir: core.binding.workdir,
            resume,
            ...(core.binding.principal ? { principal: core.binding.principal } : {}),
          },
        }
      },
      async send(input: TurnInput, options: SendOptions): Promise<TurnReceipt> {
        assertCurrent()
        if (!core.alive) return { outcome: 'refused', refusal: refuse('not_running') }
        if (input.attachments?.length) {
          return {
            outcome: 'refused',
            refusal: refuse(
              'unsupported',
              'the Claude SDK adapter has no typed attachment channel',
            ),
          }
        }
        if (core.interactions.size > 0) return { outcome: 'refused', refusal: refuse('needs_user') }
        if (core.lease?.kind === 'human-controller' && options.origin !== 'human') {
          return { outcome: 'refused', refusal: refuse('lease_held', core.lease.holder) }
        }
        const deliveredAs: TurnDelivery =
          options.delivery === 'steer' || (options.delivery === 'interrupt' && !core.turnOpen)
            ? options.delivery === 'interrupt'
              ? 'when-ready'
              : 'queue'
            : options.delivery
        if (core.turnOpen) {
          core.queue.push({ input, options })
          if (options.delivery === 'interrupt') {
            core.interruptRequested = true
            await core.active?.interrupt()
          }
          return {
            outcome: 'queued',
            position: core.queue.length,
            deliveredAs: 'queue',
            at: host.now(),
          }
        }
        if (deliveredAs === 'queue') {
          core.queue.push({ input, options })
          const position = core.queue.length
          void drain(core)
          return { outcome: 'queued', position, deliveredAs: 'queue', at: host.now() }
        }
        return deliver(core, input, { ...options, delivery: deliveredAs })
      },
      async stageAttachment(): Promise<AttachmentStageResult> {
        return refuse('unsupported', 'the Claude SDK adapter has no typed attachment channel')
      },
      async interrupt() {
        assertCurrent()
        if (!core.turnOpen) return
        core.interruptRequested = true
        await core.active?.interrupt()
      },
      async answer(interactionId, answer, options): Promise<InteractionAnswerOutcome> {
        assertCurrent()
        if (core.answered.has(interactionId)) return { ok: false, reason: 'already-answered' }
        const interaction = core.interactions.get(interactionId)
        if (!interaction) return { ok: false, reason: 'unknown-interaction' }
        const responder = core.interactionResponders.get(interactionId)
        let delivered: unknown
        if (interaction.kind === 'permission') {
          const raw =
            typeof answer === 'object' && answer !== null ? (answer as Record<string, unknown>) : {}
          const decision = raw.decision
          const candidate =
            decision === 'allow'
              ? { ...raw, kind: 'permission', decision: 'allow-once' }
              : decision === 'allow-once' || decision === 'allow-always' || decision === 'deny'
                ? { ...raw, kind: 'permission' }
                : answer
          const parsed = PermissionAnswer.safeParse(candidate)
          if (!parsed.success)
            return { ok: false, reason: 'not-yet-supported', detail: parsed.error.message }
          if (parsed.data.decision === 'allow-always' && !interaction.payload.canAlwaysAllow) {
            return {
              ok: false,
              reason: 'not-yet-supported',
              detail: 'provider offered no persistent permission rule',
            }
          }
          delivered = {
            decision: parsed.data.decision,
            ...(parsed.data.feedback ? { feedback: parsed.data.feedback } : {}),
          }
        } else {
          delivered = answer
        }
        try {
          if (responder) await responder(delivered)
          else if (interaction.kind === 'permission' && core.active) {
            await core.active.answerPermission(
              interactionId,
              delivered as Parameters<ClaudeSdkTurnHandle['answerPermission']>[1],
            )
          } else throw new Error('the SDK turn no longer owns this interaction')
        } catch (error) {
          return {
            ok: false,
            reason: 'delivery-failed',
            detail: error instanceof Error ? error.message : String(error),
          }
        }
        core.interactions.delete(interactionId)
        core.interactionResponders.delete(interactionId)
        core.answered.add(interactionId)
        push(core, {
          t: 'interaction',
          ev: {
            ev: 'answered',
            id: interactionId,
            answeredBy: options?.principal?.kind === 'agent' ? 'superagent' : 'human',
            at: host.now(),
          },
        })
        if (core.interactions.size === 0) {
          core.state = {
            ...core.state,
            phase: core.turnOpen ? 'working' : 'idle',
            since: host.now(),
            need: undefined,
          }
        }
        return { ok: true }
      },
      async interactions() {
        return [...core.interactions.values()]
      },
      events(after: EventStreamStart) {
        return createRuntimeEventStream(after, {
          log: core.log,
          wakers: core.wakers,
          currentSeq: () => core.seq,
          isDisposed: () => core.disposed,
        })
      },
      async watch(level: WatchLevel) {
        core.watchers.set(level, (core.watchers.get(level) ?? 0) + 1)
        let released = false
        return () => {
          if (released) return
          released = true
          core.watchers.set(level, Math.max(0, (core.watchers.get(level) ?? 1) - 1))
        }
      },
      async state() {
        return core.state
      },
      transcript: {
        async history({ limit }) {
          const resume = core.binding.resume
          if (!resume) return []
          return host.readTranscript({
            sessionId: core.sessionId,
            workdir: core.spec.workdir,
            resumeValue: resume.value,
            limit,
          })
        },
      },
      async attach() {
        return refuse('unsupported', 'the embedded SDK has no attach endpoint')
      },
      lease: {
        async acquire(holder, kind) {
          if (core.lease && core.lease.holder !== holder)
            return refuse('lease_held', core.lease.holder)
          core.lease = { holder, kind, acquiredAt: host.now() }
          return core.lease
        },
        async release(holder) {
          if (core.lease?.holder === holder) core.lease = null
        },
        async state() {
          return core.lease
        },
      },
      draft: {
        async get() {
          return refuse('unsupported', 'the embedded SDK has no composer')
        },
        async set() {
          return refuse('unsupported', 'the embedded SDK has no composer')
        },
      },
      async configure() {
        return refuse('unsupported', 'SDK configuration is pinned per turn')
      },
      async usage() {
        return refuse('unsupported', 'SDK usage is not normalized')
      },
    }
    handles.set(core.sessionId, handle)
    return handle
  }

  function newCore(
    sessionId: SessionId,
    spec: SessionSpec,
    resume: ResumeRef,
    fresh: boolean,
  ): SessionCore {
    const core: SessionCore = {
      sessionId,
      spec,
      binding: {
        sessionId,
        driver: CLAUDE_SDK_DRIVER_ID,
        family: 'embedded',
        harness: 'claude-code',
        workdir: spec.workdir,
        resume,
        ...(spec.principal ? { principal: spec.principal } : {}),
        process: { key: `claude-sdk:${sessionId}` },
        bindingVersion: 1,
      },
      state: { phase: 'idle', since: host.now(), nativeSubagentCount: 0 },
      seq: 0,
      turnEpoch: 0,
      turnOpen: false,
      fenced: new Set(),
      observerGeneration: 1,
      log: [],
      wakers: new Set(),
      interactions: new Map(),
      answered: new Set(),
      interactionResponders: new Map(),
      queue: [],
      lease: null,
      alive: true,
      disposed: false,
      oomEvents: 0,
      watchers: new Map(),
      interruptRequested: false,
      partialText: '',
      partialItemId: '',
      handleGeneration: 0,
      textDeliveries: 0,
      conversationStarted: !fresh,
    }
    cores.set(sessionId, core)
    processCores.set(core.binding.process.key, core)
    push(core, { t: 'state', change: { kind: 'session_started' } })
    return core
  }

  async function createWithId(
    sessionId: SessionId,
    spec: SessionSpec,
  ): Promise<AgentSessionHandle> {
    if (spec.harness !== 'claude-code') throw new Error(`claude-sdk cannot drive ${spec.harness}`)
    if (cores.has(sessionId)) throw new Error(`claude-sdk session '${sessionId}' already exists`)
    const handle = makeHandle(
      newCore(sessionId, spec, { kind: 'claude-session', value: host.mintResumeValue() }, true),
    )
    if (spec.initialPrompt) {
      await handle.send({ text: spec.initialPrompt }, { origin: 'system', delivery: 'when-ready' })
    }
    return handle
  }

  async function resumeWithId(
    sessionId: SessionId,
    ref: ResumeRef,
    spec: SessionSpec,
  ): Promise<AgentSessionHandle> {
    if (spec.harness !== 'claude-code') throw new Error(`claude-sdk cannot drive ${spec.harness}`)
    if (cores.has(sessionId)) throw new Error(`claude-sdk session '${sessionId}' already exists`)
    return makeHandle(newCore(sessionId, spec, ref, false))
  }
  const runtime: ClaudeSdkRuntime = {
    get driver() {
      return runtime
    },
    id: CLAUDE_SDK_DRIVER_ID,
    harness: 'claude-code',
    family: 'embedded',
    capabilities: claudeSdkCapabilities,
    async create(spec) {
      return createWithId(host.mintSessionId(), spec)
    },
    async resume(ref, spec) {
      return resumeWithId(host.mintSessionId(), ref, spec)
    },
    async adopt(binding) {
      const core = processCores.get(binding.process.key)
      if (!core || core.binding.sessionId !== binding.sessionId || !core.alive) {
        throw new Error(`claude-sdk: no exact surviving process for ${binding.process.key}`)
      }
      core.binding = { ...core.binding, bindingVersion: core.binding.bindingVersion + 1 }
      core.observerGeneration += 1
      push(core, {
        t: 'process',
        ev: { ev: 'adopted', bindingVersion: core.binding.bindingVersion },
      })
      return makeHandle(core)
    },
    createWithId,
    resumeWithId,
    handleFor(sessionId) {
      return handles.get(sessionId)
    },
    bindings() {
      return [...handles.values()].map((handle) => handle.binding)
    },
    permissionRequested(sessionId, request) {
      const core = cores.get(sessionId)
      if (!core) throw new Error(`claude-sdk: no session ${sessionId}`)
      openPermission(core, request)
    },
    testInteractionRequested(sessionId, spec) {
      const core = cores.get(sessionId)
      if (!core) throw new Error(`claude-sdk: no session ${sessionId}`)
      return openTestInteraction(core, spec)
    },
    processEvent(sessionId, event) {
      const core = cores.get(sessionId)
      if (!core) return
      if (event.ev === 'oomKilled') core.oomEvents += 1
      if (event.ev === 'exited') core.alive = false
      push(core, { t: 'process', ev: event })
    },
    restartSupervisor() {
      handles.clear()
      for (const core of cores.values()) {
        core.handleGeneration += 1
        core.wakers.clear()
      }
    },
    textDeliveries(sessionId) {
      return cores.get(sessionId)?.textDeliveries ?? 0
    },
    requestedModel(sessionId) {
      return cores.get(sessionId)?.lastRequestedModel
    },
    dispose() {
      for (const core of [...cores.values()]) {
        const active = core.active
        end(core)
        void active?.interrupt()
        void active?.dispose?.()
      }
    },
  }
  return runtime
}
