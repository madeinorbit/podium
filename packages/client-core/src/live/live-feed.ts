/**
 * THE LIVE FEED: the service that writes the LiveStore (POD-5798).
 *
 * It owns every subscription behind the store's readings and is the only
 * writer of its topic and connection fields. Screens never see it.
 *
 * - `account.quota:<me>` and `machine.condition:<id>` for every machine the
 *   replica holds a record of (POD-6644) are held for the runtime's whole life (ADR 7 Amendment 2 D18:
 *   "the runtime root simply subscribes to machine condition and quota for its
 *   lifetime").
 * - `machine.metrics:<id>` is held only while a reader watches that machine's
 *   metrics (the store's demand hook), so a daemon samples only then.
 * - `account.usage:<me>` is held only while a usage reader watches
 *   `live.usage()`, so the server harvests transcripts only then.
 * - `session.condition:<id>` and `session.terminalState:<id>` are held only
 *   while a reader watches that session's reading (POD-6764), so the keys this
 *   connection holds follow what is on screen.
 *
 * The connection condition is the connection service's and the outbox counts
 * the outbox service's (runtime-root/, POD-6681); all three write through the
 * root's one frame queue.
 *
 * APPLIED AT MOST ONCE PER FRAME (ADR 7 Amendment 2 D20). Readings are queued
 * by key, the newest replacing an older one still waiting, and the whole queue
 * goes into the store in one action per animation frame (one macrotask when the
 * page is hidden; `./frame-queue.ts`). Topic frames never wait behind the sync
 * feed: the hub hands them over on their own path, and this queue is separate
 * from the feed's.
 */

import type { RecordLiveTopicKind } from '@podium/model'
import type { TopicKind, TopicPayload } from '@podium/protocol'
import type { TopicListener, TopicState } from '../socket-transport/subscriptions'
import { LiveFrameQueue, type LiveFrameScheduler } from './frame-queue'
import {
  knownReading,
  type LiveStore,
  type LiveTopicKind,
  type Reading,
  unknownReading,
} from './live-store'

export type { LiveFrameScheduler } from './frame-queue'

/** The slice of the socket hub the feed uses. */
export interface LiveFeedHub {
  subscribeTopic<K extends TopicKind>(
    kind: K,
    id: string,
    listener: TopicListener<TopicPayload<K>>,
  ): () => void
}

/** The machines whose condition the feed holds: the `machine` records the
 *  replica keeps (POD-6644), every one I may know about. */
export interface LiveFeedMachines {
  ids(): readonly string[]
  /** Run `changed` after the set may have moved. Answers the unsubscribe. */
  subscribe(changed: () => void): () => void
}

export interface LiveFeedOptions {
  readonly hub: LiveFeedHub
  readonly machines: LiveFeedMachines
  readonly live: LiveStore
  /** The signed-in account: `account.quota:<userId>`. */
  readonly userId: string
  readonly now?: () => number
  /** The runtime root's frame queue, shared with the connection and outbox
   *  services; the root disposes it. Absent: the feed keeps its own. */
  readonly frames?: LiveFrameQueue
  /** For a feed that keeps its own queue (tests): how that queue reaches a frame. */
  readonly scheduler?: LiveFrameScheduler
}

/** A topic state as a reading. `pending` and `closed` are unknown (D20). */
export function readingOfTopic<T>(state: TopicState<T>, now: number): Reading<T> {
  switch (state.status) {
    case 'value':
      return knownReading(state.value, now)
    case 'unknown':
      return unknownReading(state.since, state.last)
    case 'closed':
      return unknownReading(now, state.last)
    case 'pending':
      return unknownReading(now)
  }
}

export class LiveFeed {
  private readonly hub: LiveFeedHub
  private readonly live: LiveStore
  private readonly now: () => number
  private readonly frames: LiveFrameQueue
  /** Whether {@link frames} is this feed's own, to dispose with it. */
  private readonly ownsFrames: boolean
  /** Runtime demand: every known machine needs a current online condition. */
  private machineIds = new Set<string>()
  /** All held record live parts, as `kind:id`. */
  private readonly readings = new Map<string, () => void>()
  private offs: Array<() => void> = []
  private releaseQuota: (() => void) | undefined
  private releaseUsage: (() => void) | undefined
  private started = false
  private disposed = false

