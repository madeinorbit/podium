import type { SessionId, SessionOffer, TranscriptItem, TranscriptTag } from '@podium/model'
import type { TranscriptState } from '../transcript'
import {
  type ConversationPendingTurn,
  type ConversationQueuedMessage,
  pairPendingWithConversationQueue,
  projectConversationQueue,
  queuedConversationMessages,
  reconcileConversationPending,
  reconcileConversationQueue,
} from './projection'

export interface ConversationTranscript {
  getSnapshot(): { items: readonly TranscriptItem[] }
  subscribe(listener: () => void): () => void
}

export interface ConversationDeliveryResult {
  state?: 'queued' | 'sent'
}

export interface ConversationSendInput {
  text: string
  wire?: string
  tags?: TranscriptTag[]
  toolPaths?: string[]
  files?: readonly { path: string }[]
  acceptsAppendedBrief?: boolean
}

export interface ConversationContext {
  agentSince?: string
  agentPhase?: string
  offer?: SessionOffer | null
  canInterrupt: boolean
  latestOperatorPrompt?: string | null
}

export interface ConversationClock {
  now(): number
  setTimeout(callback: () => void, delayMs: number): unknown
  clearTimeout(token: unknown): void
  setInterval(callback: () => void, delayMs: number): unknown
  clearInterval(token: unknown): void
}

export interface ConversationControllerOptions {
  sessionId: SessionId
  transcript: ConversationTranscript
  initialDraft?: string
  initialPending?: readonly ConversationPendingTurn[]
  initialJustSent?: boolean
  onDraftChange?: (text: string) => void
  createDeliveryId(): string
  deliver(turn: ConversationPendingTurn): Promise<ConversationDeliveryResult | void>
  readQueue?: () => Promise<unknown>
  retract?: (id: string) => Promise<void>
  dismissOffer?: (offerCreatedAt: string) => Promise<void>
  /** False when the adapter's durable outbox already projects the dismissal. */
  optimisticDismissOffer?: boolean
  interrupt?: (messageId?: string) => Promise<void>
  echoMode?: 'matching-user' | 'any-user'
  queueRefreshMs?: number
  queuedAckRefreshMs?: number
  pendingSettleMs?: number
  optimisticSendCeilingMs?: number
  clock?: ConversationClock
}

export interface ConversationState {
  sessionId: SessionId
  draft: string
  pending: ConversationPendingTurn[]
  queued: ConversationQueuedMessage[]
  projected: ReturnType<typeof projectConversationQueue>
  offer: SessionOffer | null
  dismissedOfferAt: string | null
  justSent: boolean
  canInterrupt: boolean
  interruptError: string | null
  interruptMessageId: string | null
}

interface OpenSend {
  seq: number
  since: string | null
  queuedBehindTurn: boolean
}

type Listener = () => void

