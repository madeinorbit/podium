/**
 * THE ONE LOADER (POD-7087, design POD-7059 "One loader, one route",
 * "Lookup", "Search and references").
 *
 * Its input is a list of INSTANCES of declared collections; its output is
 * whole records installed in the device store, with a marker per instance
 * (the Replica's `load`, over the one fetch route). It:
 *  - collects requests for 50 ms and removes duplicates, so many lookups in
 *    one burst make one request;
 *  - skips what the device already holds complete, or is fetching;
 *  - sends what a visible view asks for first. Before the first download
 *    has a feed to answer against, the visible requests ride in that
 *    download as its second step (`takeView`, the Replica's `view`);
 *  - starts nothing without a connection. A view reads that as "not
 *    available offline" (`status`), never as an endless loading row; the
 *    queue is sent when the connection returns.
 *
 * Two things hold an instance: the policy (the Replica's own) and an open
 * view (`show`). Everything else a load brings is cache: the records of a
 * lookup ("one record" instances) and the records a request returns
 * (`requestRecords`), whose ids the view keeps.
 *
 * Nothing here is per screen: a screen that needs another question gets a
 * collection definition, never a branch in this file.
 */

import { COLLECTIONS, recordOf } from '@podium/model'
import { instanceKey } from './cache-state'
import type {
  InstanceRecord,
  InstanceRequest,
  InstanceSpec,
  Posture,
  ReplicaEvent,
  StubRow,
} from './types'

/** The batch window: requests within it load in one request. */
export const LOADER_WINDOW_MS = 50

/** Most instances one request names (the route's bound, `COLLECTION_FETCH_MAX_INSTANCES`). */
const MAX_INSTANCES = 200

/** Arms a timer; returns its cancel. Tests pass a manual one. */
export type LoaderSchedule = (run: () => void, ms: number) => () => void

/** What the loader needs of the device store's Replica. */
export interface LoaderReplica {
  readonly posture: Posture
  /** Whether a load can start: the device has a feed to answer against. */
  readonly canFetch: boolean
  isComplete(spec: InstanceSpec): InstanceRecord | undefined
  load(requests: readonly InstanceRequest[]): Promise<void>
  hold(spec: InstanceSpec): () => void
  stubOf(entity: string, entityId: string): Readonly<Record<string, unknown>> | undefined
  stubsByParent(parentId: string): readonly string[]
  stubRows(entity: string): readonly StubRow[]
  /** The record at a reference (repository and number), by the stubs. */
  stubIdAt?(entity: string, repoId: string, seq: number): string | undefined
}

/** How a view reads one instance: held complete, on its way, or not loadable without a connection. */
export type LoadStatus = 'complete' | 'loading' | 'offline'

/**
 * What moved, for a view that reads it: the markers (what `status` and
 * `isComplete` answer), the stubs (what counts read), or the connection.
 */
export type LoaderChange = 'markers' | 'stubs' | 'connection'

/** Who asks: a visible view goes first. */
export type LoadPriority = 'visible' | 'background'

export interface LoaderOptions {
  readonly replica: LoaderReplica
  readonly windowMs?: number
  readonly schedule?: LoaderSchedule
}

/** Counted for tests and meters. */
export interface LoaderStats {
  /** Requests sent through the fetch route. */
  requests: number
  /** Instances those requests named, duplicates never counted twice. */
  instances: number
  /** Instances that rode in the first download's view step. */
  viewInstances: number
}

const realSchedule: LoaderSchedule = (run, ms) => {
  const timer = setTimeout(run, ms)
  return () => clearTimeout(timer)
}

/** The "one record" collection of a record type: what a lookup that finds the record absent loads. */
export function oneRecord(kind: string, id: string): InstanceRequest {
  const collection = `${kind}.one`
  if (!COLLECTIONS.has(collection)) throw new Error(`[loader] ${kind} declares no "one" collection`)
  return { collection, args: { id }, part: 'main' }
}

/** Whether `kind` is a record type the loader can fetch one record of. */
export function loadsOneRecord(kind: string): boolean {
  return recordOf(kind) !== undefined && COLLECTIONS.has(`${kind}.one`)
}

interface Queued {
  readonly request: InstanceRequest
  priority: LoadPriority
}