  constructor(private readonly options: LiveFeedOptions) {
    this.hub = options.hub
    this.live = options.live
    this.now = options.now ?? Date.now
    this.ownsFrames = options.frames === undefined
    this.frames = options.frames ?? new LiveFrameQueue(options.scheduler)
  }

  /** Arm every subscription. Idempotent; re-arms after {@link stop} (StrictMode). */
  start(): void {
    if (this.started || this.disposed) return
    this.started = true
    this.releaseQuota = this.hub.subscribeTopic('account.quota', this.options.userId, {
      onState: (state) => this.queueTopic('account.quota', this.options.userId, state),
    })
    const machines = this.options.machines
    this.offs.push(machines.subscribe(() => this.followMachines(machines.ids())))
    this.followMachines(machines.ids())
    for (const { kind, id } of this.live.watchedRecords()) this.watchRecord(kind, id, true)
    if (this.live.usageWatched) this.watchUsage(true)
  }

  /** Release every subscription. The readings stay until {@link dispose}. */
  stop(): void {
    if (!this.started) return
    this.started = false
    for (const off of this.offs.splice(0)) off()
    this.releaseQuota?.()
    this.releaseQuota = undefined
    this.machineIds.clear()
    for (const release of this.readings.values()) release()
    this.readings.clear()
    this.releaseUsage?.()
    this.releaseUsage = undefined
  }

  /** Sign-out. */
  dispose(): void {
    if (this.disposed) return
    this.stop()
    this.disposed = true
    if (this.ownsFrames) this.frames.dispose()
  }

  /**
   * The store's usage demand: a usage reader mounted or left. Unwatched, the
   * key is released and the reading goes unknown, keeping its last value for
   * the next reader's first frame ("last read 14:32").
   */
  watchUsage(watched: boolean): void {
    if (this.disposed) return
    const id = this.options.userId
    if (!watched) {
      this.releaseUsage?.()
      this.releaseUsage = undefined
      this.queue(`account.usage:${id}`, () => {
        const held = this.live.usage()
        if (held.known)
          this.live.applyTopic('account.usage', id, unknownReading(this.now(), held.value))
      })
      return
    }
    if (!this.started || this.releaseUsage) return
    this.releaseUsage = this.hub.subscribeTopic('account.usage', id, {
      onState: (state) => this.queueTopic('account.usage', id, state),
    })
  }

  /** First/last watcher of any declared record live part. */
  watchRecord(kind: RecordLiveTopicKind, id: string, watched: boolean): void {
    if (this.disposed) return
    const key = `${kind}:${id}`
    if (!watched) {
      // The runtime itself watches known machines' conditions (D18). A view
      // leaving cannot release that lifetime demand.
      if (kind === 'machine.condition' && this.machineIds.has(id)) return
      this.readings.get(key)?.()
      this.readings.delete(key)
      this.queue(key, () => {
        if (!this.readings.has(key)) this.live.applyTopic(kind, id, undefined)
      })
      return
    }
    if (!this.started || this.readings.has(key)) return
    this.readings.set(
      key,
      this.hub.subscribeTopic(kind, id, {
        onState: (state) => this.queueTopic(kind, id, state),
      }),
    )
  }

  private followMachines(ids: readonly string[]): void {
    if (!this.started) return
    const previous = this.machineIds
    this.machineIds = new Set(ids)
    const watched = new Set(this.live.watchedIds('machine.condition'))
    for (const id of previous)
      if (!this.machineIds.has(id) && !watched.has(id))
        this.watchRecord('machine.condition', id, false)
    for (const id of this.machineIds) this.watchRecord('machine.condition', id, true)
  }

  private queueTopic(kind: LiveTopicKind, id: string, state: TopicState<unknown>): void {
    const reading = readingOfTopic(state, this.now())
    this.queue(`${kind}:${id}`, () => this.live.applyTopic(kind, id, reading))
  }

  private queue(key: string, write: () => void): void {
    if (this.disposed) return
    this.frames.queue(key, write)
  }
}
