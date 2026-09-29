/**
 * A DEVICE, WITHOUT THE PIXELS (POD-4779).
 *
 * What a phone or a browser tab does with a chat message, assembled from the
 * same client-core pieces the apps assemble — not a re-implementation of them:
 *
 *  - the kernel outbox (`openKernelEngineOutbox`) over a store that outlives the
 *    device's process, so a RELOAD finds what the last life queued;
 *  - `sendChatThroughOutbox` under an id minted before the first attempt, the
 *    one chat send path both apps take since POD-4762;
 *  - a `ConversationController` per session, wired as `use-chat-send.ts` wires
 *    it (deliver through the outbox, retract, discard, dismiss), fed by a real
 *    `/client` socket: `transcriptDelta` frames for the history, and the
 *    metadata feed's `message` records (POD-4764) for where each sent message
 *    stands — pushed, never polled.
 *
 * The network is the device's own: `setOnline(false)` fails every request and
 * closes the socket, exactly what a phone in a tunnel sees. A server restart is
 * NOT an offline device — the device stays "online" and its requests fail
 * until the server answers again, which is what a browser sees.
 */

import { randomUUID } from 'node:crypto'
import {
  type ConversationBubbleState,
  ConversationController,
  type ConversationPendingTurn,
  type ConversationState,
  storeConversationRecords,
} from '@podium/client-core/conversation'
import {
  discardChatThroughOutbox,
  type EngineOutbox,
  OutboxSettlements,
  openKernelEngineOutbox,
  outboxChatSends,
  sendChatThroughOutbox,
} from '@podium/client-core/engine'
import {
  asMutationId,
  type MessageRecordWire,
  type SessionId,
  type TranscriptItem,
} from '@podium/model'
import {
  CAP_SYNC_HTTP_V1,
  CLIENT_WIRE_VERSION,
  type MetadataChangeLenient,
} from '@podium/protocol'
import { InMemoryOutboxStore } from '@podium/sync/outbox'
import { createTRPCClient, httpBatchLink } from '@trpc/client'
import WebSocket from 'ws'
import type { AppRouter } from '../../../apps/server/src/router'

export type DeviceApi = ReturnType<typeof createTRPCClient<AppRouter>>

/** Everything a device's storage keeps across a reload. */
export interface DeviceDisk {
  readonly outbox: InMemoryOutboxStore
}

export function newDeviceDisk(): DeviceDisk {
  return { outbox: new InMemoryOutboxStore([]) }
}

/** What one message looks like on one device's screen. */
export interface MessageOnScreen {
  /** How many bubbles carry this message id — 1 is the only right answer. */
  readonly bubbles: number
  /** What the user is told, in the device's own words. */
  readonly shownAs: 'in-transcript' | `pending:${ConversationBubbleState}` | 'absent'
  /** The words on a failed bubble, when it has some. */
  readonly error?: string
}

/** The id every lane message carries in its text, so a typed prompt, a
 *  transcript entry and a ledger row can all be traced to one message. */
export function messageText(id: string, label: string): string {
  return `[${id}] ${label}`
}

const MESSAGE_ID_IN_TEXT = /\[(msg_[0-9a-f-]+)\]/g

export function messageIdsIn(text: string): string[] {
  return [...text.matchAll(MESSAGE_ID_IN_TEXT)].map((match) => match[1] as string)
}

class TranscriptView {
  items: TranscriptItem[] = []
  private readonly listeners = new Set<() => void>()
  readonly port = {
    getSnapshot: (): { items: readonly TranscriptItem[] } => ({ items: this.items }),
    subscribe: (listener: () => void): (() => void) => {
      this.listeners.add(listener)
      return () => this.listeners.delete(listener)
    },
  }

  apply(items: readonly TranscriptItem[], reset: boolean): void {
    if (reset) {
      this.items = [...items]
    } else {
      const byId = new Map(this.items.map((item, index) => [item.id, index]))
      const next = [...this.items]
      for (const item of items) {
        const at = byId.get(item.id)
        if (at === undefined) next.push(item)
        else next[at] = item
      }
      this.items = next
    }
    for (const listener of this.listeners) listener()
  }
}

