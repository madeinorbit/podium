import type {
  MessageRecordWire,
  SessionId,
  SessionOffer,
  TranscriptItem,
  TranscriptTag,
} from '@podium/model'
import { formatAgentError } from '@podium/model'
import type { RuntimeAttachmentRef } from '@podium/protocol/daemon'
import type { OutboxChatSend } from '../engine/chat-send'
import {
  type ConversationBubble,
  type ConversationPendingTurn,
  projectConversation,
} from './projection'

import {
  action,
  actionBound,
  computed,
  makeObservable,
  observable,
  observableRef,
  observableShallow,
  reaction,
  runInAction,
} from 'mobx'
import type {
  ConversationSendOptions,
  ConversationContext,
  ConversationClock,
  ConversationSendInput,
} from './contracts'
import { CATCH_UP_BATCH, NOT_STORED } from './contracts'
import type { DraftStore } from './draft-store'
import type { TranscriptChange, TranscriptLog } from './transcript-log'
import { freezePlain } from './frozen'

export interface SendsOptions extends ConversationSendOptions {
  transcript: TranscriptLog
  drafts: Pick<DraftStore, 'get' | 'set'>
  /** Reads the observable pool session row; no updateContext pushes. */
  readContext: () => ConversationContext
}

interface OpenSend {
  seq: number
  since: string | null
  queuedBehindTurn: boolean
}

