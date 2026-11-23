/**
 * THE OUTBOX SERVICE (POD-6681; detailed design 2.1).
 *
 * One per signed-in user, inside the runtime root. It owns that user's durable
 * queue of unsent writes:
 *
 * - it builds the queue (`./wiring.ts`, or the platform's kernel queue,
 *   `./kernel-outbox.ts`) over the replica's outbox storage (`./storage.ts`),
 *   with the platform's connectivity seams;
 * - it writes the pending count and the parked writes into the LiveStore with
 *   the frame (hydrate-first: the parked writes show on the first paint);
 * - it drains the queue when the connection service says the connection's
 *   health returned;
 * - it answers a person's recovery of a parked write (retry, edit, discard);
 * - it reports each entry's outcome to observers, and releases the waiters a
 *   chat send registered on an entry.
 *
 * Moved out of the old store (engine/runtime.ts) without changing what the
 * write path does: the same command table, routing, maximum ages, dead-letter
 * rules, legacy drain and receipt retirement.
 */

import { createLogger } from '@podium/logger'
import type { MutationId } from '@podium/model'
import type { OutboxRejectionReason, RetrySatisfaction } from '@podium/sync/outbox'
import type { PodiumClientApi } from '../../api'
import { OutboxSettlements } from '../../conversation/sends'
import type { LiveFrameQueue } from '../../live/frame-queue'
import type { LiveStore } from '../../live/live-store'
import type { NoticeSink } from '../../notices'
import type { OnlineEvents, OutboxEntry } from '../../outbox'
import type { Replica } from '../../replica/kernel/facade'
import {
  type CreateEngineOutbox,
  createEngineOutbox,
  type EngineOutbox,
  shouldParkDeadLetter,
} from './wiring'

const log = createLogger('client-core:runtime')

/**
 * One outbox entry's outcome, for listeners outside the kernel (POD-4554: the
 * round-three receipts stream, keyed by mutation id). Observation only: it
 * fires AFTER the service's own handling of the same event, a throwing
 * listener is logged and skipped, and nothing a listener does reaches the
 * queue or the pool transaction log.
 *
 * - `applied`: the Authority applied the mutation (the drain's success). It
 *   says nothing about the echo: the wire row carries no mutation id.
 * - `rejected`: a definitive refusal took the entry out of the queue. `parked`
 *   says whether it went to the dead-letter recovery surface (authored text)
 *   or was discarded; `reason` is the normalized refusal when the queue knows it.
 * - `superseded`: the queue collapsed this still-queued entry into a later one
 *   with the same collapse key (POD-785). It is never sent and gets no other
 *   outcome. `entry` is absent when the queue could no longer see it.
 */
export type OutboxOutcome =
  | { readonly type: 'applied'; readonly mutationId: MutationId; readonly entry: OutboxEntry }
  | {
      readonly type: 'rejected'
      readonly mutationId: MutationId
      readonly entry: OutboxEntry
      readonly parked: boolean
      readonly reason?: OutboxRejectionReason
    }
  | { readonly type: 'superseded'; readonly mutationId: MutationId; readonly entry?: OutboxEntry }

/** A person's answers to a parked write (the recovery surface's buttons). */
export interface OutboxRecovery {
  retry(id: MutationId, satisfaction: RetrySatisfaction): unknown
  edit(id: MutationId, input: unknown): unknown
  discard(id: MutationId): unknown
}

/** The connection service's one signal the outbox drains on. */
export interface OutboxReconnectSignal {
  onReconnected(listener: () => void): () => void
}

export interface OutboxServiceOptions {
  readonly api: PodiumClientApi
  readonly replica: Replica
  readonly live: LiveStore
  /** The root's frame queue: the counts go in with every other reading. */
  readonly frames: LiveFrameQueue
  readonly notices: NoticeSink
  /** When the connection's health returns, the queue drains. */
  readonly connection: OutboxReconnectSignal
  /** False for a local-only boot: the queue keeps everything and sends nothing. */
  readonly networkEnabled: boolean
  /** Platform queue factory. Web and the phone inject the kernel queue. */
  readonly createOutboxFn?: CreateEngineOutbox
  /** Connectivity transitions. Default: the window's `online`. */
  readonly onlineEvents?: OnlineEvents
  /** Connectivity probe. Default: `navigator.onLine`. */
  readonly isOnline?: () => boolean
}

const LOCAL_ONLY_ONLINE_EVENTS: OnlineEvents = {
  add: () => {},
  remove: () => {},
}

export class OutboxService {
  /** The durable queue. Read only inside the runtime root (and, until POD-6682, the old store). */
  readonly queue: EngineOutbox
  /** Waiters on queued entries by id — how a chat send hears its outcome
   *  (POD-4762). Created before the queue, whose callbacks release them. */
  readonly settlements = new OutboxSettlements()
  /** A person's answers to a parked write. */
  readonly recovery: OutboxRecovery