const defaultClock: ConversationClock = {
  now: () => Date.now(),
  setTimeout: (callback, delayMs) => globalThis.setTimeout(callback, delayMs),
  clearTimeout: (token) => globalThis.clearTimeout(token as ReturnType<typeof setTimeout>),
  setInterval: (callback, delayMs) => globalThis.setInterval(callback, delayMs),
  clearInterval: (token) => globalThis.clearInterval(token as ReturnType<typeof setInterval>),
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export class ConversationController {
  private readonly listeners = new Set<Listener>()
  private readonly clock: ConversationClock
  private state: ConversationState
  private disposed = false
  private started = false
  private active = true
  private pendingSeq = 0
  private sendSeq = 0
  private queueReadSerial = 0
  private openSend: OpenSend | null = null
  private context: ConversationContext = { canInterrupt: false }
  private authoritativeOffer: SessionOffer | null = null
  private dismissedOfferAt: string | null = null
  private seenUserIds = new Set<string>()
  private seenUserTailId: string | null = null
  private userBaselineReady = false
  private unsubscribeTranscript: (() => void) | null = null
  private queueTimer: unknown = null
  private ackTimer: unknown = null
  private sendTimer: unknown = null
  private readonly settleTimers = new Map<string, unknown>()

  constructor(private readonly options: ConversationControllerOptions) {
    this.clock = options.clock ?? defaultClock
    const pending = [...(options.initialPending ?? [])]
    const queued: ConversationQueuedMessage[] = []
    if (options.initialJustSent) {
      this.openSend = { seq: 0, since: null, queuedBehindTurn: false }
    }
    this.state = {
      sessionId: options.sessionId,
      draft: options.initialDraft ?? '',
      pending,
      queued,
      projected: projectConversationQueue(pending, queued, options.transcript.getSnapshot().items),
      offer: null,
      dismissedOfferAt: null,
      justSent: options.initialJustSent === true,
      canInterrupt: false,
      interruptError: null,
      interruptMessageId: null,
    }
  }

  getSnapshot = (): ConversationState => this.state

  subscribe = (listener: Listener): (() => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  async start(): Promise<void> {
    if (this.started || this.disposed) return
    this.started = true
    this.observeTranscript(true)
    this.unsubscribeTranscript = this.options.transcript.subscribe(() => this.observeTranscript())
    await this.refreshQueue()
    this.armQueueTimer()
    this.armSendTimer()
  }

  setActive(active: boolean): void {
    if (this.active === active) return
    this.active = active
    this.armQueueTimer()
  }

  setDraft(text: string): void {
    if (this.state.draft === text) {
      this.options.onDraftChange?.(text)
      return
    }
    this.patch({ draft: text })
    this.options.onDraftChange?.(text)
  }

  /** Adopt a draft supplied by another surface without echoing it back. */
  replaceDraft(text: string): void {
    if (this.state.draft !== text) this.patch({ draft: text })
  }

  updateContext(context: ConversationContext): void {
    this.context = context
    this.authoritativeOffer = context.offer ?? null
    if (!this.authoritativeOffer || this.authoritativeOffer.createdAt !== this.dismissedOfferAt) {
      this.dismissedOfferAt = null
    }
    const offer =
      this.authoritativeOffer?.createdAt === this.dismissedOfferAt ? null : this.authoritativeOffer
    this.patch({
      offer,
      dismissedOfferAt: this.dismissedOfferAt,
      canInterrupt: context.canInterrupt,
    })
    this.reconcileOpenSend()
  }

  async submit(input: ConversationSendInput): Promise<ConversationPendingTurn | null> {
    const turn = this.createTurn(input, 'message')
    if (!turn) return null
    this.setDraft('')
    const retired = this.retireOffer()
    await this.dispatch(turn, retired, false)
    return turn
  }

  async sendOffer(prompt: string, offerCreatedAt: string): Promise<ConversationPendingTurn | null> {
    const turn = this.createTurn({ text: prompt, wire: prompt }, 'offer')
    if (!turn) return null
    this.dismissedOfferAt = offerCreatedAt
    this.patch({ offer: null, dismissedOfferAt: offerCreatedAt })
    await this.dispatch(turn, offerCreatedAt, true)
    return turn
  }

  async retry(id: string): Promise<void> {
    const turn = this.state.pending.find((candidate) => candidate.id === id)
    if (!turn || turn.state !== 'failed') return
    const next = { ...turn, state: 'sending' as const }
    delete next.error
    this.replacePending(next)
    await this.dispatch(next, null, false)
  }

  async retract(id: string): Promise<void> {
    if (!this.options.retract) return
    // Retire every ledger read that began before this cancellation. A slow
    // pre-retract response must not resurrect the row we just removed.
    this.queueReadSerial += 1
    const queued = this.state.queued
    const retracted = queued.find((message) => message.id === id)
    const linked = pairPendingWithConversationQueue(this.state.pending, queued).pending.find(
      (turn) => turn.durable?.id === id,
    )
    this.patch({
      queued: queued.filter((message) => message.id !== id),
      pending: linked
        ? this.state.pending.filter((turn) => turn.id !== linked.id)
        : this.state.pending,
    })
    try {
      await this.options.retract(id)
    } catch (error) {
      this.patch({
        queued:
          retracted && !this.state.queued.some((message) => message.id === id)
            ? [...this.state.queued, retracted].sort(
                (left, right) => left.at - right.at || left.id.localeCompare(right.id),
              )
            : this.state.queued,
        pending:
          linked && !this.state.pending.some((turn) => turn.id === linked.id)
            ? [...this.state.pending, linked].sort(
                (left, right) => left.at - right.at || left.id.localeCompare(right.id),
              )
            : this.state.pending,
      })
      void this.refreshQueue()
      throw error
    }
  }

  async dismissOffer(offerCreatedAt: string): Promise<void> {
    if (!this.options.dismissOffer) return
    if (this.options.optimisticDismissOffer === false) {
      await this.options.dismissOffer(offerCreatedAt)
      return
    }
    this.dismissedOfferAt = offerCreatedAt
    this.patch({ offer: null, dismissedOfferAt: offerCreatedAt })
    try {
      await this.options.dismissOffer(offerCreatedAt)
    } catch (error) {
      if (this.dismissedOfferAt === offerCreatedAt) {
        this.dismissedOfferAt = null
        this.patch({ offer: this.authoritativeOffer, dismissedOfferAt: null })
      }
      throw error
    }
  }

  async interrupt(draft = this.state.draft): Promise<boolean> {
    if (!this.context.canInterrupt || !this.options.interrupt) return false
    this.patch({ interruptError: null })
    if (draft === '' && this.context.latestOperatorPrompt) {
      this.setDraft(this.context.latestOperatorPrompt)
    }
    try {
      const messageId = this.state.interruptMessageId
      await this.options.interrupt(messageId ?? undefined)
      this.markInterrupted(messageId ?? undefined)
      return true
    } catch (error) {
      this.patch({ interruptError: errorText(error) })
      return false
    }
  }

  markInterrupted(deliveryId?: string, interruptedAt?: number): void {
    const beforeInterrupt = (at: number): boolean =>
      interruptedAt === undefined || at <= interruptedAt
    const queued = deliveryId
      ? this.state.queued.find((message) => message.id === deliveryId)
      : this.state.queued.findLast((message) => beforeInterrupt(message.at))
    const index = deliveryId
      ? this.state.pending.findIndex((turn) => turn.deliveryId === deliveryId)
      : this.state.pending.findLastIndex(
          (turn) => turn.state !== 'failed' && beforeInterrupt(turn.at),
        )
    let pending = this.state.pending
    if (index < 0 && queued) {
      pending = [
        ...pending,
        {
          id: `interrupted-${queued.id}`,
          deliveryId: queued.id,
          text: queued.text,
          wire: queued.text,
          at: queued.at,
          state: 'interrupted',
          kind: 'message',
        },
      ]
    } else if (index >= 0 && pending[index]?.state !== 'interrupted') {
      pending = pending.map((turn, candidate) =>
        candidate === index ? { ...turn, state: 'interrupted' } : turn,
      )
    }
    this.patch({
      pending,
      queued: queued
        ? this.state.queued.filter((message) => message.id !== queued.id)
        : this.state.queued,
    })
  }

  async refreshQueue(): Promise<void> {
    if (!this.options.readQueue || this.disposed) return
    const serial = ++this.queueReadSerial
    try {
      const rows = await this.options.readQueue()
      if (this.disposed || serial !== this.queueReadSerial) return
      this.patch({ queued: queuedConversationMessages(rows, this.options.sessionId) })
    } catch {
      // Keep the last durable projection. Transcript and sending remain usable.
    }
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.unsubscribeTranscript?.()
    this.unsubscribeTranscript = null
    this.clearTimer('queue')
    this.clearTimer('ack')
    this.clearTimer('send')
    for (const token of this.settleTimers.values()) this.clock.clearTimeout(token)
    this.settleTimers.clear()
    this.listeners.clear()
  }

  private createTurn(
    input: ConversationSendInput,
    kind: ConversationPendingTurn['kind'],
  ): ConversationPendingTurn | null {
    const text = input.text.trim()
    const wire = (input.wire ?? input.text).trim()
    if (!wire) return null
    const turn: ConversationPendingTurn = {
      id: `pending-${++this.pendingSeq}`,
      deliveryId: this.options.createDeliveryId(),
      text,
      wire,
      at: this.clock.now(),
      state: 'sending',
      kind,
      ...(input.tags && input.tags.length > 0 ? { tags: input.tags } : {}),
      ...(input.toolPaths && input.toolPaths.length > 0 ? { toolPaths: input.toolPaths } : {}),
      ...(input.files && input.files.length > 0 ? { files: input.files } : {}),
      ...(input.acceptsAppendedBrief ? { acceptsAppendedBrief: true } : {}),
    }
    this.patch({ pending: [...this.state.pending, turn] })
    return turn
  }

  private async dispatch(
    turn: ConversationPendingTurn,
    retiredOfferAt: string | null,
    rethrow: boolean,
  ): Promise<void> {
    const sendSeq = this.markSent()
    this.armSettle(turn.id)
    try {
      const result = await this.options.deliver(turn)
      if (result?.state) this.replacePending({ ...turn, state: result.state })
      if (result?.state === 'queued') {
        this.armAckTimer()
        void this.refreshQueue()
      }
    } catch (error) {
      this.replacePending({ ...turn, state: 'failed', error: errorText(error) })
      this.clearOpenSend(sendSeq)
      if (retiredOfferAt && this.dismissedOfferAt === retiredOfferAt) {
        this.dismissedOfferAt = null
        this.patch({ offer: this.authoritativeOffer, dismissedOfferAt: null })
      }
      if (rethrow) throw error
    }
  }

  private replacePending(turn: ConversationPendingTurn): void {
    this.patch({
      pending: this.state.pending.map((candidate) =>
        candidate.id !== turn.id ||
        (candidate.state === 'interrupted' && turn.state !== 'interrupted')
          ? candidate
          : turn,
      ),
    })
  }

  private retireOffer(): string | null {
    const offer = this.authoritativeOffer
    if (!offer || this.dismissedOfferAt === offer.createdAt) return null
    this.dismissedOfferAt = offer.createdAt
    this.patch({ offer: null, dismissedOfferAt: offer.createdAt })
    return offer.createdAt
  }

  private observeTranscript(baseline = false): void {
    const items = this.options.transcript.getSnapshot().items
    const users = items.filter((item) => item.role === 'user')
    if (baseline || !this.userBaselineReady) {
      this.seenUserIds = new Set(users.map((item) => item.id))
      this.seenUserTailId = users.at(-1)?.id ?? null
      this.userBaselineReady = true
      this.patch({})
      return
    }
    const previousTail = this.seenUserTailId
    const tailIndex =
      previousTail === null ? -1 : users.findIndex((item) => item.id === previousTail)
    const appended = previousTail === null ? users : tailIndex < 0 ? [] : users.slice(tailIndex + 1)
    const fresh = appended.filter((item) => !this.seenUserIds.has(item.id))
    for (const item of users) this.seenUserIds.add(item.id)
    this.seenUserTailId = users.at(-1)?.id ?? null
    if (fresh.length > 0) {
      const conversational = fresh.filter((item) => item.event !== 'interrupt')
      const interruptItem = fresh.findLast((item) => item.event === 'interrupt')
      if (interruptItem) {
        const interruptedAt = interruptItem.ts ? Date.parse(interruptItem.ts) : Number.NaN
        this.markInterrupted(undefined, Number.isFinite(interruptedAt) ? interruptedAt : undefined)
      }
      this.patch({
        pending: reconcileConversationPending(
          this.state.pending,
          conversational,
          this.options.echoMode,
        ),
        queued: reconcileConversationQueue(this.state.queued, conversational),
      })
    } else {
      this.patch({})
    }
  }

  private markSent(): number {
    const seq = ++this.sendSeq
    this.openSend = {
      seq,
      since: this.context.agentSince ?? null,
      queuedBehindTurn:
        this.context.agentPhase === 'working' || this.context.agentPhase === 'compacting',
    }
    this.patch({ justSent: true })
    this.armSendTimer()
    return seq
  }

  private reconcileOpenSend(): void {
    const open = this.openSend
    if (!open) return
    if ((this.context.agentSince ?? null) !== open.since) {
      if (open.queuedBehindTurn && this.context.agentPhase === 'idle') {
        this.openSend = {
          ...open,
          since: this.context.agentSince ?? null,
          queuedBehindTurn: false,
        }
        this.armSendTimer()
        return
      }
      this.openSend = null
      this.clearTimer('send')
      this.patch({ justSent: false })
      return
    }
    this.armSendTimer()
  }

  private clearOpenSend(seq: number): void {
    if (this.openSend?.seq !== seq) return
    this.openSend = null
    this.clearTimer('send')
    this.patch({ justSent: false })
  }

  private armSendTimer(): void {
    this.clearTimer('send')
    const open = this.openSend
    if (!open) return
    if (
      open.queuedBehindTurn &&
      (this.context.agentPhase === 'working' || this.context.agentPhase === 'compacting')
    ) {
      return
    }
    const seq = open.seq
    this.sendTimer = this.clock.setTimeout(
      () => this.clearOpenSend(seq),
      this.options.optimisticSendCeilingMs ?? 30_000,
    )
  }

  private armSettle(id: string): void {
    const previous = this.settleTimers.get(id)
    if (previous) this.clock.clearTimeout(previous)
    const token = this.clock.setTimeout(() => {
      this.settleTimers.delete(id)
      const turn = this.state.pending.find((candidate) => candidate.id === id)
      if (turn?.state === 'sending') this.replacePending({ ...turn, state: 'sent' })
    }, this.options.pendingSettleMs ?? 30_000)
    this.settleTimers.set(id, token)
  }

  private armQueueTimer(): void {
    this.clearTimer('queue')
    if (!this.active || !this.options.readQueue) return
    this.queueTimer = this.clock.setInterval(
      () => void this.refreshQueue(),
      this.options.queueRefreshMs ?? 5_000,
    )
  }

  private armAckTimer(): void {
    this.clearTimer('ack')
    if (!this.active || !this.options.readQueue) return
    this.ackTimer = this.clock.setInterval(
      () => void this.refreshQueue(),
      this.options.queuedAckRefreshMs ?? 1_000,
    )
  }

  private clearTimer(kind: 'queue' | 'ack' | 'send'): void {
    if (kind === 'queue' && this.queueTimer !== null) {
      this.clock.clearInterval(this.queueTimer)
      this.queueTimer = null
    }
    if (kind === 'ack' && this.ackTimer !== null) {
      this.clock.clearInterval(this.ackTimer)
      this.ackTimer = null
    }
    if (kind === 'send' && this.sendTimer !== null) {
      this.clock.clearTimeout(this.sendTimer)
      this.sendTimer = null
    }
  }

  private patch(patch: Partial<ConversationState>): void {
    const pending = patch.pending ?? this.state.pending
    const queued = patch.queued ?? this.state.queued
    const latestPending = pending.findLast((turn) => turn.state !== 'failed')
    const interruptMessageId =
      latestPending?.state === 'interrupted'
        ? null
        : (latestPending?.deliveryId ?? queued.at(-1)?.id ?? null)
    this.state = {
      ...this.state,
      ...patch,
      interruptMessageId,
      projected: projectConversationQueue(
        pending,
        queued,
        this.options.transcript.getSnapshot().items,
      ),
    }
    if (!this.state.pending.some((turn) => turn.state === 'queued')) this.clearTimer('ack')
    for (const listener of this.listeners) listener()
  }
}

export function createConversationController(
  options: ConversationControllerOptions,
): ConversationController {
  return new ConversationController(options)
}

export function nativeSessionCanInterrupt(status: string | undefined): boolean {
  return status === 'live' || status === 'starting'
}

export function headlessConversationCanInterrupt(
  hasThread: boolean,
  turnRunning: boolean,
): boolean {
  return hasThread && turnRunning
}
