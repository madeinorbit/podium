import type { SessionId, SessionOffer } from '@podium/model'
import type { HeadlessActivityEvent, TurnPreviewItem, TurnPreviewMessage } from '@podium/protocol'
import {
  action,
  computed,
  makeObservable,
  observable,
  observableRef,
  reaction,
  runInAction,
} from 'mobx'
import type { SuperagentTurnFailure } from '../api'
import type { SocketHub } from '../socket-transport/socket-hub'
import { transcriptActivitySignal, type TranscriptConnection } from '../transcript/contracts'
import { nativeSessionCanInterrupt, type ConversationContext } from './contracts'
import type { DraftStore } from './draft-store'
import {
  ConversationFrameScheduler,
  type ConversationFrameSchedulerOptions,
} from './frame-scheduler'
import { freezePlain } from './frozen'
import { Sends, type SendsOptions } from './sends'
import { TranscriptLog, type TranscriptChange, type TranscriptLogOptions } from './transcript-log'

export const TURN_PREVIEW_STALE_MS = 20_000

export interface TurnPreview {
  readonly turnEpoch: number
  readonly items: readonly TurnPreviewItem[]
}

export interface HeadlessOverlay {
  readonly text?: string
  readonly status?: string
  readonly label?: string
}

/** The addressed pool row. Reading this function in a reaction tracks its fields. */
export interface ConversationSession {
  status?: string
  lastActiveAt?: string | null
  busy?: boolean | null
  agentState?: { phase?: string; since?: string; error?: ConversationContext['agentError'] } | null
  offer?: SessionOffer | null
}

export interface ConversationOptions {
  sessionId: SessionId
  drafts: DraftStore
  transcript: Omit<TranscriptLogOptions, 'sessionId' | 'enqueueFrame' | 'onChange' | 'connection'>
  sends: Omit<SendsOptions, 'sessionId' | 'transcript' | 'drafts' | 'connection' | 'readContext'>
  readSession?: () => ConversationSession | undefined
  streamSessionId?: () => SessionId | undefined
  readTurnRunning?: () => boolean | undefined
  /** Hosts can supply headless/thread context while native context comes from the row. */
  readContext?: () => ConversationContext
  connection?: TranscriptConnection
  hub?: Pick<SocketHub, 'on'>
  scheduler?: ConversationFrameSchedulerOptions
  headless?: boolean
  initialTurnRunning?: boolean
  latestTurnFailure?: () => Promise<SuperagentTurnFailure | null>
  /** Platform presentation workers consume the same atomic transcript change. */
  onTranscriptChange?: (change: TranscriptChange) => void
}

/** One session or superagent thread, shared across screens for one principal. */
export class Conversation {
  readonly sessionId: SessionId
  readonly transcript: TranscriptLog
  readonly sends: Sends
  preview: TurnPreview | null = null
  headless: HeadlessOverlay | null = null
  turnRunning: boolean
  turnError: string | null = null
  restoredFailure: SuperagentTurnFailure | null = null
  private readonly frames: ConversationFrameScheduler
  private readonly stops: (() => void)[] = []
  private started = false
  private disposed = false
  private startPromise: Promise<void> | undefined
  private seenPreview: { turnEpoch: number; seq: number } | null = null
  private previewDoneEpoch = -Infinity
  private previewTimer: ReturnType<typeof setTimeout> | undefined
  private activityVersion = 0
  private restoringFailure = false
  private failureRestored = false

