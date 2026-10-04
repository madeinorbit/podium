import {
  type AgentRuntimeState,
  formatAgentError,
  type HarnessRef,
  type ResumeRef,
  type SessionId,
  type TranscriptItem,
} from '@podium/model'
import type { ProviderCursor } from '@podium/protocol'
import { PermissionAnswer } from '@podium/protocol'
import type {
  QueueDrainAbandonedReason,
  RuntimeHistoryPage,
  RuntimeHistoryRange,
} from '@podium/protocol/daemon'
import {
  claudeToolCallItem,
  claudeToolResultItem,
} from '../../../adapters/claude-code/transcript.js'
import type { AgentStateEvent } from '../../../agent-state/types.js'
import { reduceAgentState } from '../../../observer.js'
import type { ProcessIdentity } from '../../binding.js'
import { type ConfigureValueChecks, decideConfigure, noWhitespaceCheck } from '../../configure.js'
import { withDeliveryQueue } from '../../delivery-queue.js'
import { DeliveryUnprovenError, DriverRefusalError, wasNeverSent } from '../../errors.js'
import { createRuntimeEventStream } from '../../events.js'
import { headlessInterruptMark } from '../../headless-interrupt.js'
import type {
  AgentSessionHandle,
  AttachmentStageResult,
  ConfigureRequest,
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
} from '../../host.js'
import type { OnQueueAbandoned } from '../../queue-abandonment.js'
import type { SessionDriverSlots } from '../session-slots.js'
import { claudeSdkCapabilities } from './capabilities.js'
import { classifyClaudeSdkFailure, redactClaudeSdkFailureDetail } from './classify.js'
import { claudeUserMessageUuid } from './message-uuid.js'
import { claudeTranscriptReceipts } from './transcript-receipt.js'

const RECEIPT_WATCH_MS = 120_000

interface HeldMessage {
  uuid: string
  resumeValue: string
  options: SendOptions
  deadline: number
  /** The CLI process that took the line exited on its own (POD-4887). */
  exited: boolean
  /** Watched after an `unverified` answer (a line written, never acked): a
   *  record is late proof, a post-exit read without one a late "no", and
   *  anything else ends the watch in silence (POD-4840, POD-4887). */
  late: boolean
}

/**
 * WHAT THE SDK CAN TAKE, structurally. Which model aliases and effort levels
 * exist for an account is the server's live catalog — see the note on the codex
 * checks for why the driver does not keep a second copy.
 */
const CLAUDE_SDK_CONFIGURE_CHECKS: ConfigureValueChecks = {
  model: noWhitespaceCheck('a Claude model name'),
  effort: noWhitespaceCheck('a Claude reasoning effort'),
}

export const CLAUDE_SDK_DRIVER_ID = 'claude-sdk' as const

export interface ClaudeSdkPermissionRequest {
  id: string
  toolName: string
  input?: unknown
  suggestions?: readonly unknown[]
}

/** One tool the model invoked, keyed by the provider's own `tool_use.id`. */
export interface ClaudeSdkToolCall {
  toolUseId: string
  toolName: string
  input?: unknown
}

/** What that tool returned. `output` is always present and may be empty. */
export interface ClaudeSdkToolResult {
  toolUseId: string
  output: string
  isError?: boolean
}

export interface ClaudeSdkTurnResult {
  resumeValue: string
  output: string
  itemId?: string
  observedModel?: string
  observedEffort?: string
}

/**
 * What the provider did with one interrupt request.
 *
 * `unconfirmed` is not a failure to model the world; it IS the world. A host
 * killed while winding down never reports back, and the driver's capability
 * claim is `fenceOnProviderConfirmation` — so a verdict we did not receive must
 * stay distinguishable from one we did, or the fence is manufactured.
 */
export type ClaudeSdkInterruptAck =
  | { outcome: 'accepted' }
  | { outcome: 'rejected'; detail: string }
  | { outcome: 'unconfirmed'; detail: string }