  private readonly options: OutboxServiceOptions
  private readonly outcomeListeners = new Set<(outcome: OutboxOutcome) => void>()
  private offs: Array<() => void> = []
  private started = false
  /** Whether the queue was detached since the last start (or construction). */
  private released = false
  private disposed = false

  constructor(options: OutboxServiceOptions) {
    this.options = options
    const { notices } = options
    this.queue = (options.createOutboxFn ?? createEngineOutbox)({
      api: options.api,
      replica: options.replica,
      // Platform connectivity, when the root knows better than the browser
      // defaults `createEngineOutbox` would reach for (native: NetInfo).
      ...(options.networkEnabled
        ? {
            ...(options.onlineEvents !== undefined ? { onlineEvents: options.onlineEvents } : {}),
            ...(options.isOnline !== undefined ? { isOnline: options.isOnline } : {}),
          }
        : { onlineEvents: LOCAL_ONLY_ONLINE_EVENTS, isOnline: () => false }),
      notices: { error: (m) => notices.error(m), info: (m, d) => notices.info(m, d) },
      // An entry's reply came back. Announced only: nothing here keeps or
      // retires the entry any more. It stays in the outbox, painting, until the
      // replica holds the truth that covers it (ADR 12, POD-6277).
      onApplied: (entry) => {
        if (this.disposed) return
        this.emitOutcome({ type: 'applied', mutationId: entry.mutationId, entry })
      },
      onSettled: (mutationId, settlement) => this.settlements.settle(mutationId, settlement),
      onDropped: (entry, reason) => {
        if (this.disposed) return
        this.emitOutcome({
          type: 'rejected',
          mutationId: entry.mutationId,
          entry,
          parked: shouldParkDeadLetter(entry.kind, entry.input),
          ...(reason ? { reason } : {}),
        })
      },
      onSuperseded: (mutationId, entry) => {
        if (this.disposed) return
        this.emitOutcome({ type: 'superseded', mutationId, ...(entry ? { entry } : {}) })
      },
      observingSupersede: () => this.outcomeListeners.size > 0,
      // The queue-size subscription is not the dead-letter event: a definitive
      // refusal can park before start() installs that subscription. Publish the
      // recovery projection at the event's own boundary so a live park cannot
      // remain durable-but-invisible.
      onDeadLetter: () => this.publish(),
    })
    this.recovery = {
      retry: (id, satisfaction) => this.queue.retry(id, satisfaction),
      edit: (id, input) => this.queue.edit(id, input),
      discard: (id) => this.queue.discard(id),
    }
    // Hydrate-first, like the entity slices: the queue's constructor has
    // already restored its durable recovery home, so the first paint must show
    // the parked writes without waiting for start() or a queue notification.
    // Restored unsent writes must also be counted before sign-out is available.
    options.live.setOutbox({ pending: this.queue.size(), deadLetters: this.queue.deadLetters() })
  }

  /** Follow the queue and the connection, and start draining. Idempotent;
   *  re-arms after {@link stop} (StrictMode). */
  start(): void {
    if (this.started || this.disposed) return
    this.started = true
    this.released = false
    this.offs.push(this.queue.subscribe(() => this.publish()))
    this.queue.attach()
    this.publish()
    this.offs.push(this.options.connection.onReconnected(() => this.queue.notifyConnected()))
  }

  /** Stop following and detach the queue. Reversible. */
  stop(): void {
    if (this.released) return
    this.released = true
    this.started = false
    for (const off of this.offs.splice(0)) {
      try {
        off()
      } catch {
        // teardown is best-effort
      }
    }
    this.queue.dispose()
  }

  /** Sign-out: no outcome, count or settlement is reported afterwards. */
  dispose(): void {
    this.stop()
    if (this.disposed) return
    this.disposed = true
    this.outcomeListeners.clear()
  }

  /** Per-entry outbox outcomes (POD-4554). See {@link OutboxOutcome}. */
  subscribeOutcomes(listener: (outcome: OutboxOutcome) => void): () => void {
    this.outcomeListeners.add(listener)
    return () => this.outcomeListeners.delete(listener)
  }

  /** The queue's counts, as a LiveStore condition (applied with the next frame). */
  private publish(): void {
    if (this.disposed) return
    const next = { pending: this.queue.size(), deadLetters: this.queue.deadLetters() }
    const { live } = this.options
    this.options.frames.queue('outbox', () => live.setOutbox(next))
  }

  private emitOutcome(outcome: OutboxOutcome): void {
    for (const listener of [...this.outcomeListeners]) {
      try {
        listener(outcome)
      } catch (err) {
        // An observer must never wedge the drain that called us.
        log.warn('outbox outcome listener threw', { err, type: outcome.type })
      }
    }
  }
}