  constructor(private readonly options: ConversationOptions) {
    this.sessionId = options.sessionId
    this.turnRunning = options.initialTurnRunning === true
    this.frames = new ConversationFrameScheduler(options.scheduler)
    makeObservable<this, 'applyPreview' | 'applyHeadless' | 'clearPreview' | 'transcriptChanged'>(
      this,
      {
        preview: observableRef,
        headless: observableRef,
        turnRunning: observable,
        turnError: observable,
        restoredFailure: observableRef,
        draft: computed,
        status: computed,
        context: computed,
        visibleFailure: computed,
        applyPreview: action,
        applyHeadless: action,
        clearPreview: action,
        transcriptChanged: action,
        setTurnError: action,
        finishTurn: action,
        clear: action,
        clearTurnFailure: action,
      },
    )
    this.transcript = new TranscriptLog({
      ...options.transcript,
      sessionId: options.sessionId,
      connection: options.connection,
      questions: ['userEcho', 'latestRecordedAt'],
      enqueueFrame: (items, meta) => this.frames.enqueue(() => this.transcript.merge(items, meta)),
      onChange: (change) => this.transcriptChanged(change),
    })
    this.sends = new Sends({
      ...options.sends,
      sessionId: options.sessionId,
      transcript: this.transcript,
      drafts: options.drafts,
      connection: options.connection,
      readContext: () => this.context,
      deliver: (turn) => {
        this.clearTurnFailure()
        return options.sends.deliver(turn)
      },
    })
  }

  get draft(): string {
    return this.options.drafts.get(this.sessionId)
  }
  set draft(text: string) {
    this.options.drafts.set(this.sessionId, text)
  }
  get status(): string | undefined {
    return this.options.readSession?.()?.status
  }
  get context(): ConversationContext {
    if (this.options.readContext) return this.options.readContext()
    const session = this.options.readSession?.()
    return {
      agentSince: session?.agentState?.since,
      agentPhase: session?.agentState?.phase,
      agentError: session?.agentState?.error,
      offer: session?.offer,
      canInterrupt: this.options.headless
        ? this.turnRunning
        : nativeSessionCanInterrupt(session?.status),
      latestOperatorPrompt: this.transcript.latestOperatorPrompt,
    }
  }

  get visibleFailure(): SuperagentTurnFailure | null {
    if (!this.options.headless || this.turnRunning || !this.restoredFailure) return null
    const failureAt = Date.parse(this.restoredFailure.at)
    return Number.isFinite(failureAt) && (this.transcript.latestRecordedAt ?? -Infinity) > failureAt
      ? null
      : this.restoredFailure
  }

  start(): Promise<void> {
    if (this.disposed) return Promise.resolve()
    if (this.started) return this.startPromise ?? Promise.resolve()
    this.started = true
    const hub = this.options.hub
    if (hub) {
      this.stops.push(
        hub.on('turnPreview', (sessionId, frame) => {
          if (
            sessionId ===
            (this.options.streamSessionId ? this.options.streamSessionId() : this.sessionId)
          )
            this.frames.enqueue(() => this.applyPreview(frame))
        }),
      )
      if (this.options.headless)
        this.stops.push(
          hub.on('headlessActivity', (sessionId, event) => {
            if (
              sessionId ===
              (this.options.streamSessionId ? this.options.streamSessionId() : this.sessionId)
            )
              this.frames.enqueue(() => this.applyHeadless(event))
          }),
        )
    }
    if (this.options.connection)
      this.stops.push(
        this.options.connection.subscribe((connected) => {
          if (connected) return
          this.frames.clear()
          this.previewDoneEpoch = -Infinity
          this.clearPreview()
        }),
      )
    this.stops.push(
      reaction(
        () => {
          const session = this.options.readSession?.()
          return {
            signal: transcriptActivitySignal(session ?? {}),
            live: this.options.headless
              ? this.turnRunning
              : nativeSessionCanInterrupt(session?.status),
          }
        },
        (activity) => this.transcript.observeActivity(activity),
        {
          fireImmediately: true,
          equals: (left, right) => left.signal === right.signal && left.live === right.live,
        },
      ),
    )
    this.sends.start()
    if (this.options.readTurnRunning) {
      let sawRunning = false
      this.stops.push(
        reaction(
          this.options.readTurnRunning,
          (running) => {
            if (running) {
              sawRunning = true
              runInAction(() => {
                this.turnRunning = true
                this.clearTurnFailure()
                this.sends.finishTurn(null)
              })
            } else if (running === false && sawRunning) {
              sawRunning = false
              this.finishTurn()
            }
          },
          { fireImmediately: true },
        ),
      )
    }
    this.startPromise = this.transcript.start()
    void this.restoreFailure()
    return this.startPromise
  }