export interface ClaudeSdkTurnHandle {
  done: Promise<ClaudeSdkTurnResult>
  /**
   * THE RECEIPT'S PROOF (POD-4836): resolves on the CLI's own acknowledgement
   * of the user line's uuid, or rejects with the failure that ended the turn
   * before any. Never on the write — a line the child never read is not
   * accepted. The turn opens only once this resolves. A line the session
   * already held resolves it too, and its `done` settles empty at once.
   */
  accepted: Promise<void>
  /** Teardown's interrupt: fire and forget, deliberately unacknowledged. */
  interrupt(): void | Promise<void>
  /**
   * The OPERATOR's interrupt, which owes an answer.
   *
   * Optional because not every host can offer one. A host without it is treated
   * as `unconfirmed` rather than as success — the absence of a confirmation
   * channel is exactly the situation where a confirmation must not be assumed.
   */
  requestInterrupt?(): Promise<ClaudeSdkInterruptAck>
  /**
   * THE CLI PROCESS THAT TOOK THIS LINE EXITED ON ITS OWN (POD-4887): the
   * host's exit report, never a Podium stop and never a dead-pipe guess.
   * Absent = the host cannot tell, and no "no" is ever proven from an exit.
   */
  exited?: Promise<void>
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
    /** The uuid the CLI records this user turn under, and so the id of its
     *  history entry (POD-4774): derived from the message id (POD-4836). */
    userMessageUuid: string
    onPartialText(text: string, itemHint?: string): void
    onPermission(request: ClaudeSdkPermissionRequest): void
    /** One tool call, as the provider issued it. Always delivered before the
     *  matching `onToolResult`. */
    onToolCall(call: ClaudeSdkToolCall): void
    /** That call's return. `output` may be empty; the call still finished. */
    onToolResult(result: ClaudeSdkToolResult): void
  }): ClaudeSdkTurnHandle
  readTranscript(input: {
    sessionId: SessionId
    workdir: string
    resumeValue: string
    range: Omit<RuntimeHistoryRange, 'direction'> & { direction?: RuntimeHistoryRange['direction'] }
  }): Promise<RuntimeHistoryPage>
  readArchive(input: {
    workdir: string
    resumeValue: string
  }): Promise<{ path: string; bytes: Uint8Array } | undefined>
  /** Report the provider fields carried by a successfully completed assistant turn. */
  reportObservedConfiguration?(input: {
    sessionId: SessionId
    model: string
    effort?: string
  }): void
  /** Report accepted turns that cannot be delivered after teardown or failure. */
  onQueueAbandoned?: OnQueueAbandoned
  /**
   * END THE SESSION'S ENGINE (POD-4499). The contract runtime owns turns; the
   * engine host owns the per-session `claude` child the turns rode. Absent =
   * no engine (tests, embedded fakes). `retire` true (stop/kill) clears the
   * adopt journal; false (hibernate) keeps it — the session persists and a
   * later resume (or a daemon-restart adopt) rebinds by label.
   */
  stopEngine?(sessionId: SessionId, retire: boolean): Promise<void> | void
  /** Drop every engine hold WITHOUT ending engines (daemon shutdown): the
   *  host owns them now, and the journals stay so the next generation adopts
   *  the survivors. */
  releaseEngines?(): void
  /**
   * THE ENGINE'S PROCESS IDENTITY for this session, read LIVE (POD-4612): its
   * durable label as the key, its scope unit where the platform has one, and
   * its pid while this daemon holds it. The handle's binding carries it, so
   * the generic server-family reap measures a Claude engine exactly as it
   * measures codex — the key never changes for a session, the pid appears
   * once an engine is held. Absent = no engine host (tests, conformance
   * fakes): the binding keeps the in-memory key.
   */
  processFor?(sessionId: SessionId): ProcessIdentity
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
  /** A user line is out to the CLI and not yet acknowledged (POD-4836):
   *  settles when the CLI acks it or the attempt fails. The turn is not open,
   *  but the child is taken — busy for every send, and an interrupt waits for
   *  the turn this may open. */
  delivering?: Promise<unknown>
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
  /** What the provider said about the interrupt that closed this turn, kept so
   *  the durable record can distinguish a confirmed stop from an assumed one. */
  interruptConfirmation?: 'accepted' | 'unconfirmed'
  /** Interrupt requests outstanding for the open turn. A second press while the
   *  first is in flight must not mint a second record for one stop. */
  interruptsInFlight: number
  /** The last turn epoch that has already been told, durably, that there was
   *  nothing to interrupt. Bounds the idle-interrupt receipt to one per epoch so
   *  a repeatedly-pressed button cannot bury the transcript. */
  idleInterruptNotedEpoch: number
  partialText: string
  partialItemId: string
  /** Transcript-item ids already published for this session's tool calls and
   *  results. See `notePublishedToolItem`. */
  publishedToolItems: Set<string>
  publishedPromptItems: Set<string>
  heldMessages: Set<HeldMessage>
  receiptTimer?: ReturnType<typeof setTimeout>
  receiptReading: boolean
  receiptPollMs: number
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