/** One change row as either wire spells it: v1 keys the target `id`, v2
 *  `entityId`, and v2 may `evict` a row this principal can no longer see. */
interface FeedRow {
  readonly seq: number
  readonly entity: string
  readonly id?: string
  readonly entityId?: string
  readonly op: string
  readonly value?: unknown
}

/**
 * The `message` records this device's feed carries (POD-4764), folded from
 * the pushed `feedDelta` frames after one
 * catch-up read — the store half the apps read through
 * `storeConversationRecords`.
 */
class RecordsView {
  private byRowId = new Map<string, MessageRecordWire>()
  private snapshot: { messageRecords: readonly MessageRecordWire[] } = { messageRecords: [] }
  private readonly listeners = new Set<() => void>()
  cursor = 0
  readonly store = {
    getSnapshot: () => this.snapshot,
    subscribe: (listener: () => void): (() => void) => {
      this.listeners.add(listener)
      return () => this.listeners.delete(listener)
    },
  }

  apply(changes: readonly (FeedRow | MetadataChangeLenient)[], through: number): void {
    let touched = false
    for (const change of changes as readonly FeedRow[]) {
      if (change.seq <= this.cursor) continue
      const rowId = change.entityId ?? change.id
      if (change.entity !== 'message' || rowId === undefined) continue
      touched = true
      if (change.op === 'upsert' && change.value) {
        this.byRowId.set(rowId, change.value as MessageRecordWire)
      } else {
        this.byRowId.delete(rowId)
      }
    }
    this.cursor = Math.max(this.cursor, through)
    if (!touched) return
    this.snapshot = { messageRecords: [...this.byRowId.values()] }
    for (const listener of this.listeners) listener()
  }

  /** Every record, keyed as the feed keys it — for a lane's own assertions. */
  all(): readonly MessageRecordWire[] {
    return this.snapshot.messageRecords
  }
}

export interface DeviceOptions {
  readonly name: string
  readonly serverPort: number
  /** The operator's login cookie, on every request and socket. */
  readonly cookie: string
  readonly sessionIds: readonly SessionId[]
  readonly disk: DeviceDisk
}

export class Device {
  readonly name: string
  readonly api: DeviceApi
  private online = true
  /** tRPC procedures whose NEXT answer is lost after the server handled it. */
  private readonly loseAnswers: string[] = []
  /** Answers actually lost — so a lane can prove its own setup fired. */
  answersLost = 0
  /** Requests this device made, per tRPC procedure. */
  readonly calls = new Map<string, number>()
  private readonly onlineListeners = new Set<() => void>()
  private readonly settlements = new OutboxSettlements()
  private outbox: EngineOutbox | undefined
  private readonly transcripts = new Map<SessionId, TranscriptView>()
  private readonly controllers = new Map<SessionId, ConversationController>()
  private records = new RecordsView()
  private socket: WebSocket | undefined
  private socketTimer: ReturnType<typeof setTimeout> | undefined
  private closed = false
  private nextId: string | undefined
  /** Frames this device's socket received, by type — the first thing to read
   *  when a screen looks wrong. */
  readonly socketFrames = new Map<string, number>()
  /** Sends this life started and has not yet seen settle. */
  private readonly inFlight = new Set<Promise<unknown>>()

