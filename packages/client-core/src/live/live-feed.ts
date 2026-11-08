/**
 * THE LIVE FEED: the service that writes the LiveStore (POD-5798).
 *
 * It owns every subscription behind the store's readings and is the only
 * writer of its topic and connection fields. Screens never see it.
 *
 * - `account.quota:<me>` and `machine.condition:<id>` for every machine the
 *   client knows are held for the runtime's whole life (ADR 7 Amendment 2 D18:
 *   "the runtime root simply subscribes to machine condition and quota for its
 *   lifetime").
 * - `machine.metrics:<id>` is held only while a reader watches that machine's
 *   metrics (the store's demand hook), so a daemon samples only then.
 * - `account.usage:<me>` is held only while a usage reader watches
 *   `live.usage()`, so the server harvests transcripts only then.
 * - The connection condition follows the socket hub: its health rule, ping
 *   round-trip, clock skew and the server identity from each `welcome`.
 *
 * APPLIED AT MOST ONCE PER FRAME (ADR 7 Amendment 2 D20). Readings are queued
 * by key, the newest replacing an older one still waiting, and the whole queue
 * goes into the store in one action per animation frame (one macrotask when the
 * page is hidden). Topic frames never wait behind the sync feed: the hub hands
 * them over on their own path, and this queue is separate from the feed's.
 */

import type { MachineWire } from '@podium/model'
import type { TopicKind, TopicPayload } from '@podium/protocol'
import { ConversationFrameScheduler } from '../conversation/frame-scheduler'
import type { ConnectionHealth, ServerIdentity } from '../socket-transport/socket-hub'
import type { TopicListener, TopicState } from '../socket-transport/subscriptions'
import {
  type ConnectionCondition,
  type ConnectionState,
  knownReading,
  type LiveStore,
  type LiveTopicKind,
  type OutboxCondition,
  type Reading,
  unknownReading,
} from './live-store'

/** The slice of the socket hub the feed uses. */
export interface LiveFeedHub {
  subscribeTopic<K extends TopicKind>(
    kind: K,
    id: string,
    listener: TopicListener<TopicPayload<K>>,
  ): () => void
  machines(): MachineWire[]
  connectionHealth(): ConnectionHealth
  serverIdentity(): ServerIdentity | null
  clockSkewMs(): number | null
  readonly connected: boolean
  on(event: 'machines', handler: (machines: MachineWire[]) => void): () => void
  on(event: 'connectionHealth', handler: (health: ConnectionHealth) => void): () => void
  on(event: 'serverIdentity', handler: (identity: ServerIdentity) => void): () => void
  on(event: 'clockSkew', handler: (skewMs: number) => void): () => void
}

/** How queued readings reach the store: once per paint by default. */
export interface LiveFrameScheduler {
  enqueue(work: () => void): void
  dispose(): void
}

export interface LiveFeedOptions {
  readonly hub: LiveFeedHub
  readonly live: LiveStore
  /** The signed-in account: `account.quota:<userId>`. */
  readonly userId: string
  readonly now?: () => number
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

export function connectionStateOf(health: ConnectionHealth, connected: boolean): ConnectionState {
  if (health.status === 'down') return 'offline'
  // Before the first connection the hub reports `ok` with no socket: the
  // first dial, not a loss (the fatal-error page owns that messaging).
  if (!connected) return 'connecting'
  return health.status === 'degraded' ? 'degraded' : 'online'
}

export class LiveFeed {
  private readonly hub: LiveFeedHub
  private readonly live: LiveStore
  private readonly now: () => number
  private readonly scheduler: LiveFrameScheduler
  /** The newest write per key, waiting for the next frame. */
  private readonly queued = new Map<string, () => void>()
  private flushQueued = false
  private readonly conditions = new Map<string, () => void>()
  private readonly metrics = new Map<string, () => void>()
  private offs: Array<() => void> = []
  private releaseQuota: (() => void) | undefined
  private releaseUsage: (() => void) | undefined
  private started = false
  private disposed = false

  constructor(private readonly options: LiveFeedOptions) {
    this.hub = options.hub
    this.live = options.live
    this.now = options.now ?? Date.now
    this.scheduler = options.scheduler ?? new ConversationFrameScheduler()
  }

  /** Arm every subscription. Idempotent; re-arms after {@link stop} (StrictMode). */
  start(): void {
    if (this.started || this.disposed) return
    this.started = true
    this.releaseQuota = this.hub.subscribeTopic('account.quota', this.options.userId, {
      onState: (state) => this.queueTopic('account.quota', this.options.userId, state),
    })
    this.offs.push(this.hub.on('machines', (machines) => this.followMachines(machines)))
    this.followMachines(this.hub.machines())
    for (const id of this.live.watchedMetrics) this.watchMetrics(id, true)
    if (this.live.usageWatched) this.watchUsage(true)
    this.offs.push(this.hub.on('connectionHealth', () => this.queueConnection()))
    this.offs.push(this.hub.on('serverIdentity', () => this.queueConnection()))
    this.offs.push(this.hub.on('clockSkew', () => this.queueConnection()))
    this.queueConnection()
  }