  async restoreFailure(): Promise<void> {
    if (
      !this.options.headless ||
      !this.options.latestTurnFailure ||
      this.activityVersion > 0 ||
      this.restoringFailure ||
      this.failureRestored
    )
      return
    this.restoringFailure = true
    const version = this.activityVersion
    try {
      await this.startPromise
      if (this.disposed || version !== this.activityVersion || this.turnRunning) return
      const failure = await this.options.latestTurnFailure()
      this.failureRestored = true
      if (!this.disposed && version === this.activityVersion)
        runInAction(() => {
          this.restoredFailure = failure ? freezePlain(failure) : null
        })
    } catch {
      /* A failed read leaves the live conversation usable. */
    } finally {
      this.restoringFailure = false
    }
  }

  clear(): void {
    this.clearTurnFailure()
    this.finishTurn()
    this.transcript.merge([], { reset: true })
    this.sends.clear()
  }

  finishTurn(error: string | null = null): void {
    if (this.disposed) return
    this.turnRunning = false
    this.headless = null
    this.turnError = error
    this.sends.finishTurn(error)
  }

  setTurnError(message: string | null): void {
    if (!this.disposed) this.turnError = message
  }
  clearTurnFailure(): void {
    this.activityVersion++
    this.restoredFailure = null
    this.turnError = null
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.frames.dispose()
    for (const stop of this.stops.splice(0)) stop()
    this.disarmPreview()
    this.sends.dispose()
    this.transcript.dispose()
  }

  private transcriptChanged(change: TranscriptChange): void {
    // Cache hydration occurs before Sends is constructed. start() sets its baseline.
    this.sends?.reconcile(change)
    this.options.onTranscriptChange?.(change)
    if (change.added.length > 0 && this.headless?.text !== undefined) {
      this.headless = this.headless.status
        ? freezePlain({ status: this.headless.status, label: this.headless.label })
        : null
    }
  }

  private applyPreview(frame: TurnPreviewMessage): void {
    if (this.disposed || frame.turnEpoch <= this.previewDoneEpoch) return
    const seen = this.seenPreview
    if (frame.done) {
      if (seen && frame.turnEpoch < seen.turnEpoch) return
      this.previewDoneEpoch = frame.turnEpoch
      this.clearPreview()
      return
    }
    if (
      seen &&
      (frame.turnEpoch < seen.turnEpoch ||
        (frame.turnEpoch === seen.turnEpoch && frame.seq <= seen.seq))
    )
      return
    this.seenPreview = { turnEpoch: frame.turnEpoch, seq: frame.seq }
    this.disarmPreview()
    this.previewTimer = setTimeout(() => this.clearPreview(), TURN_PREVIEW_STALE_MS)
    this.previewTimer.unref?.()
    this.preview = frame.items.length
      ? freezePlain({ turnEpoch: frame.turnEpoch, items: frame.items })
      : null
  }

  private applyHeadless(event: HeadlessActivityEvent): void {
    if (this.disposed) return
    this.clearTurnFailure()
    switch (event.kind) {
      case 'turn-start':
        this.turnRunning = true
        this.headless = freezePlain({ status: 'starting…', label: 'starting' })
        break
      case 'turn-end':
        this.finishTurn(event.error ?? null)
        break
      case 'partial-text':
        this.turnRunning = true
        this.headless = freezePlain({ text: event.text })
        break
      case 'status':
        this.turnRunning = true
        this.headless = freezePlain({
          ...(this.headless?.text !== undefined ? { text: this.headless.text } : {}),
          label: event.label ?? event.status,
          status:
            event.status === 'tool'
              ? `running ${event.label ?? 'a tool'}…`
              : event.status === 'starting'
                ? 'starting…'
                : 'working…',
        })
    }
  }

  private clearPreview(): void {
    this.disarmPreview()
    this.seenPreview = null
    this.preview = null
  }
  private disarmPreview(): void {
    if (this.previewTimer !== undefined) clearTimeout(this.previewTimer)
    this.previewTimer = undefined
  }
}