const defaultClock: ConversationClock = {
  now: () => Date.now(),
  setTimeout: (callback, delayMs) => globalThis.setTimeout(callback, delayMs),
  clearTimeout: (token) => globalThis.clearTimeout(token as ReturnType<typeof setTimeout>),
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export class Sends {
  readonly pending = observable.array<ConversationPendingTurn>([], { deep: false })
  offer: SessionOffer | null = null
  dismissedOfferAt: string | null = null
  justSent = false
  interruptError: string | null = null
  interruptMessageId: string | null = null
  private readonly clock: ConversationClock
  private disposed = false
  private started = false
  private stoppedBubbles: ConversationBubble[] = []
  private feedRecords: readonly MessageRecordWire[] = []
  private pendingSeq = 0
  private sendSeq = 0
  private openSend: OpenSend | null = null
  private authoritativeOffer: SessionOffer | null = null
  private readonly seenUserIds = observable.set<string>([], { deep: false })
  private seenUserTailId: string | null = null
  private userBaselineReady = false
  private readonly unsubscribes: (() => void)[] = []
  private sendTimer: unknown = null
  /** Turns whose delivery is being awaited, so a restart does not wait twice. */
  private readonly following = new Set<string>()
  /** Message ids whose record this view has seen at all, and seen before it
   *  was confirmed. A local turn whose record came and went has left the feed;
   *  a confirmed record never seen open is history and shows no bubble. */
  private readonly seenRecord = new Set<string>()
  private readonly seenOpen = observable.set<string>([], { deep: false })
  /**
   * Message ids whose notice is being dismissed. Hidden while the request is in
   * flight (`null`), and after the server agreed, until its record leaves the
   * feed or moves on from the status it had then — the answer and the feed's
   * update travel separately, and the bubble must not flash back between them.
   */
  private readonly hidden = observable.map<string, MessageRecordWire['status'] | null>(undefined, {
    deep: false,
  })
  /**
   * This device's retracts (POD-4776): in flight, or answered but not yet on
   * the record (`{}`), until the record carries the request or leaves; or
   * failed, with why, until the next attempt.
   */
  private readonly retracting = observable.map<string, { error?: string }>(undefined, {
    deep: false,
  })
  /**
   * Records read by id for this device's own sends the feed does not carry
   * (POD-4811). Each stands in for the feed's record of that message while a
   * local turn still shows it; the feed's own record wins whenever it has one.
   */
  private readonly looked = observable.map<string, MessageRecordWire>(undefined, { deep: false })
  /** A catch-up read is in flight; one asked for meanwhile runs after it. */
  private catchingUp = false
  private catchUpAgain = false

  constructor(private readonly options: SendsOptions) {
    this.clock = options.clock ?? defaultClock
    const pending = [...(options.initialPending ?? [])]
    runInAction(() => {
      for (const turn of pending) this.seenOpen.add(turn.deliveryId)
    })
    if (options.initialJustSent) {
      this.openSend = { seq: 0, since: null, queuedBehindTurn: false }
    }
    runInAction(() => this.pending.replace(pending.map(freezePlain)))
    this.justSent = options.initialJustSent === true
    makeObservable<
      this,
      | 'started'
      | 'feedRecords'
      | 'patch'
      | 'observeRecords'
      | 'observeOutbox'
      | 'observeContext'
      | 'settleFromLookup'
    >(this, {
      pending: observableShallow,
      offer: observableRef,
      dismissedOfferAt: observable,
      justSent: observable,
      interruptError: observable,
      interruptMessageId: observable,
      started: observable,
      feedRecords: observableRef,
      context: computed,
      canInterrupt: computed,
      bubbles: computed,
      start: action,
      stop: action,
      reconcile: action,
      submit: action,
      sendOffer: action,
      retry: action,
      discard: action,
      sendAgain: action,
      retract: action,
      dismissOffer: action,
      interrupt: action,
      markInterrupted: action,
      finishTurn: action,
      clear: action,
      patch: action,
      observeRecords: actionBound,
      observeOutbox: actionBound,
      observeContext: actionBound,
      settleFromLookup: action,
    })
    this.observeRecords(false)
  }

  get context(): ConversationContext {
    return this.options.readContext()
  }
  get canInterrupt(): boolean {
    return this.context.canInterrupt
  }
  get draft(): string {
    return this.options.drafts.get(this.options.sessionId)
  }
  setDraft(text: string): void {
    if (!this.disposed) this.options.drafts.set(this.options.sessionId, text)
  }

  get bubbles(): ConversationBubble[] {
    if (!this.started) return this.stoppedBubbles
    return projectConversation({
      turns: this.pending,
      records: this.currentRecords(),
      transcriptIds: this.options.transcript.byId,
      seenOpen: this.seenOpen,
      seenHistory: this.seenUserIds,
      hidden: new Set(this.hidden.keys()),
      retracting: this.retracting,
    })
  }

  start(): void {
    if (this.started || this.disposed) return
    this.started = true
    this.reconcile({ changed: this.options.transcript.items, added: [], rebuild: true }, true)
    this.unsubscribes.push(
      reaction(
        () => this.context,
        (context) => this.observeContext(context),
        { fireImmediately: true },
      ),
    )
    if (this.options.records) {
      this.unsubscribes.push(this.options.records.subscribe(() => this.observeRecords()))
    }
    if (this.options.outbox) {
      this.unsubscribes.push(this.options.outbox.subscribe(() => this.observeOutbox()))
    }
    this.observeRecords()
    const connection = this.options.connection
    if (connection) {
      let wasConnected = connection.connected()
      this.unsubscribes.push(
        connection.subscribe((connected) => {
          const back = connected && !wasConnected
          wasConnected = connected
          if (back) this.catchUp()
        }),
      )
    }
    this.catchUp()
    // A turn seeded as `sending` is a send the sender still holds from before
    // this controller existed — a reload, a remount. Its delivery is idempotent
    // by id, so asking again just waits on the send already under way.
    for (const turn of this.pending) {
      if (turn.state === 'sending') void this.follow(turn)
    }
    this.armSendTimer()
  }

  private observeContext(context: ConversationContext): void {
    this.authoritativeOffer = context.offer ?? null
    if (!this.authoritativeOffer || this.authoritativeOffer.createdAt !== this.dismissedOfferAt) {
      this.dismissedOfferAt = null
    }
    const offer =
      this.authoritativeOffer?.createdAt === this.dismissedOfferAt ? null : this.authoritativeOffer
    this.patch({
      offer: offer ? freezePlain(offer) : null,
      dismissedOfferAt: this.dismissedOfferAt,
    })
    this.applyTerminalAgentError(context)
    this.reconcileOpenSend()
  }

  /**
   * A terminal provider failure fails every turn still in flight (POD-2604).
   * Only `sending` turns are rewritten: one that reached `sent` crossed the
   * send boundary, and calling it "not delivered" would be a claim about a
   * message that did arrive.
   */
  private applyTerminalAgentError(context: ConversationContext): void {
    const error =
      context.agentPhase === 'errored' && context.agentError?.retryable === false
        ? context.agentError
        : undefined
    if (!error) return
    const failure = formatAgentError(error)
    let changed = false
    const pending = this.pending.map((turn) => {
      if (turn.state !== 'sending') return turn
      changed = true
      return { ...turn, state: 'failed' as const, error: failure }
    })
    if (changed) this.patch({ pending })
  }

  clear(): void {
    this.endOpenSend()
    this.pending.clear()
  }

  /** An accepted headless turn can fail after the send request has resolved. */
  finishTurn(error: string | null): void {
    this.endOpenSend()
    if (!error) return
    this.pending.replace(
      this.pending.map((turn) =>
        turn.state === 'failed' ? turn : freezePlain({ ...turn, state: 'failed' as const, error }),
      ),
    )
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

  /** Send again a message this device never got through: the SAME message,
   *  under its own id (POD-4762). */
  async retry(id: string): Promise<void> {
    if (this.disposed) return
    const bubble = this.bubble(id)
    if (!bubble || bubble.state !== 'failed' || bubble.notice !== undefined) return
    if (bubble.retryable === false) return
    const turn = this.pending.find((candidate) => candidate.id === id)
    if (!turn) return
    const next = { ...turn, state: 'sending' as const }
    delete next.error
    this.replacePending(next)
    await this.dispatch(next, null, false)
  }

  /**
   * Let a failed message go. One this device never got through: its outbox
   * entry is dropped with the bubble, so nothing sends it later. One the server
   * says did not (or may not have) arrived: its notice is dismissed on every
   * device.
   */
  async discard(id: string): Promise<void> {
    if (this.disposed) return
    const bubble = this.bubble(id)
    if (!bubble) return
    if (bubble.notice !== undefined) {
      await this.hideWhile(bubble.deliveryId, async () => {
        await this.options.dismissNotice?.(bubble.deliveryId)
        this.dropTurn(bubble.deliveryId)
      })
      return
    }
    if (bubble.state !== 'failed') return
    await this.options.discard?.(bubble.deliveryId)
    this.dropTurn(bubble.deliveryId)
  }

  /**
   * "SEND AGAIN" for a message the server says did not arrive, or cannot say
   * whether it did (POD-4762 follow-up). Never a resend of that message: its
   * text goes back into the composer, and the user sends it — as a NEW message
   * under a new id — by choice. The old notice is dismissed. For an `unknown`
   * message the surface must say it may already have arrived.
   */
  async sendAgain(id: string): Promise<void> {
    if (this.disposed) return
    const bubble = this.bubble(id)
    if (!bubble || bubble.notice === undefined) return
    this.setDraft(bubble.text)
    await this.discard(id)
  }

  /**
   * TAKE A MESSAGE BACK (POD-4776). A send still waiting in this device's
   * outbox is discarded here — it never left, so nothing else can type it. One
   * the server holds is a request the agent's machine answers: the bubble says
   * the retract is on its way, then what came of it — `retracted`, or "too
   * late" once the machine had started typing it. A request that fails says so
   * on the bubble; it never vanishes silently.
   */
  async retract(id: string): Promise<void> {
    if (this.disposed) return
    const bubble = this.bubble(id)
    if (!bubble?.retractable) return
    const messageId = bubble.deliveryId
    this.retracting.set(messageId, {})
    this.patch({})
    try {
      if (bubble.record === undefined && bubble.state === 'sending' && this.options.discard) {
        if (await this.discardFromOutbox(messageId)) {
          runInAction(() => this.retracting.delete(messageId))
          this.markRetracted(bubble)
          return
        }
      }
      if (!this.options.retract) throw new Error('this conversation cannot retract messages')
      const status = await this.options.retract(messageId)
      if (status === 'cancelled') {
        runInAction(() => this.retracting.delete(messageId))
        this.markRetracted(bubble)
      }
    } catch (error) {
      if (!this.disposed)
        runInAction(() => this.retracting.set(messageId, { error: errorText(error) }))
      this.patch({})
    }
  }

  /** Drop a send this device still holds; false when it already left. */
  private async discardFromOutbox(messageId: string): Promise<boolean> {
    try {
      await this.options.discard?.(messageId)
    } catch {
      // In flight to the server right now: it is the server's to answer.
      return false
    }
    const held = this.options.outbox?.held() ?? []
    return !held.some((send) => (send.mutationId as string) === messageId)
  }

  /** The retract won: the bubble stays, as the answer, from what it showed
   *  when it was asked — the feed may already have let the record go. */
  private markRetracted(bubble: ConversationBubble): void {
    const messageId = bubble.deliveryId
    const turn = this.pending.find((candidate) => candidate.deliveryId === messageId)
    const retracted: ConversationPendingTurn = turn
      ? { ...turn, state: 'retracted' }
      : {
          id: `retracted-${messageId}`,
          deliveryId: messageId,
          text: bubble.text,
          wire: bubble.wire,
          at: bubble.at,
          state: 'retracted',
          kind: bubble.kind,
          ...(bubble.files ? { files: bubble.files } : {}),
        }
    this.patch({
      pending: turn
        ? this.pending.map((candidate) => (candidate === turn ? retracted : candidate))
        : [...this.pending, retracted],
    })
  }

  async dismissOffer(offerCreatedAt: string): Promise<void> {
    if (this.disposed) return
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
        this.patch({ offer: this.authoritativeOffer, dismissedOfferAt: null })
      }
      throw error
    }
  }

  async interrupt(draft = this.draft): Promise<boolean> {
    if (this.disposed) return false
    if (!this.context.canInterrupt || !this.options.interrupt) return false
    this.patch({ interruptError: null })
    const prompt = this.context.latestOperatorPrompt ?? this.options.transcript.latestOperatorPrompt
    if (draft === '' && prompt) this.setDraft(prompt)
    try {
      const messageId = this.interruptMessageId
      await this.options.interrupt(messageId ?? undefined)
      this.markInterrupted(messageId ?? undefined)
      // The stop landed, so nothing is "just sent" any more (POD-4654). A send
      // it retracted before the agent saw it has no echo and no turn to end it,
      // and the flag would otherwise hold the Stop up until the send ceiling.
      this.endOpenSend()
      return true
    } catch (error) {
      this.patch({ interruptError: errorText(error) })
      return false
    }
  }

  /** Mark the named message — or the newest one still on its way before
   *  `interruptedAt` — interrupted. */
  markInterrupted(deliveryId?: string, interruptedAt?: number): void {
    if (this.disposed) return
    const beforeInterrupt = (at: number): boolean =>
      interruptedAt === undefined || at <= interruptedAt
    const bubble = deliveryId
      ? this.bubbles.find((candidate) => candidate.deliveryId === deliveryId)
      : this.bubbles.findLast(
          (candidate) =>
            candidate.state !== 'failed' &&
            candidate.state !== 'unknown' &&
            beforeInterrupt(candidate.at),
        )
    if (!bubble || bubble.state === 'interrupted' || bubble.state === 'retracted') return
    const turn = this.pending.find((candidate) => candidate.deliveryId === bubble.deliveryId)
    this.patch({
      pending: turn
        ? this.pending.map((candidate) =>
            candidate === turn ? { ...candidate, state: 'interrupted' } : candidate,
          )
        : [
            ...this.pending,
            {
              id: `interrupted-${bubble.deliveryId}`,
              deliveryId: bubble.deliveryId,
              text: bubble.text,
              wire: bubble.wire,
              at: bubble.at,
              state: 'interrupted',
              kind: bubble.kind,
            },
          ],
    })
  }

  /** Release live resources while keeping the controller restartable by an adapter effect. */
  stop(): void {
    if (!this.started) return
    this.stoppedBubbles = this.bubbles
    this.started = false
    for (const unsubscribe of this.unsubscribes.splice(0)) unsubscribe()
    this.clearSendTimer()
  }

  dispose(): void {
    if (this.disposed) return
    this.stop()
    this.clearSendTimer()
    this.disposed = true
  }

  private bubble(id: string): ConversationBubble | undefined {
    return this.bubbles.find((candidate) => candidate.id === id)
  }

  private dropTurn(deliveryId: string): void {
    const pending = this.pending.filter((turn) => turn.deliveryId !== deliveryId)
    if (pending.length !== this.pending.length) this.patch({ pending })
  }

  /** Hide a bubble while a request about it is in flight; it comes back if the
   *  request fails, and the synced record decides after that. */
  private async hideWhile(messageId: string, work: () => Promise<void>): Promise<void> {
    this.hidden.set(messageId, null)
    this.patch({})
    try {
      await work()
      const record = this.currentRecords().find((candidate) => candidate.id === messageId)
      runInAction(() => {
        if (record) this.hidden.set(messageId, record.status)
        else this.hidden.delete(messageId)
      })
    } catch (error) {
      runInAction(() => this.hidden.delete(messageId))
      throw error
    } finally {
      this.patch({})
    }
  }

  private createTurn(
    input: ConversationSendInput,
    kind: ConversationPendingTurn['kind'],
  ): ConversationPendingTurn | null {
    if (this.disposed) return null
    const text = input.text.trim()
    const wire = (input.wire ?? input.text).trim()
    if (!wire && !input.attachments?.length) return null
    const turn: ConversationPendingTurn = {
      id: `pending-${++this.pendingSeq}`,
      deliveryId: this.options.createDeliveryId(),
      text,
      wire,
      at: this.clock.now(),
      state: 'sending',
      kind,
      ...(input.backend ? { backend: input.backend } : {}),
      ...(input.tags && input.tags.length > 0 ? { tags: input.tags } : {}),
      ...(input.toolPaths && input.toolPaths.length > 0 ? { toolPaths: input.toolPaths } : {}),
      ...(input.files && input.files.length > 0 ? { files: input.files } : {}),
      ...(input.attachments && input.attachments.length > 0
        ? { attachments: input.attachments }
        : {}),
      ...(this.options.reconcile === 'next-user-item' ? { reconcile: 'next-user-item' } : {}),
    }
    this.seenOpen.add(turn.deliveryId)
    this.patch({ pending: [...this.pending, turn] })
    return turn
  }

  private async dispatch(
    turn: ConversationPendingTurn,
    retiredOfferAt: string | null,
    rethrow: boolean,
  ): Promise<void> {
    const sendSeq = this.markSent()
    try {
      await this.deliver(turn)
    } catch (error) {
      this.clearOpenSend(sendSeq)
      if (retiredOfferAt && this.dismissedOfferAt === retiredOfferAt) {
        this.patch({ offer: this.authoritativeOffer, dismissedOfferAt: null })
      }
      if (rethrow) throw error
    }
  }

  /** Wait on a seeded turn's delivery without the side effects of a new send. */
  private async follow(turn: ConversationPendingTurn): Promise<void> {
    if (this.following.has(turn.id)) return
    try {
      await this.deliver(turn)
    } catch {
      // Recorded on the turn by `deliver`; nobody is waiting on a seeded send.
    }
  }

  /**
   * One delivery attempt, and the turn's state from its outcome. The adapter's
   * `deliver` settles when the send does — the server answered, or the sender
   * gave up — so the turn says `sending` for exactly as long as that is true.
   */
  private async deliver(turn: ConversationPendingTurn): Promise<void> {
    this.following.add(turn.id)
    try {
      const result = await this.options.deliver(turn)
      if (result?.state) {
        this.replacePending({
          ...turn,
          state: result.state,
          ...(result.position !== undefined ? { queuePosition: result.position } : {}),
        })
      }
    } catch (error) {
      const retryable = (error as { retryable?: unknown } | null)?.retryable
      this.replacePending({
        ...turn,
        state: 'failed',
        error: errorText(error),
        ...(retryable === false ? { retryable: false } : {}),
      })
      throw error
    } finally {
      this.following.delete(turn.id)
    }
  }

  private replacePending(turn: ConversationPendingTurn): void {
    this.patch({
      pending: this.pending.map((candidate) =>
        candidate.id !== turn.id ||
        // An answer that settled it (interrupted, retracted) outlives a late
        // delivery result for the same turn.
        ((candidate.state === 'interrupted' || candidate.state === 'retracted') &&
          turn.state !== candidate.state)
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

  /** What the feed carries for this session, and — for this device's own sends
   *  it does not carry, while a turn still shows them — what the server
   *  answered by id. */
  private currentRecords(
    pending: readonly ConversationPendingTurn[] = this.pending,
  ): readonly MessageRecordWire[] {
    const feed = this.feedRecords
    if (this.looked.size === 0) return feed
    const carried = new Set(feed.map((record) => record.id))
    const shown = new Set(pending.map((turn) => turn.deliveryId))
    const extra = [...this.looked.values()].filter(
      (record) => !carried.has(record.id) && shown.has(record.id),
    )
    return extra.length === 0 ? feed : [...feed, ...extra]
  }

  /**
   * CATCH UP BY ID (POD-4811). A send of this device's whose record the feed
   * does not carry, and never carried while this view watched, may be one the
   * feed let go while the device was away — confirmed, and pushed out of its
   * session's short window — or one the outbox still holds from before a
   * reload. Nothing on the feed will ever say where it stands, so ask the
   * server for all of them in one read, now and whenever the device is back
   * online. What the server answers stands in for the feed's record; an id it
   * does not know stays as the outbox says, and one the device thought had gone
   * says "not sent".
   */
  private catchUp(): void {
    const lookup = this.options.lookupRecords
    if (!lookup || !this.started || this.disposed) return
    if (this.catchingUp) {
      this.catchUpAgain = true
      return
    }
    const carried = new Set((this.options.records?.getSnapshot() ?? []).map((record) => record.id))
    const asked = new Map<string, ConversationPendingTurn['state']>()
    for (const turn of this.pending) {
      if (turn.reconcile === 'next-user-item') continue
      if (turn.state === 'interrupted' || turn.state === 'retracted') continue
      if (carried.has(turn.deliveryId)) continue
      asked.set(turn.deliveryId, turn.state)
    }
    if (asked.size === 0) return
    this.catchingUp = true
    const ids = [...asked.keys()]
    const reads: Promise<readonly MessageRecordWire[]>[] = []
    for (let at = 0; at < ids.length; at += CATCH_UP_BATCH) {
      const batch = ids.slice(at, at + CATCH_UP_BATCH)
      try {
        reads.push(lookup(batch))
      } catch (error) {
        // A read that throws before it starts failed like any other.
        reads.push(Promise.reject(error))
      }
    }
    void Promise.all(reads)
      .then(
        (answers) => this.settleFromLookup(asked, answers.flat()),
        // Offline, or the server refused: the next time the device is back
        // online it asks again.
        () => {},
      )
      .finally(() => {
        this.catchingUp = false
        if (!this.catchUpAgain) return
        this.catchUpAgain = false
        this.catchUp()
      })
  }

  private settleFromLookup(
    asked: ReadonlyMap<string, ConversationPendingTurn['state']>,
    answer: readonly MessageRecordWire[],
  ): void {
    if (this.disposed) return
    const found = new Map<string, MessageRecordWire>()
    for (const record of answer) if (asked.has(record.id)) found.set(record.id, record)
    for (const id of asked.keys()) {
      const record = found.get(id)
      if (record) this.looked.set(id, record)
      else this.looked.delete(id)
    }
    const carried = new Set((this.options.records?.getSnapshot() ?? []).map((record) => record.id))
    const held = new Map(
      (this.options.outbox?.held() ?? []).map((send) => [send.mutationId as string, send]),
    )
    // The server has it: a copy the outbox parked as "not sent" is moot. Let it
    // go, so the recovery panel does not offer to send it again.
    for (const id of found.keys()) {
      if (held.get(id)?.state === 'failed') void this.options.discard?.(id).catch(() => {})
    }
    let changed = false
    const pending = this.pending.map((turn) => {
      const was = asked.get(turn.deliveryId)
      if (was === undefined || found.has(turn.deliveryId) || carried.has(turn.deliveryId)) {
        return turn
      }
      // The server has no record of it. One still on its way from this device
      // (`sending`), or already "not sent", is the outbox's to settle, and so
      // is a turn that moved while the read was out. One the device thought
      // had gone — the server answered it, so the outbox let it go — was never
      // stored: say so.
      if (turn.state !== was || (was !== 'queued' && was !== 'sent')) return turn
      changed = true
      return { ...turn, state: 'failed' as const, error: NOT_STORED }
    })
    this.patch(changed ? { pending } : {})
  }

  /**
   * The records moved. A local turn whose record this view saw and that has
   * since left the feed is settled — confirmed and out of the window,
   * cancelled, or dismissed — so it goes. One whose record never arrived yet
   * stays as it is: the feed may simply be behind the send's answer.
   */
  private observeRecords(notify = true): void {
    const records = this.options.records?.getSnapshot() ?? []
    this.feedRecords = records
    const present = new Map<string, MessageRecordWire>()
    for (const record of records) {
      present.set(record.id, record)
      this.seenRecord.add(record.id)
      if (record.status !== 'confirmed') this.seenOpen.add(record.id)
    }
    for (const [id, status] of this.hidden) {
      if (status !== null && present.get(id)?.status !== status) this.hidden.delete(id)
    }
    // A retract's answer is on the record now (or the record left): the record
    // speaks for it from here.
    for (const [id, local] of this.retracting) {
      const record = present.get(id)
      if (local.error === undefined && record?.retractRequestedAt !== undefined) {
        this.retracting.delete(id)
      }
    }
    const completed = this.consumeConfirmedTranscript()
    const pending = this.pending.filter(
      (turn) =>
        (turn.state === 'retracted' || !completed.has(turn.deliveryId)) &&
        (turn.reconcile === 'next-user-item' ||
          turn.state === 'interrupted' ||
          turn.state === 'retracted' ||
          present.has(turn.deliveryId) ||
          !this.seenRecord.has(turn.deliveryId)),
    )
    // Forget what can no longer matter: an id neither carried nor held here.
    const held = new Set(pending.map((turn) => turn.deliveryId))
    for (const id of this.seenRecord)
      if (!present.has(id) && !held.has(id)) this.seenRecord.delete(id)
    for (const id of this.seenOpen) if (!present.has(id) && !held.has(id)) this.seenOpen.delete(id)
    for (const id of this.looked.keys()) if (!held.has(id)) this.looked.delete(id)
    if (!notify) {
      this.pending.replace(pending.map(freezePlain))
      return
    }
    this.patch(pending.length === this.pending.length ? {} : { pending })
  }

  /**
   * The outbox moved under a send this device gave up on (POD-4762 follow-up):
   * the recovery panel retried it — follow it again, it is the same message —
   * or discarded it, and the bubble goes with it. Once the server stores it,
   * its record drives the bubble like any other.
   */
  private observeOutbox(): void {
    const outbox = this.options.outbox
    if (!outbox) return
    const held = new Map(outbox.held().map((send) => [send.mutationId as string, send]))
    const records = new Set(this.currentRecords().map((record) => record.id))
    let changed = false
    const pending: ConversationPendingTurn[] = []
    const resumed: ConversationPendingTurn[] = []
    for (const turn of this.pending) {
      if (turn.state !== 'failed' || records.has(turn.deliveryId)) {
        pending.push(turn)
        continue
      }
      const send = held.get(turn.deliveryId)
      if (send === undefined) {
        changed = true
        continue
      }
      if (send.state === 'sending') {
        const next = { ...turn, state: 'sending' as const }
        delete next.error
        pending.push(next)
        resumed.push(next)
        changed = true
        continue
      }
      pending.push(turn)
    }
    if (!changed) return
    this.patch({ pending })
    for (const turn of resumed) void this.follow(turn)
  }

  /** Called by TranscriptLog inside the append/read action, never by a reaction.
   * A delta examines only its changed entries; reads/resets may establish a baseline. */
  reconcile(change: TranscriptChange, baseline = false): void {
    const completed = this.consumeConfirmedTranscript()
    const retained = this.pending.filter(
      (turn) => turn.state === 'retracted' || !completed.has(turn.deliveryId),
    )
    const users = change.changed
      .filter((item) => item.role === 'user')
      .sort(
        (left, right) =>
          (this.options.transcript.position(left.id) ?? -1) -
          (this.options.transcript.position(right.id) ?? -1),
      )
    if (baseline || !this.userBaselineReady) {
      this.seenUserIds.replace(users.map((item) => item.id))
      this.seenUserTailId = this.options.transcript.latestUserId
      this.userBaselineReady = true
      this.patch(retained.length === this.pending.length ? {} : { pending: retained })
      return
    }
    const previousTail = this.seenUserTailId
    const position = previousTail === null ? -1 : this.options.transcript.position(previousTail)
    const fresh =
      position === undefined
        ? []
        : users.filter(
            (item) =>
              !this.seenUserIds.has(item.id) &&
              (this.options.transcript.position(item.id) ?? -1) > position,
          )
    for (const item of users) this.seenUserIds.add(item.id)
    this.seenUserTailId = this.options.transcript.latestUserId
    const interruptItem = fresh.findLast((item) => item.event === 'interrupt')
    if (interruptItem) {
      const at = interruptItem.ts ? Date.parse(interruptItem.ts) : NaN
      this.markInterrupted(undefined, Number.isFinite(at) ? at : undefined)
    }
    let arrivals = fresh.filter((item) => item.event !== 'interrupt').length
    const pending = retained.filter((turn) => {
      if (turn.reconcile !== 'next-user-item' || turn.state === 'interrupted' || arrivals === 0)
        return true
      arrivals--
      return false
    })
    this.patch(pending.length === this.pending.length ? {} : { pending })
  }

  private consumeConfirmedTranscript(): Set<string> {
    const completed = new Set<string>()
    for (const record of this.currentRecords()) {
      if (
        record.status !== 'confirmed' ||
        !record.transcriptItem ||
        (!this.options.transcript.byId.has(record.transcriptItem.id) &&
          !this.seenUserIds.has(record.transcriptItem.id))
      )
        continue
      completed.add(record.id)
      this.seenOpen.delete(record.id)
      this.looked.delete(record.id)
    }
    return completed
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
      this.clearSendTimer()
      this.patch({ justSent: false })
      return
    }
    this.armSendTimer()
  }

  private clearOpenSend(seq: number): void {
    if (this.openSend?.seq !== seq) return
    this.endOpenSend()
  }

  private endOpenSend(): void {
    if (!this.openSend && !this.justSent) return
    this.openSend = null
    this.clearSendTimer()
    this.patch({ justSent: false })
  }

  /** The "just sent" activity window's ceiling — the composer's Sending row,
   *  not a bubble's delivery state. */
  private armSendTimer(): void {
    this.clearSendTimer()
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

  private clearSendTimer(): void {
    if (this.sendTimer === null) return
    this.clock.clearTimeout(this.sendTimer)
    this.sendTimer = null
  }

  private patch(
    patch: Partial<{
      pending: ConversationPendingTurn[]
      offer: SessionOffer | null
      dismissedOfferAt: string | null
      justSent: boolean
      interruptError: string | null
    }>,
  ): void {
    if (this.disposed) return
    if (patch.pending) this.pending.replace(patch.pending.map(freezePlain))
    const { pending: _pending, ...fields } = patch
    Object.assign(this, fields)
    if (!this.started) return
    const latest = this.bubbles.findLast(
      (bubble) => bubble.state !== 'failed' && bubble.state !== 'unknown',
    )
    this.interruptMessageId =
      !latest || latest.state === 'interrupted' || latest.state === 'retracted'
        ? null
        : latest.deliveryId
  }
}