  /** Release every subscription. The readings stay until {@link dispose}. */
  stop(): void {
    if (!this.started) return
    this.started = false
    for (const off of this.offs.splice(0)) off()
    this.releaseQuota?.()
    this.releaseQuota = undefined
    for (const release of this.conditions.values()) release()
    this.conditions.clear()
    for (const release of this.metrics.values()) release()
    this.metrics.clear()
    this.releaseUsage?.()
    this.releaseUsage = undefined
  }

  /** Sign-out. */
  dispose(): void {
    if (this.disposed) return
    this.stop()
    this.disposed = true
    this.queued.clear()
    this.scheduler.dispose()
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

  /** The store's demand hook: a reader started or stopped watching a machine's metrics. */
  watchMetrics(machineId: string, watched: boolean): void {
    if (this.disposed) return
    if (!watched) {
      this.metrics.get(machineId)?.()
      this.metrics.delete(machineId)
      // Held only while watched: an unwatched reading would go stale silently.
      this.queue(`machine.metrics:${machineId}`, () =>
        this.live.applyTopic('machine.metrics', machineId, undefined),
      )
      return
    }
    if (!this.started || this.metrics.has(machineId)) return
    this.metrics.set(
      machineId,
      this.hub.subscribeTopic('machine.metrics', machineId, {
        onState: (state) => this.queueTopic('machine.metrics', machineId, state),
      }),
    )
  }

  /** The outbox service's counts, applied with the frame like every other reading. */
  setOutbox(next: OutboxCondition): void {
    this.queue('outbox', () => this.live.setOutbox(next))
  }

  private followMachines(machines: readonly MachineWire[]): void {
    if (!this.started) return
    const wanted = new Set(machines.map((machine) => String(machine.id)))
    for (const [id, release] of this.conditions) {
      if (wanted.has(id)) continue
      release()
      this.conditions.delete(id)
      this.queue(`machine.condition:${id}`, () =>
        this.live.applyTopic('machine.condition', id, undefined),
      )
    }
    for (const id of wanted) {
      if (this.conditions.has(id)) continue
      this.conditions.set(
        id,
        this.hub.subscribeTopic('machine.condition', id, {
          onState: (state) => this.queueTopic('machine.condition', id, state),
        }),
      )
    }
  }

  private queueTopic(kind: LiveTopicKind, id: string, state: TopicState<unknown>): void {
    const reading = readingOfTopic(state, this.now())
    this.queue(`${kind}:${id}`, () => this.live.applyTopic(kind, id, reading))
  }

  private queueConnection(): void {
    this.queue('connection', () => {
      const health = this.hub.connectionHealth()
      const identity = this.hub.serverIdentity()
      const skewMs = this.hub.clockSkewMs()
      const state = connectionStateOf(health, this.hub.connected)
      const previous = this.live.connection
      const next: ConnectionCondition = {
        state,
        since: state === previous.state ? previous.since : health.since,
        ...(health.rttMs !== null && state !== 'offline' ? { pingMs: health.rttMs } : {}),
        ...(skewMs !== null ? { skewMs } : {}),
        ...(identity?.build !== undefined ? { serverBuild: identity.build } : {}),
        ...(identity?.features !== undefined ? { serverFeatures: identity.features } : {}),
      }
      if (sameConnection(previous, next)) return
      // DECLARED LOST (D20): every reading of the present goes unknown with it.
      if (state === 'offline' && previous.state !== 'offline')
        this.live.markAllUnknown(health.since)
      this.live.setConnection(next)
    })
  }

  private queue(key: string, write: () => void): void {
    if (this.disposed) return
    this.queued.delete(key)
    this.queued.set(key, write)
    if (this.flushQueued) return
    this.flushQueued = true
    this.scheduler.enqueue(() => this.flush())
  }

  /** One frame: every queued reading, in one action (the scheduler's). */
  private flush(): void {
    this.flushQueued = false
    if (this.disposed) return
    const writes = [...this.queued.values()]
    this.queued.clear()
    for (const write of writes) write()
  }
}

function sameConnection(a: ConnectionCondition, b: ConnectionCondition): boolean {
  return (
    a.state === b.state &&
    a.since === b.since &&
    a.pingMs === b.pingMs &&
    a.skewMs === b.skewMs &&
    a.serverBuild === b.serverBuild &&
    sameList(a.serverFeatures, b.serverFeatures)
  )
}

function sameList(a: readonly string[] | undefined, b: readonly string[] | undefined): boolean {
  if (a === b) return true
  if (!a || !b || a.length !== b.length) return false
  return a.every((value, index) => value === b[index])
}