  private constructor(private readonly options: DeviceOptions) {
    this.name = options.name
    const gatedFetch: typeof fetch = async (input, init) => {
      if (!this.online) throw new TypeError('fetch failed (device offline)')
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
      for (const procedure of new URL(url).pathname.replace(/^\/trpc\//, '').split(',')) {
        this.calls.set(procedure, (this.calls.get(procedure) ?? 0) + 1)
      }
      const response = await fetch(input, init)
      const lose = this.loseAnswers.findIndex((procedure) => url.includes(`/trpc/${procedure}`))
      if (lose >= 0) {
        // The request reached the server and did its work; the answer is what
        // goes missing — the one failure a sender cannot tell from a lost request.
        this.loseAnswers.splice(lose, 1)
        this.answersLost += 1
        throw new TypeError('fetch failed (answer lost)')
      }
      return response
    }
    this.api = createTRPCClient<AppRouter>({
      links: [
        httpBatchLink({
          url: `http://127.0.0.1:${options.serverPort}/trpc`,
          fetch: gatedFetch,
          headers: { cookie: options.cookie },
        }),
      ],
    })
  }

  static async open(options: DeviceOptions): Promise<Device> {
    const device = new Device(options)
    await device.boot()
    return device
  }

  /** One life of the app: queue, controllers and socket, over the device's disk. */
  private async boot(): Promise<void> {
    const create = await openKernelEngineOutbox({
      store: this.options.disk.outbox,
      principal: 'delivery-outage-operator',
      api: this.api as never,
      onDegraded: (detail) => {
        throw detail instanceof Error ? detail : new Error(String(detail))
      },
    })
    const outbox = create({
      api: this.api as never,
      replica: {} as never,
      notices: { error: () => {}, info: () => {} } as never,
      onSettled: (mutationId, settlement) => this.settlements.settle(mutationId, settlement),
      isOnline: () => this.online,
      onlineEvents: {
        add: (listener) => this.onlineListeners.add(listener),
        remove: (listener) => this.onlineListeners.delete(listener),
      },
    })
    outbox.attach()
    this.outbox = outbox
    for (const sessionId of this.options.sessionIds) {
      const transcript = new TranscriptView()
      this.transcripts.set(sessionId, transcript)
      // What a reload restores (use-chat-send.ts): every send the outbox still
      // holds comes back as the bubble it was, and the controller waits on it.
      const held: ConversationPendingTurn[] = outboxChatSends(outbox, sessionId).map(
        (send, index) => ({
          id: `outbox-${index}-${send.mutationId}`,
          deliveryId: send.mutationId,
          text: send.text,
          wire: send.text,
          at: send.queuedAt,
          state: send.state,
          kind: 'message',
          ...(send.failure ? { error: send.failure.message } : {}),
        }),
      )
      const controller = new ConversationController({
        sessionId,
        transcript: transcript.port,
        initialPending: held,
        createDeliveryId: () => {
          const id = this.nextId ?? `msg_${randomUUID()}`
          this.nextId = undefined
          return id
        },
        deliver: (turn) =>
          this.track(
            sendChatThroughOutbox(
              { outbox, settlements: this.settlements },
              { sessionId, text: turn.wire, wake: false },
              asMutationId(turn.deliveryId),
            ),
          ),
        records: storeConversationRecords(this.records.store, sessionId),
        retract: (id) => this.api.messages.cancel.mutate({ id }).then(() => undefined),
        discard: (deliveryId) => discardChatThroughOutbox(outbox, asMutationId(deliveryId)),
        dismissNotice: (id) => this.api.messages.dismissNotice.mutate({ id }).then(() => undefined),
      })
      this.controllers.set(sessionId, controller)
      controller.start()
    }
    await this.catchUp()
    this.openSocket()
  }

  /** The feed read a reconnecting client heals through (`sync.changesSince`):
   *  everything after this device's cursor, then the pushed frames carry on. */
  private async catchUp(): Promise<void> {
    if (this.closed || !this.online) return
    try {
      const result = await this.api.sync.changesSince.query({ cursor: this.records.cursor })
      if (result.kind === 'delta') this.records.apply(result.changes, result.cursor)
    } catch {
      // Offline or restarting: the next socket open reads again.
    }
  }

  private track<T>(promise: Promise<T>): Promise<T> {
    const tracked = promise.finally(() => this.inFlight.delete(tracked))
    this.inFlight.add(tracked)
    return tracked
  }

  private openSocket(): void {
    if (this.closed || !this.online || this.socket) return
    const ws = new WebSocket(
      `ws://127.0.0.1:${this.options.serverPort}/client?v=${CLIENT_WIRE_VERSION}&cap=${CAP_SYNC_HTTP_V1}`,
      {
        headers: { cookie: this.options.cookie },
      },
    )
    this.socket = ws
    ws.on('open', () => {
      ws.send(
        JSON.stringify({
          type: 'hello',
          clientId: '',
          viewport: { cols: 80, rows: 24, dpr: 1 },
          wireVersion: CLIENT_WIRE_VERSION,
          caps: [CAP_SYNC_HTTP_V1],
        }),
      )
      for (const sessionId of this.options.sessionIds) {
        ws.send(JSON.stringify({ type: 'transcriptSubscribe', sessionId }))
      }
      void this.catchUp()
    })
    ws.on('message', (data) => {
      let frame: {
        type?: string
        sessionId?: string
        items?: TranscriptItem[]
        reset?: boolean
        seq?: number
        changes?: FeedRow[]
      }
      try {
        frame = JSON.parse(String(data)) as typeof frame
      } catch {
        return
      }
      this.socketFrames.set(frame.type ?? '?', (this.socketFrames.get(frame.type ?? '?') ?? 0) + 1)
      if (
        frame.type === 'feedDelta' &&
        Array.isArray(frame.changes)
      ) {
        this.records.apply(frame.changes, frame.seq ?? this.records.cursor)
        return
      }
      if (frame.type !== 'transcriptDelta' || !frame.sessionId || !Array.isArray(frame.items))
        return
      this.transcripts.get(frame.sessionId as SessionId)?.apply(frame.items, frame.reset === true)
    })
    const lost = (): void => {
      if (this.socket !== ws) return
      this.socket = undefined
      if (this.closed || !this.online) return
      this.socketTimer = setTimeout(() => this.openSocket(), 500)
    }
    ws.on('close', (code, reason) => {
      this.socketFrames.set(
        `close:${code}:${String(reason)}`,
        (this.socketFrames.get(`close:${code}:${String(reason)}`) ?? 0) + 1,
      )
      lost()
    })
    ws.on('error', (error) => {
      this.socketFrames.set(
        `error:${error.message}`,
        (this.socketFrames.get(`error:${error.message}`) ?? 0) + 1,
      )
      lost()
    })
  }

  /** The next call to `procedure` (e.g. `sessions.sendText`) reaches the
   *  server, and its answer is lost on the way back. */
  loseNextAnswer(procedure: string): void {
    this.loseAnswers.push(procedure)
  }

  setOnline(online: boolean): void {
    if (this.online === online) return
    this.online = online
    if (!online) {
      this.socket?.terminate()
      this.socket = undefined
      return
    }
    this.openSocket()
    for (const listener of this.onlineListeners) listener()
  }

  /**
   * Type `label` into one session's composer and press send. Resolves with the
   * message id as soon as the send STARTED; `settled` resolves when the device
   * heard the server's answer or gave up.
   */
  send(sessionId: SessionId, label: string): { id: string; settled: Promise<void> } {
    const controller = this.controller(sessionId)
    const id = `msg_${randomUUID()}`
    this.nextId = id
    const settled = controller.submit({ text: messageText(id, label) }).then(
      () => undefined,
      () => undefined,
    )
    return { id, settled }
  }

  /** The user's retry of a failed bubble — the same message, the same id. */
  async retry(sessionId: SessionId, messageId: string): Promise<void> {
    const bubble = this.bubble(sessionId, messageId)
    if (!bubble) throw new Error(`${this.name}: no bubble for ${messageId} to retry`)
    await this.controller(sessionId)
      .retry(bubble.id)
      .catch(() => undefined)
  }

  /** Retract a queued message by its id — from ANY device, as the web does
   *  from the queued bubble's menu. */
  async retract(sessionId: SessionId, messageId: string): Promise<void> {
    // A person retracts what they SEE: on a device that did not send it, the
    // bubble appears when the feed carries the record — wait for it, as they would.
    const deadline = Date.now() + 15_000
    let bubble = this.bubble(sessionId, messageId)
    while (!bubble && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 100))
      bubble = this.bubble(sessionId, messageId)
    }
    if (!bubble) {
      throw new Error(
        `${this.name}: no bubble for ${messageId} to retract (frames: ${JSON.stringify([...this.socketFrames])}, records: ${this.records.all().length})`,
      )
    }
    await this.controller(sessionId)
      .retract(bubble.id)
      .catch(() => undefined)
  }

  private bubble(sessionId: SessionId, messageId: string) {
    return this.controller(sessionId)
      .getSnapshot()
      .bubbles.find((candidate) => candidate.deliveryId === messageId)
  }

  /** The `message` records this device's feed carries right now. */
  messageRecords(): readonly MessageRecordWire[] {
    return this.records.all()
  }

  /** Close the app and open it again over the same disk. */
  async reload(): Promise<void> {
    this.teardown()
    this.closed = false
    await this.boot()
  }

  controller(sessionId: SessionId): ConversationController {
    const controller = this.controllers.get(sessionId)
    if (!controller) throw new Error(`${this.name}: no conversation for ${sessionId}`)
    return controller
  }

  /** The chat sends this device's queue still holds for a session: `sending`
   *  (no answer yet) or `failed` (gave up — the user's "not sent"). */
  heldSends(sessionId: SessionId): { mutationId: string; state: 'sending' | 'failed' }[] {
    const outbox = this.outbox
    if (!outbox) return []
    return outboxChatSends(outbox, sessionId).map((send) => ({
      mutationId: send.mutationId,
      state: send.state === 'failed' ? 'failed' : 'sending',
    }))
  }

  /** Catch up on the feed now, as a reconnecting client does. */
  async refresh(): Promise<void> {
    await this.catchUp()
  }

  /** Every message id this device shows for a session, and how. */
  screen(sessionId: SessionId): Map<string, MessageOnScreen> {
    return bubblesOf(
      this.controller(sessionId).getSnapshot(),
      this.transcripts.get(sessionId)?.items ?? [],
    )
  }

  close(): void {
    this.teardown()
  }

  private teardown(): void {
    this.closed = true
    if (this.socketTimer) clearTimeout(this.socketTimer)
    this.socket?.terminate()
    this.socket = undefined
    for (const controller of this.controllers.values()) controller.dispose()
    this.controllers.clear()
    this.transcripts.clear()
    this.records = new RecordsView()
    this.outbox?.dispose()
    this.outbox = undefined
    this.onlineListeners.clear()
  }
}

/**
 * The bubbles a chat surface draws for one session, counted per message id:
 * the controller's bubbles (this device's sends and the synced records, by
 * id) and the transcript's user entries. A message drawn twice is a duplicate
 * bubble no matter which two of these drew it.
 */
export function bubblesOf(
  state: ConversationState,
  transcript: readonly TranscriptItem[],
): Map<string, MessageOnScreen> {
  const drawn = new Map<string, MessageOnScreen>()
  const draw = (
    ids: readonly string[],
    shownAs: MessageOnScreen['shownAs'],
    error?: string,
  ): void => {
    for (const id of ids) {
      const current = drawn.get(id)
      const words = current?.error ?? error
      drawn.set(id, {
        bubbles: (current?.bubbles ?? 0) + 1,
        shownAs: current?.shownAs ?? shownAs,
        ...(words ? { error: words } : {}),
      })
    }
  }
  for (const item of transcript) {
    if (item.role === 'user') draw(messageIdsIn(item.text), 'in-transcript')
  }
  for (const bubble of state.bubbles) draw([bubble.deliveryId], `pending:${bubble.state}`, bubble.error)
  return drawn
}