export class CollectionLoader {
  readonly windowMs: number
  readonly stats: LoaderStats = { requests: 0, instances: 0, viewInstances: 0 }
  private readonly replica: LoaderReplica
  private readonly schedule: LoaderSchedule
  private readonly queue = new Map<string, Queued>()
  /** Sent and not answered yet; a key here is never sent again. */
  private readonly inFlight = new Map<string, InstanceRequest>()
  /** Sent in the first download's view step; back to the queue if it ends without them. */
  private readonly riding = new Map<string, InstanceRequest>()
  private readonly listeners = new Set<(change: LoaderChange) => void>()
  private cancel: (() => void) | null = null
  private connected = false
  private disposed = false
  /** The device started empty and its first download has not finished. */
  private fresh: boolean

  constructor(options: LoaderOptions) {
    this.replica = options.replica
    this.windowMs = options.windowMs ?? LOADER_WINDOW_MS
    this.schedule = options.schedule ?? realSchedule
    this.connected = isConnected(this.replica.posture)
    this.fresh = !this.replica.canFetch
  }

  /**
   * Whether the device started empty and its first download is still under
   * way. A reload after a gap is not one: its old rows stay on screen.
   */
  get firstDownload(): boolean {
    return this.fresh
  }

  // ------------------------------------------------------------ asking

  /**
   * Ask for instances. Duplicates within the window, and instances the
   * device holds complete or is fetching, are dropped; a visible request
   * raises a queued background one to the front.
   */
  request(requests: readonly InstanceRequest[], priority: LoadPriority = 'background'): void {
    if (this.disposed) return
    let added = false
    for (const request of requests) {
      const key = instanceKey(request)
      if (this.replica.isComplete(request) !== undefined) continue
      if (this.inFlight.has(key) || this.riding.has(key)) continue
      this.refusedKeys.delete(key)
      const queued = this.queue.get(key)
      if (queued !== undefined) {
        if (priority === 'visible' && queued.priority !== 'visible') {
          queued.priority = 'visible'
          added = true
        }
        continue
      }
      this.queue.set(key, { request, priority })
      added = true
    }
    if (added) this.arm()
  }

  /**
   * An open view holds an instance: the trim never drops it while held, and
   * it loads first. Returns the release; a released instance is cache.
   */
  show(spec: InstanceRequest): () => void {
    const release = this.replica.hold(spec)
    this.request([spec], 'visible')
    return release
  }

  /**
   * The records a request returned (server search hits): each is installed
   * as a "one record" instance, cache, never held. The view keeps the ids.
   */
  requestRecords(kind: string, ids: readonly string[], priority: LoadPriority = 'visible'): void {
    this.request(
      ids.map((id) => oneRecord(kind, id)),
      priority,
    )
  }

  /** How a view reads an instance. Offline only for what is not complete. */
  status(spec: InstanceSpec): LoadStatus {
    if (this.replica.isComplete(spec) !== undefined) return 'complete'
    return this.connected ? 'loading' : 'offline'
  }

  /** Whether the device has a connection to load over (the view's "not available offline"). */
  get online(): boolean {
    return this.connected
  }

  /** The marker of an instance the device holds complete. */
  isComplete(spec: InstanceSpec): InstanceRecord | undefined {
    return this.replica.isComplete(spec)
  }

  /** Reads the device store answers from stubs (design "Counts", "Lookup"). */
  stubOf(entity: string, entityId: string): Readonly<Record<string, unknown>> | undefined {
    return this.replica.stubOf(entity, entityId)
  }

  stubsByParent(parentId: string): readonly string[] {
    return this.replica.stubsByParent(parentId)
  }

  stubRows(entity: string): readonly StubRow[] {
    return this.replica.stubRows(entity)
  }

  stubIdAt(entity: string, repoId: string, seq: number): string | undefined {
    return this.replica.stubIdAt?.(entity, repoId, seq)
  }

  /** Something a view may read changed: markers, stubs, the connection. */
  subscribe(listener: (change: LoaderChange) => void): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  // ------------------------------------------------------------ the replica's side

  /**
   * The first download starts: it carries the visible requests as its
   * second step. They are in flight with it until their markers land.
   */
  takeView(): InstanceRequest[] {
    const out: InstanceRequest[] = []
    for (const [key, queued] of this.queue) {
      if (queued.priority !== 'visible') continue
      out.push(queued.request)
      this.riding.set(key, queued.request)
      this.queue.delete(key)
    }
    this.stats.viewInstances += out.length
    return out
  }