export function createClaudeSdkRuntime(
  host: ClaudeSdkRuntimeHost,
  // The session's handle lives on the supervisor's entry (POD-4610): this
  // family binds into the slot and reads it back, and keeps no index of its own.
  slots: SessionDriverSlots,
): ClaudeSdkRuntime {
  const cores = new Map<SessionId, SessionCore>()
  const processCores = new Map<string, SessionCore>()
  /**
   * WHAT HIBERNATE LEAVES BEHIND, so `adopt` can wake it (POD-4612). The
   * server family's contract is that a parked session comes back under its
   * own id, on its own conversation and its own sticky model — codex keeps
   * its journal for that, and this is the driver-side twin: `hibernate()`
   * records the core's spec and binding, `stop()`/`kill()` forget it, and a
   * new incarnation of the id supersedes it. The engine's own journal (the
   * session layer's) is what a daemon RESTART wakes from; this answers the
   * same promise inside one daemon life.
   */
  const parked = new Map<SessionId, { spec: SessionSpec; binding: SessionBinding }>()

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

  function foldState(core: SessionCore, change: AgentStateEvent): void {
    const at = host.now()
    core.state = reduceAgentState(core.state, change, at)
    push(core, { t: 'state', change })
  }

  function publishItem(core: SessionCore, item: TranscriptItem): void {
    push(core, { t: 'item', item: { kind: 'complete', item } })
  }

  function watchReceipt(
    core: SessionCore,
    uuid: string,
    options: SendOptions,
    exited: Promise<void> | undefined,
    late = false,
  ): void {
    const message: HeldMessage = {
      uuid,
      resumeValue: core.binding.resume?.value ?? '',
      options,
      deadline: Date.now() + RECEIPT_WATCH_MS,
      exited: false,
      late,
    }
    core.heldMessages.add(message)
    void exited?.then(() => {
      if (!core.heldMessages.has(message)) return
      message.exited = true
      // Read again now, from a timer: the read that decides must start after
      // the exit, and a late watch only after its `unverified` answer settled.
      rearmReceipts(core, 0)
    })
    // A late watch reads from a timer too, for the same second reason.
    rearmReceipts(core, late ? 100 : undefined)
  }

  function rearmReceipts(core: SessionCore, delayMs?: number): void {
    core.receiptPollMs = 100
    if (core.receiptTimer) clearTimeout(core.receiptTimer)
    core.receiptTimer = undefined
    if (delayMs === undefined) {
      void readReceipts(core)
      return
    }
    core.receiptTimer = setTimeout(() => {
      core.receiptTimer = undefined
      void readReceipts(core)
    }, delayMs)
    core.receiptTimer.unref?.()
  }

  /**
   * THE PROCESS EXITED AND ITS HISTORY LACKS THE LINE (POD-4887; POD-4819 §6.1
   * N4). Measured on 2.1.284 (POD-4862): nothing the CLI held survives its
   * exit — a queued line, a line killed right after its ack — and the resumed
   * conversation does not hold it. So a transcript read that STARTED after the
   * exit, and found no record under our uuid, proves it is not in the
   * conversation (the model may still have seen it once). A read that failed
   * proves nothing.
   */
  const EXITED_WITHOUT_IT =
    'Claude exited and its transcript, read after the exit, does not hold it'

  /** One read for all held lines. A turn ending, including an API error, is
   * not a negative receipt and does not close these watches (POD-4819 §6.2). */
  async function readReceipts(core: SessionCore): Promise<void> {
    if (core.receiptReading || core.disposed || core.heldMessages.size === 0) return
    core.receiptReading = true
    try {
      const pending = [...core.heldMessages]
      for (const resumeValue of new Set(pending.map((message) => message.resumeValue))) {
        const messages = pending.filter((message) => message.resumeValue === resumeValue)
        // Which of them this read can decide: those whose exit came before it.
        const readAfterExit = new Set(messages.filter((message) => message.exited))
        const archive = await host
          .readArchive({ workdir: core.spec.workdir, resumeValue })
          .catch(() => undefined)
        if (core.disposed) return
        const found = archive
          ? claudeTranscriptReceipts(
              archive.bytes,
              resumeValue,
              new Set(messages.map((message) => message.uuid)),
            )
          : new Map<string, TranscriptItem>()
        for (const message of messages) {
          if (!core.heldMessages.has(message)) continue
          const item = found.get(message.uuid)
          if (item) {
            core.heldMessages.delete(message)
            if (!core.publishedPromptItems.has(item.id)) {
              core.publishedPromptItems.add(item.id)
              publishItem(core, item)
            }
            const harnessRef: HarnessRef = [{ kind: 'claude-uuid', id: message.uuid }]
            if (message.late) {
              message.options.onLateProof?.({ transcriptItem: { id: item.id }, harnessRef })
            } else {
              message.options.onTranscriptItem?.({ id: item.id }, harnessRef)
            }
          } else if (readAfterExit.has(message)) {
            core.heldMessages.delete(message)
            if (archive) message.options.onUnrecorded?.(EXITED_WITHOUT_IT, 'agent-exited')
            else if (!message.late) {
              // The history could not be read after the exit: nothing proven.
              message.options.onUnrecorded?.('Claude exited and its transcript could not be read')
            }
          } else if (Date.now() >= message.deadline) {
            core.heldMessages.delete(message)
            // Neither an unreadable file nor a timer proves a "no": the watch
            // closes unconfirmed, and a late watch closes in silence.
            if (!message.late) {
              message.options.onUnrecorded?.(
                'Claude transcript receipt watch ended without a record',
              )
            }
          }
        }
      }
    } finally {
      core.receiptReading = false
      if (!core.disposed && core.heldMessages.size > 0) {
        core.receiptTimer = setTimeout(() => {
          core.receiptTimer = undefined
          void readReceipts(core)
        }, core.receiptPollMs)
        core.receiptTimer.unref?.()
        core.receiptPollMs = Math.min(core.receiptPollMs * 2, 1000)
      }
    }
  }

  /**
   * HOW MANY TOOL-ITEM IDS ONE SESSION REMEMBERS.
   *
   * Only large enough that a duplicate can never arrive after its id has been
   * forgotten in practice — duplicates come from the provider re-reporting a
   * message it already sent within the same conversation, not from a call
   * thousands of tools ago. The bound exists so a session that runs for days
   * cannot grow this set without limit.
   */
  const TOOL_ITEM_MEMORY = 4096

  /**
   * PUBLISH ONE TOOL ITEM AT MOST ONCE (POD-3050).
   *
   * The provider re-reports messages: a resumed conversation replays them, and a
   * superseded assistant message arrives again in corrected form. Every such
   * copy carries the SAME `tool_use.id`, so identity — not arrival order, not a
   * count — is what distinguishes a repeat from a second call. Returns true when
   * the item is new and should be published.
   */
  function notePublishedToolItem(core: SessionCore, id: string): boolean {
    if (core.publishedToolItems.has(id)) return false
    core.publishedToolItems.add(id)
    if (core.publishedToolItems.size > TOOL_ITEM_MEMORY) {
      // Sets iterate in insertion order, so this drops the oldest id.
      const oldest = core.publishedToolItems.values().next()
      if (!oldest.done) core.publishedToolItems.delete(oldest.value)
    }
    return true
  }

  /**
   * THE DURABLE RECORD OF ONE TOOL CALL, and the defect POD-3050 is about.
   *
   * A headless Claude turn used to reach the transcript as a prompt and an
   * answer with a hole between them: the driver mapped `tool_use` to a status
   * badge that nothing stores, and ignored `tool_result` entirely. A human
   * reading the conversation back saw the model assert a file's contents with no
   * record of it ever having read the file.
   *
   * The item is built by the store's shared builder (`@podium/harness/store`) — the same
   * function the JSONL parser uses — so the item published live and the item a
   * reload produces are the same item, by construction rather than by agreement.
   */
  function publishToolCall(core: SessionCore, call: ClaudeSdkToolCall): void {
    if (!notePublishedToolItem(core, call.toolUseId)) return
    publishItem(
      core,
      claudeToolCallItem({
        id: call.toolUseId,
        toolName: call.toolName,
        input: call.input,
        ts: host.now(),
        toolUseId: call.toolUseId,
      }),
    )
  }

  /** The result half of the pair. Its id is derived from the call's so the two
   *  are distinct items that a renderer can still join on `toolUseId`. */
  function publishToolResult(core: SessionCore, result: ClaudeSdkToolResult): void {
    const id = `${result.toolUseId}-result`
    if (!notePublishedToolItem(core, id)) return
    publishItem(
      core,
      claudeToolResultItem({
        id,
        output: result.output,
        ts: host.now(),
        toolUseId: result.toolUseId,
      }),
    )
  }

  /** A system transcript item is the operator's copy of the record. The runtime
   *  event stream is the machine's; both are pushed, and neither substitutes for
   *  the other — the daemon forwards `complete` items to the durable transcript,
   *  which is where a human looking at a stopped turn actually goes. */
  function publishSystemNote(core: SessionCore, id: string, text: string): void {
    publishItem(core, { id, role: 'system', text, ts: host.now() })
  }

  /**
   * THE DURABLE RECORD OF A STOPPED TURN, and the defect this issue is about.
   *
   * A turn that ended because the operator interrupted it used to close with a
   * verdict and nothing else: no transcript item, no explanation, nothing a
   * human reading the conversation back could see. The turn simply stopped
   * mid-sentence, which is indistinguishable from the model losing its nerve.
   *
   * Exactly-once is inherited from the caller rather than re-implemented here:
   * `closeTurn` fences its epoch before doing anything, and returns early on an
   * epoch already in `core.fenced`, so every path into this function runs at
   * most once per turn. The item id carries the epoch too, so even a replayed
   * log cannot present two records as two separate stops.
   */
  function publishInterruptRecord(core: SessionCore, epoch: number): void {
    const confirmed = core.interruptConfirmation === 'accepted'
    /**
     * MINTED BY THE SHARED HEADLESS MAPPING (POD-3090), not by hand. The record
     * this driver already wrote was invisible: a plain system note carrying no
     * `event`, so the chat's interrupt arm — the stop rule a terminal session
     * gets for free — never fired for it. Going through the mapping keeps this
     * family's wording and its system role (its consumers key on both) and adds
     * the one field that makes the stop READ as a stop, in the same shape codex
     * and opencode now emit.
     */
    const item = headlessInterruptMark({
      family: 'claude-sdk',
      sessionId: core.sessionId,
      turnEpoch: epoch,
      at: host.now(),
      result: { kind: 'completed', verdict: 'interrupted' },
      role: 'system',
      text: confirmed
        ? 'Turn interrupted by the operator.'
        : 'Turn interrupted by the operator; the model host did not confirm the interrupt before the turn ended.',
    })
    if (item) publishItem(core, item)
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
      const change: AgentStateEvent = {
        kind: 'turn_failed',
        errorClass: failure.errorClass,
        retryable: failure.retryable,
        ...(detail ? { detail } : {}),
      }
      // Causal fold before the turn-close event: the durable gate rejects any
      // non-process event once the epoch is closed, so the error class has to
      // land on state (and the transcript) first.
      foldState(core, change)
      if (interrupted) {
        publishInterruptRecord(core, epoch)
      } else {
        const error = {
          class: failure.errorClass,
          retryable: failure.retryable,
          ...(detail ? { detail } : {}),
        }
        publishItem(core, {
          id: `claude-sdk-error-${core.sessionId}-${epoch}`,
          role: 'system',
          text: formatAgentError(error),
          ts: host.now(),
        })
      }
      push(core, {
        t: 'turn',
        ev: {
          ev: 'failed',
          turnEpoch: epoch,
          reason,
          disposition,
          ...(detail ? { detail } : {}),
        },
      })
    } else {
      foldState(core, { kind: 'turn_completed', verdict: { kind: result } })
      if (result === 'interrupted') publishInterruptRecord(core, epoch)
      push(core, { t: 'turn', ev: { ev: 'completed', turnEpoch: epoch, verdict: result } })
    }
    core.interruptRequested = false
    core.interruptConfirmation = undefined
    core.interruptsInFlight = 0
    void drain(core)
  }

  /**
   * Request an interrupt from the provider and record what came back.
   *
   * The contract's `interrupt()` resolves `void` and says to watch the stream,
   * so the stream is where every one of these outcomes has to land. Before this
   * existed the request was a write with no read at all: the flag was set, the
   * child was poked, and whether the provider stopped anything was never asked
   * and never told.
   *
   * ONE STOP, ONE RECORD. `interruptsInFlight` covers the operator pressing the
   * button twice; the epoch fence inside `closeTurn` covers the record itself.
   * A REJECTION UNSETS THE FLAG, which is what keeps late completion honest: a
   * turn whose interrupt the provider declined goes on to finish normally, and
   * must be reported as the completion it is rather than as a stop that never
   * happened.
   */
  async function requestInterrupt(core: SessionCore): Promise<void> {
    const epoch = core.turnEpoch
    const active = core.active
    core.interruptRequested = true
    core.interruptsInFlight += 1
    let ack: ClaudeSdkInterruptAck
    try {
      if (active?.requestInterrupt) {
        ack = await active.requestInterrupt()
      } else {
        await active?.interrupt()
        ack = {
          outcome: 'unconfirmed',
          detail: 'this Claude SDK host offers no interrupt confirmation channel',
        }
      }
    } catch (error) {
      ack = {
        outcome: 'unconfirmed',
        detail: error instanceof Error ? error.message : String(error),
      }
    }
    core.interruptsInFlight -= 1
    // The turn moved on while we were asking. Its own close already wrote the
    // record; adding another here would describe a turn that no longer exists.
    if (!core.turnOpen || core.turnEpoch !== epoch) return
    if (ack.outcome === 'rejected') {
      // Only the LAST outstanding request may clear the flag: an earlier press
      // that the provider accepted must not be undone by a later one it refused.
      if (core.interruptsInFlight === 0) core.interruptRequested = false
      publishSystemNote(
        core,
        `claude-sdk-interrupt-refused-${core.sessionId}-${epoch}`,
        `Interrupt refused by the model provider: ${ack.detail} The turn is still running.`,
      )
      return
    }
    core.interruptConfirmation =
      ack.outcome === 'accepted' ? 'accepted' : (core.interruptConfirmation ?? 'unconfirmed')
  }

  /**
   * THE OPERATOR'S STOP, for whatever the session is doing. A line the CLI has
   * not acked yet (POD-4836) is waited out first: the stop is for the turn it
   * opens, and a line the CLI refused left nothing to stop.
   */
  async function interruptTurn(core: SessionCore): Promise<void> {
    if (core.delivering) await core.delivering
    if (!core.turnOpen) {
      // AN INTERRUPT WITH NOTHING TO INTERRUPT IS STILL AN ANSWER. Silence
      // here read to the operator as a stop that had worked, on a session
      // that had never been running. One receipt per epoch, so holding the
      // button down cannot bury the transcript under its own refusals.
      if (core.alive && core.idleInterruptNotedEpoch !== core.turnEpoch) {
        core.idleInterruptNotedEpoch = core.turnEpoch
        publishSystemNote(
          core,
          `claude-sdk-interrupt-idle-${core.sessionId}-${core.turnEpoch}`,
          'Interrupt refused: no turn was in flight.',
        )
      }
      return
    }
    await requestInterrupt(core)
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

  /**
   * TYPE ONE USER LINE, AND SAY WHAT THE CLI DID WITH IT (POD-4836).
   *
   * The line carries a uuid derived from the message id, so the history entry
   * it becomes is named by our id, and every attempt at the same message names
   * the same entry. The receipt waits for the CLI's own ack of that uuid
   * (`ClaudeSdkTurnHandle.accepted`); until then the session is `delivering` —
   * not in a turn, but taken. The turn opens on the ack. Only a line never
   * written can be refused if the attempt fails before it.
   *
   * The ack proves only custody in memory. A duplicate may also be queued
   * or running without a record. Only the session file can name its entry;
   * the held receipt is followed by onTranscriptItem when that proof arrives.
   */
  async function deliver(
    core: SessionCore,
    input: TurnInput,
    options: SendOptions,
  ): Promise<TurnReceipt> {
    const userItemId =
      input.id !== undefined ? claudeUserMessageUuid(input.id) : globalThis.crypto.randomUUID()
    // Set when the turn opens: every provider callback before that is dropped
    // (none is expected — the CLI acks the line before it calls the model).
    let epoch = -1
    let child: ClaudeSdkTurnHandle
    options.onTypingStarted?.()
    try {
      child = host.startTurn({
        sessionId: core.sessionId,
        spec: core.spec,
        turn: input,
        resumeValue: core.binding.resume?.value ?? host.mintResumeValue(),
        newConversation: !core.conversationStarted,
        userMessageUuid: userItemId,
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
        onToolCall(call) {
          if (!core.turnOpen || core.turnEpoch !== epoch) return
          publishToolCall(core, call)
        },
        onToolResult(result) {
          if (!core.turnOpen || core.turnEpoch !== epoch) return
          publishToolResult(core, result)
        },
      })
    } catch (error) {
      return {
        outcome: 'refused',
        refusal: refuse('not_running', error instanceof Error ? error.message : String(error)),
      }
    }
    const acked = child.accepted
    core.delivering = acked.catch(() => undefined)
    core.active = child
    try {
      // A skipped duplicate resolves here too: its `done` has already settled
      // empty, and closes the turn this opens.
      await acked
    } catch (error) {
      core.delivering = undefined
      if (core.active === child) core.active = undefined
      void child.dispose?.()
      void drain(core)
      // ONLY A LINE NEVER WRITTEN IS A "NO" (POD-4839). A line on the CLI's
      // stdin may be in the transcript whatever ended the turn before its
      // ack — the process exiting, an error result (an HTTP 400 left the
      // prompt recorded, POD-4834) — so that failure is unproven, never a
      // refusal the sender would read as safe to resend.
      if (!wasNeverSent(error)) {
        // WRITTEN, NEVER ACKED: `unverified`. Keep watching for its record, or
        // for the exit that lets the history say it is not there (POD-4887).
        if (!core.disposed && (options.onLateProof || options.onUnrecorded)) {
          watchReceipt(core, userItemId, options, child.exited, true)
        }
        throw new DeliveryUnprovenError('claude-sdk send', error)
      }
      return {
        outcome: 'refused',
        refusal: refuse('not_running', error instanceof Error ? error.message : String(error)),
      }
    }
    core.delivering = undefined
    if (core.disposed) {
      options.onUnrecorded?.('Claude session closed before its transcript record was seen')
    } else {
      watchReceipt(core, userItemId, options, child.exited)
    }
    if (!core.alive) {
      // Stopped while the ack was on its way: the CLI took the line, so it is
      // accepted, but no turn opens on a session that has ended.
      return accepted(options, userItemId, core.turnEpoch)
    }
    epoch = openTurn(core, options.origin)
    core.partialText = ''
    core.partialItemId = `claude-sdk-${core.sessionId}-${epoch}`
    core.textDeliveries += 1
    core.lastRequestedModel = input.overrides?.supported ? input.overrides.value : core.spec.model
    core.conversationStarted = true
    void child.done.then(
      (result) => {
        if (!core.turnOpen || core.turnEpoch !== epoch) return
        core.binding = {
          ...core.binding,
          resume: { kind: 'claude-session', value: result.resumeValue },
        }
        const text = result.output || core.partialText
        if (result.observedModel) {
          host.reportObservedConfiguration?.({
            sessionId: core.sessionId,
            model: result.observedModel,
            ...(result.observedEffort ? { effort: result.observedEffort } : {}),
          })
        }
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
    return accepted(options, userItemId, epoch)
  }

  function accepted(options: SendOptions, userItemId: string, turnEpoch: number): TurnReceipt {
    return {
      outcome: 'accepted',
      turnEpoch,
      deliveredAs: options.delivery === 'steer' ? 'queue' : options.delivery,
      // The CLI's own ack of the line's uuid (`command_lifecycle`, or its
      // echo): a protocol acknowledgement, not a callback returning.
      provenBy: 'protocol-ack',
      held: 'memory',
      // The uuid the CLI keeps the line under, text or not (POD-4841).
      harnessRef: [{ kind: 'claude-uuid', id: userItemId }],
      at: host.now(),
    }
  }

  /** Taken by a turn, or by a line the CLI has not acked yet. */
  const busy = (core: SessionCore): boolean => core.turnOpen || core.delivering !== undefined

  async function drain(core: SessionCore): Promise<void> {
    if (!core.alive || busy(core) || core.interactions.size > 0) return
    const next = core.queue.shift()
    if (!next) return
    const receipt = await deliver(core, next.input, {
      ...next.options,
      delivery: 'when-ready',
    }).catch(() => undefined)
    if (!receipt || receipt.outcome === 'refused') abandonTurn(core, next, 'delivery-failed')
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
    if (core.receiptTimer) clearTimeout(core.receiptTimer)
    core.receiptTimer = undefined
    const held = [...core.heldMessages]
    core.heldMessages.clear()
    for (const message of held) {
      // Podium ending the session proves nothing; a late watch just ends.
      if (message.late) continue
      message.options.onUnrecorded?.('Claude session closed before its transcript record was seen')
    }
    core.alive = false
    core.turnOpen = false
    core.fenced.add(core.turnEpoch)
    core.active = undefined
    abandonQueue(core, 'teardown')
    if (exit) push(core, exit)
    core.disposed = true
    core.interactions.clear()
    core.interactionResponders.clear()
    slots.release(core.sessionId)
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
        const engine = host.processFor?.(core.sessionId)
        return engine ? { ...core.binding, process: engine } : core.binding
      },
      async stop() {
        assertCurrent()
        parked.delete(core.sessionId)
        const active = core.active
        end(core, {
          t: 'process',
          ev: { ev: 'exited', code: 0, signal: null, classification: 'clean' },
        })
        await active?.interrupt()
        await active?.dispose?.()
        await host.stopEngine?.(core.sessionId, true)
      },
      async hibernate() {
        assertCurrent()
        if (!core.binding.resume) return refuse('no_resume_ref')
        const active = core.active
        parked.set(core.sessionId, { spec: core.spec, binding: core.binding })
        end(core)
        await active?.interrupt()
        await active?.dispose?.()
        await host.stopEngine?.(core.sessionId, false)
        return { ok: true as const }
      },
      async kill() {
        assertCurrent()
        parked.delete(core.sessionId)
        const active = core.active
        end(core, {
          t: 'process',
          ev: { ev: 'exited', code: null, signal: 'SIGKILL', classification: 'killed' },
        })
        await active?.interrupt()
        await active?.dispose?.()
        await host.stopEngine?.(core.sessionId, true)
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
        if (options.signal?.aborted)
          return { outcome: 'refused', refusal: { reason: 'not_running' } }
        if (options.deliveryAttempt && (busy(core) || core.lease?.kind === 'human-controller')) {
          return { outcome: 'refused', refusal: { reason: busy(core) ? 'busy' : 'lease_held' } }
        }
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
          options.delivery === 'steer' || (options.delivery === 'interrupt' && !busy(core))
            ? options.delivery === 'interrupt'
              ? 'when-ready'
              : 'queue'
            : options.delivery
        if (busy(core)) {
          core.queue.push({ input, options })
          if (options.delivery === 'interrupt') await interruptTurn(core)
          return {
            outcome: 'queued',
            position: core.queue.length,
            deliveredAs: options.delivery === 'at-boundary' ? 'at-boundary' : 'queue',
            at: host.now(),
          }
        }
        if (deliveredAs === 'queue' || (deliveredAs === 'at-boundary' && core.queue.length > 0)) {
          core.queue.push({ input, options })
          const position = core.queue.length
          void drain(core)
          return {
            outcome: 'queued',
            position,
            deliveredAs: options.delivery === 'at-boundary' ? 'at-boundary' : 'queue',
            at: host.now(),
          }
        }
        return deliver(core, input, { ...options, delivery: deliveredAs })
      },
      async stageAttachment(): Promise<AttachmentStageResult> {
        return refuse('unsupported', 'the Claude SDK adapter has no typed attachment channel')
      },
      async interrupt() {
        assertCurrent()
        await interruptTurn(core)
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
        async history(range) {
          const resume = core.binding.resume
          if (!resume) return { items: [], hasMore: false }
          return host.readTranscript({
            sessionId: core.sessionId,
            workdir: core.spec.workdir,
            resumeValue: resume.value,
            range,
          })
        },
      },
      async attach() {
        return refuse('unsupported', 'the Claude stream engine has no attach endpoint')
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
          return refuse('unsupported', 'the Claude stream engine has no composer')
        },
        async set() {
          return refuse('unsupported', 'the Claude stream engine has no composer')
        },
      },
      /**
       * STICKY MODEL AND EFFORT, read fresh on every `startTurn` (POD-3081).
       *
       * "Pinned per turn" was the old refusal, and it described the SDK
       * accurately while drawing the wrong conclusion from it. Each turn here
       * opens its own `query()`, and `claude-sdk-driver.ts` builds that query's
       * options from `input.spec.model` with `input.turn.overrides` taking
       * precedence. So a sticky change is a write to `core.spec.model`: the next
       * turn's query is constructed with it, the one after that too, and a
       * per-turn override still wins for exactly its own turn.
       *
       * `next-turn` is the literal truth on this driver rather than a
       * conservative label. A turn in flight is an open `query()` whose options
       * were fixed when it was constructed; nothing can move it, and this call
       * does not cancel it to make the change look instant.
       *
       * `permissionMode` refuses. The SDK does take one per query, so it would
       * be easy to accept — and that is the trap: `spec.permissionMode` is the
       * daemon host's field, sourced from the session's authorization, and
       * letting the runtime contract rewrite it would put a permission
       * escalation behind a settings control. It stays out until it has an
       * authorization story, and until then the honest answer is that this verb
       * does not change it.
       */
      async configure(request: ConfigureRequest) {
        const declared = claudeSdkCapabilities().configure
        if (!declared.supported) return refuse('unsupported', declared.reason)
        if (!core.alive || core.disposed) {
          return refuse('not_running', 'this Claude SDK session has ended')
        }
        const decision = decideConfigure({
          declared: declared.value,
          request,
          policy: core.spec.model,
          checks: CLAUDE_SDK_CONFIGURE_CHECKS,
        })
        if (!('ok' in decision)) return decision
        core.spec = { ...core.spec, model: decision.policy }
        return { ok: true as const }
      },
      async usage() {
        return refuse('unsupported', 'SDK usage is not normalized')
      },
    }
    slots.set(core.sessionId, handle)
    const queued = withDeliveryQueue(
      handle,
      (event) => push(core, event),
      undefined,
      () => core.alive,
      slots.deliveryJournal?.(core.sessionId),
    )
    const send = queued.send.bind(queued)
    queued.send = (input, options) =>
      send(
        // Claude ignores a repeated uuid even while queued/running and after
        // resume (POD-4819 §3.8, measured on 2.1.284). Clear the shared queue's
        // recovery stop only when this line carries that stable message id.
        input.deliveryRecovery && input.id !== undefined
          ? { ...input, deliveryRecovery: false }
          : input,
        options,
      )
    return queued
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
        family: 'server',
        harness: 'claude-code',
        workdir: spec.workdir,
        resume,
        ...(spec.principal ? { principal: spec.principal } : {}),
        // The key is fixed for the session's life: the engine's durable
        // label where an engine host answers, the in-memory key otherwise.
        process: { key: host.processFor?.(sessionId).key ?? `claude-sdk:${sessionId}` },
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
      interruptsInFlight: 0,
      idleInterruptNotedEpoch: -1,
      partialText: '',
      partialItemId: '',
      publishedToolItems: new Set<string>(),
      publishedPromptItems: new Set<string>(),
      heldMessages: new Set(),
      receiptReading: false,
      receiptPollMs: 100,
      handleGeneration: 0,
      textDeliveries: 0,
      conversationStarted: !fresh,
    }
    parked.delete(sessionId)
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
    family: 'server',
    capabilities: claudeSdkCapabilities,
    async create(spec) {
      return createWithId(host.mintSessionId(), spec)
    },
    async resume(ref, spec) {
      return resumeWithId(host.mintSessionId(), ref, spec)
    },
    async adopt(binding) {
      const park = parked.get(binding.sessionId)
      if (
        !processCores.has(binding.process.key) &&
        park?.binding.resume &&
        park.binding.process.key === binding.process.key
      ) {
        // WAKE A HIBERNATED SESSION: same id, same conversation, same sticky
        // model — a new binding, so a stale one stays rejectable.
        const woken = newCore(binding.sessionId, park.spec, park.binding.resume, false)
        woken.binding = {
          ...woken.binding,
          bindingVersion: Math.max(binding.bindingVersion, park.binding.bindingVersion) + 1,
        }
        push(woken, {
          t: 'process',
          ev: { ev: 'adopted', bindingVersion: woken.binding.bindingVersion },
        })
        return makeHandle(woken)
      }
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
      return slots.get(sessionId)
    },
    bindings() {
      return slots.handles().map((handle) => handle.binding)
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
      if (event.ev === 'exited') {
        core.alive = false
        // The host's own report of the exit: the next read decides (POD-4887).
        for (const message of core.heldMessages) message.exited = true
        if (core.heldMessages.size > 0) rearmReceipts(core, 0)
      }
      push(core, { t: 'process', ev: event })
    },
    restartSupervisor() {
      for (const handle of slots.handles()) slots.release(handle.binding.sessionId, handle)
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
      parked.clear()
      for (const core of [...cores.values()]) {
        const active = core.active
        end(core)
        void active?.interrupt()
        void active?.dispose?.()
      }
      host.releaseEngines?.()
    },
  }
  return runtime
}