  /** Pipe the Replica's events here (the composition root fans them out). */
  onEvent(event: ReplicaEvent): void {
    if (this.disposed) return
    switch (event.type) {
      case 'posture': {
        const connected = isConnected(event.posture)
        const moved = connected !== this.connected
        this.connected = connected
        // A first download that ended without its view step gives those back.
        if (event.previous === 'bootstrapping' && event.posture !== 'bootstrapping') this.unride()
        if (moved) this.notify('connection')
        if (this.queue.size > 0) this.arm()
        return
      }
      case 'markers':
        for (const [key, request] of this.riding)
          if (this.replica.isComplete(request) !== undefined) this.riding.delete(key)
        this.notify('markers')
        return
      case 'cursor':
        if (this.queue.size > 0 && this.replica.canFetch) this.arm()
        return
      case 'upserted':
      case 'stub-upserted':
        if (hasStub(event.record.entity)) this.notify('stubs')
        return
      case 'released':
      case 'removed':
      case 'evicted':
        if (hasStub(event.entity)) this.notify('stubs')
        return
      // The first download ends for the views when its records are in the
      // store's memory (POD-7122), not when they are durable.
      case 'load-installed':
      case 'bootstrap-installed':
        if (this.fresh) {
          this.fresh = false
          this.notify('markers')
          this.notify('stubs')
          return
        }
        if (event.type === 'bootstrap-installed') this.notify('stubs')
        return
      case 'bootstrap-failed':
        this.unride()
        return
      default:
        return
    }
  }

  /** Close the window now (the timer's run; tests and harnesses drain it). */
  async flush(): Promise<void> {
    this.cancel?.()
    this.cancel = null
    if (this.disposed || this.queue.size === 0) return
    // Without a connection, or before the first download has a feed, nothing
    // can start: the queue waits for the connection or the cursor.
    if (!this.connected || !this.replica.canFetch) return
    const batch = [...this.queue.values()]
      .sort((a, b) => rank(a.priority) - rank(b.priority))
      .map((queued) => queued.request)
      .filter((request) => this.replica.isComplete(request) === undefined)
    this.queue.clear()
    const sends: Promise<void>[] = []
    for (let at = 0; at < batch.length; at += MAX_INSTANCES)
      sends.push(this.send(batch.slice(at, at + MAX_INSTANCES)))
    await Promise.all(sends)
  }

  /** Forget everything; nothing further starts. */
  dispose(): void {
    this.disposed = true
    this.cancel?.()
    this.cancel = null
    this.queue.clear()
    this.listeners.clear()
  }

  // ------------------------------------------------------------ internals

  private async send(requests: readonly InstanceRequest[]): Promise<void> {
    if (requests.length === 0) return
    for (const request of requests) this.inFlight.set(instanceKey(request), request)
    this.stats.requests += 1
    this.stats.instances += requests.length
    let failed = false
    try {
      await this.replica.load(requests)
    } catch {
      // The answer broke off (the connection dropped mid-answer): what it
      // installed stays, and the rest is asked again.
      failed = true
    } finally {
      for (const request of requests) this.inFlight.delete(instanceKey(request))
    }
    if (this.disposed) return
    for (const request of requests) {
      if (this.replica.isComplete(request) !== undefined) continue
      const key = instanceKey(request)
      // Queued again without arming: it goes with the next burst, cursor or
      // connection, never in a loop of its own against a failing route.
      if (failed) {
        if (!this.queue.has(key)) this.queue.set(key, { request, priority: 'background' })
      } else this.refusedKeys.add(key)
    }
    this.notify('markers')
  }

  /** Answered in full without a marker: the server will not say this one is complete. */
  private readonly refusedKeys = new Set<string>()

  /** Whether an answer came back in full without this instance's marker. */
  wasRefused(spec: InstanceSpec): boolean {
    return this.refusedKeys.has(instanceKey(spec))
  }

  private unride(): void {
    if (this.riding.size === 0) return
    for (const [key, request] of this.riding) {
      if (this.replica.isComplete(request) === undefined && !this.queue.has(key))
        this.queue.set(key, { request, priority: 'visible' })
    }
    this.riding.clear()
    if (this.queue.size > 0) this.arm()
  }

  private arm(): void {
    if (this.cancel !== null || this.disposed) return
    this.cancel = this.schedule(() => {
      this.cancel = null
      void this.flush()
    }, this.windowMs)
  }

  private notify(change: LoaderChange): void {
    for (const listener of [...this.listeners]) {
      try {
        listener(change)
      } catch {
        // A listener's failure is its own.
      }
    }
  }
}

const rank = (priority: LoadPriority): number => (priority === 'visible' ? 0 : 1)

const hasStub = (kind: string): boolean => (recordOf(kind)?.stub.length ?? 0) > 0

/** The postures with a connection: a load can start, or will once the feed answers. */
function isConnected(posture: Posture): boolean {
  return posture === 'live' || posture === 'healing' || posture === 'bootstrapping'
}
