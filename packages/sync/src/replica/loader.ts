/**
 * THE ONE LOADER (POD-7087, design POD-7059 "One loader, one route",
 * "Lookup", "Search and references").
 *
 * Its input is a list of INSTANCES of declared collections; its output is
 * whole records in the device store's memory, with a marker per instance
 * (the Replica's `load`). The Replica answers from TWO SOURCES (POD-7159,
 * design POD-7157 "The loader: two sources"): an instance on disk is read
 * from disk, with no server request; the rest goes over the one fetch route
 * and is written to disk and memory together. It:
 *  - collects requests for 50 ms and removes duplicates, so many lookups in
 *    one burst make one request;
 *  - skips what the device already holds complete, or is fetching;
 *  - sends what a visible view asks for first. Before the first download
 *    has a feed to answer against, the visible requests ride in that
 *    download as its second step (`takeView`, the Replica's `view`);
 *  - starts nothing from the server without a connection. A view reads
 *    that as "not available offline" (`status`), never as an endless
 *    loading row; the queue is sent when the connection returns. What the
 *    device answers itself (from disk) is sent offline too.
 *
 * Two things hold an instance: the policy (the Replica's own) and a view
 * that reads it (`show`, which the pool calls for every read: holding
 * follows reading, POD-7158). What no view reads any more is cache, whether
 * a lookup's "one record" instance or the records a request returned.
 *
 * Nothing here is per screen: a screen that needs another question gets a
 * collection definition, never a branch in this file.
 */

import { COLLECTIONS, recordOf } from '@podium/model'
import { instanceKey } from './cache-state'
import { SideMap, SideSet } from './side-state'
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

/** POD-7538 — the first and the longest wait before a stale reload that broke off is sent again. */
export const STALE_RETRY_MS = 1_000
export const STALE_RETRY_MAX_MS = 60_000

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
  /** POD-7159 — whether the device answers the instance itself (from disk): sent offline too. */
  onDevice?(spec: InstanceSpec): boolean
  /** POD-7159 — whether a record is whole on disk and not in memory. */
  isUnloaded?(entity: string, entityId: string): boolean
  /** POD-7159 — read records whole on disk into memory, by key. */
  loadRecords?(entity: string, entityIds: readonly string[]): Promise<void>
  /** POD-7160 — whether the device holds the instance behind the feed (after a gap): it reloads when read. */
  instanceStale?(spec: InstanceSpec): boolean
  /** Freshness of one record through all instances that hold it on the device. */
  recordStale?(entity: string, id: string): boolean
  staleRecordHolders?(entity: string, id: string): readonly InstanceRecord[]
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
  /** The platform may know the network is down before the feed socket closes. */
  readonly connectivity?: {
    isOnline(): boolean
    subscribe(onChange: () => void): () => void
  }
}

/** Counted for tests and meters. */
export interface LoaderStats {
  /** Requests sent through the fetch route. */
  requests: number
  /** Instances those requests named, duplicates never counted twice. */
  instances: number
  /** Instances that rode in the first download's view step. */
  viewInstances: number
  /** Changes told to the views: at most one of each kind per burst (POD-7165). */
  notifications: number
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
  /** Marker identity changes on replacement: one request per holder per stale period, with no retained history. */
  private readonly staleRecordRequests = new WeakSet<InstanceRecord>()
  readonly windowMs: number
  readonly stats: LoaderStats = { requests: 0, instances: 0, viewInstances: 0, notifications: 0 }
  private readonly replica: LoaderReplica
  private readonly schedule: LoaderSchedule
  private readonly connectivity: LoaderOptions['connectivity']
  private readonly stopConnectivity: (() => void) | undefined
  private readonly queue = new SideMap<string, Queued>('loader.queue')
  /** Sent and not answered yet; a key here is never sent again. */
  private readonly inFlight = new SideMap<string, InstanceRequest>('loader.inFlight')
  /** POD-7560 — later pages held in the queue while their instance's answer was in flight. */
  private readonly waited = new SideSet<string>('loader.waited')
  /** Sent in the first download's view step; back to the queue if it ends without them. */
  private readonly riding = new SideMap<string, InstanceRequest>('loader.riding')
  /** POD-7159 — records to read from disk in the next window. */
  private readonly diskRecords = new SideMap<
    string,
    { readonly entity: string; readonly id: string }
  >('loader.diskRecords')
  private readonly listeners = new SideSet<(change: LoaderChange) => void>('loader.listeners')
  private cancel: (() => void) | null = null
  /** POD-7538 — the timer of the next stale reload retry, and the wait after it. */
  private retryCancel: (() => void) | null = null
  private retryMs = STALE_RETRY_MS
  /**
   * One fetch to the server at a time. The server runs a few fetches for
   * every client together and refuses the rest; sending every batch at once
   * had a large screen's demand refused and asked again in a loop.
   */
  private sending = false
  /** Inside a burst of the Replica's events: what moved, told once when it ends. */
  private burst = 0
  private readonly moved = new SideSet<LoaderChange>('loader.moved')
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
    this.connectivity = options.connectivity
    this.wasOnline = this.online
    this.stopConnectivity = this.connectivity?.subscribe(() => {
      if (this.disposed) return
      this.reconnected()
      this.notify('connection')
      if (this.queue.size > 0) this.arm()
    })
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
      if (this.held(request)) continue
      if (this.riding.has(key)) continue
      // A refused instance is asked again only on a real trigger (reconnect,
      // access change, `retryRefused`), never because a reader read it.
      if (this.refusedKeys.has(key)) continue
      const sending = this.inFlight.get(key)
      // POD-7560: a later page of a held instance, asked while another
      // position of it is answered (a stale board's whole reload), is
      // queued rather than dropped: `flush` sends it once that answer is in.
      if (
        sending !== undefined &&
        (request.after === undefined ||
          samePosition(sending.after, request.after) ||
          this.replica.isComplete(request) === undefined)
      )
        continue
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
   * Ask for the records a request returned (server search hits), each as its
   * "one record" instance, without holding them: a view that reads them holds
   * them through the pool (`holdRecords`). A record already whole on the
   * device is answered from it, with no fetch (POD-7159).
   */
  requestRecords(kind: string, ids: readonly string[], priority: LoadPriority = 'visible'): void {
    this.request(
      ids.map((id) => oneRecord(kind, id)),
      priority,
    )
  }

  /** How a view reads an instance. Offline only for what neither memory nor disk holds. */
  status(spec: InstanceSpec): LoadStatus {
    if (this.replica.isComplete(spec) !== undefined) return 'complete'
    return this.online || this.replica.onDevice?.(spec) === true ? 'loading' : 'offline'
  }

  /**
   * POD-7160 — whether the device holds the instance behind the feed: a gap
   * the feed could not bridge left it on the device. It reads as usual (its
   * `status` is complete once in memory), and a read reloads it in place;
   * POD-7166 shows it as refreshing.
   */
  isStale(spec: InstanceSpec): boolean {
    return this.replica.instanceStale?.(spec) === true
  }

  /** A fresh holder makes a shared record current, even when another holder is stale. */
  recordStale(entity: string, id: string): boolean {
    const holders = this.replica.staleRecordHolders?.(entity, id)
    if (holders === undefined) return this.replica.recordStale?.(entity, id) === true
    const requests: InstanceSpec[] = []
    for (const holder of holders) {
      if (this.staleRecordRequests.has(holder)) continue
      this.staleRecordRequests.add(holder)
      const { collection, args, part, via } = holder
      requests.push({ collection, args, part, ...(via === undefined ? {} : { via }) })
    }
    if (requests.length > 0) this.request(requests, 'background')
    return holders.length > 0
  }

  /**
   * POD-7159 — whether a record is whole on the device's disk and not in
   * memory: a reader gets LOADING and a disk load (`loadFromDisk`), never
   * "gone".
   */
  unloaded(entity: string, entityId: string): boolean {
    return this.replica.isUnloaded?.(entity, entityId) === true
  }

  /**
   * POD-7159 — read records that are on disk into memory, batched in the
   * window like any request, and with no connection too.
   */
  loadFromDisk(entity: string, entityIds: readonly string[]): void {
    if (this.disposed || this.replica.loadRecords === undefined) return
    let added = false
    for (const id of entityIds) {
      const key = `${entity}\u0000${id}`
      if (this.diskRecords.has(key)) continue
      this.diskRecords.set(key, { entity, id })
      added = true
    }
    if (added) this.arm()
  }

  /** Whether the device has a connection to load over (the view's "not available offline"). */
  get online(): boolean {
    return this.connected && this.connectivity?.isOnline() !== false
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

  /**
   * One burst of the Replica's events (the composition root's `batchEvents`):
   * the views hear each kind of change once, when the burst ends, not once
   * per record (POD-7165: an answer of 1,000 issues told every view of the
   * stubs 1,000 times).
   */
  batch(emitAll: () => void): void {
    this.burst += 1
    try {
      emitAll()
    } finally {
      this.burst -= 1
      if (this.burst === 0 && this.moved.size > 0) {
        const moved = [...this.moved]
        this.moved.clear()
        for (const change of moved) this.notify(change)
      }
    }
  }

  /** Pipe the Replica's events here (the composition root fans them out). */
  onEvent(event: ReplicaEvent): void {
    if (this.disposed) return
    switch (event.type) {
      case 'posture': {
        const connected = isConnected(event.posture)
        const moved = connected !== this.connected
        this.connected = connected
        this.reconnected()
        // A first download that ended without its view step gives those back.
        if (event.previous === 'bootstrapping' && event.posture !== 'bootstrapping') this.unride()
        if (moved) this.notify('connection')
        if (this.queue.size > 0) this.arm()
        return
      }
      case 'markers':
        for (const [key, request] of this.riding)
          if (this.replica.isComplete(request) !== undefined) this.riding.delete(key)
        // An instance completed another way (a reload, the feed): no longer refused.
        for (const [key, spec] of this.refusedKeys)
          if (this.replica.isComplete(spec) !== undefined) this.refusedKeys.delete(key)
        this.notify('markers')
        return
      case 'cursor':
        if (this.queue.size > 0 && this.replica.canFetch) this.arm()
        return
      case 'upserted':
        // A readmitted record came back into this viewer's view: access changed.
        if (event.readmitted) this.accessChanged()
        if (hasStub(event.record.entity)) this.notify('stubs')
        return
      case 'stub-upserted':
        if (hasStub(event.record.entity)) this.notify('stubs')
        return
      case 'evicted':
        // A record left this viewer's view: access changed.
        this.accessChanged()
        if (hasStub(event.entity)) this.notify('stubs')
        return
      case 'kind-reload-installed':
        this.accessChanged()
        return
      case 'released':
      case 'removed':
      // POD-7160: a feed change written to disk only moves its stub too.
      case 'unloaded':
        if (hasStub(event.entity)) this.notify('stubs')
        return
      // The first download ends for the views when its records are in the
      // store's memory (POD-7122), not when they are durable.
      case 'load-installed':
      case 'bootstrap-installed':
        // A rebootstrap (a rescope among its causes) may answer differently.
        if (event.type === 'bootstrap-installed') this.accessChanged()
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
    if (this.disposed) return
    const sends: Promise<void>[] = []
    if (this.diskRecords.size > 0) sends.push(this.sendDiskRecords())
    if (this.queue.size === 0) {
      await Promise.all(sends)
      return
    }
    // Without a connection, or before the first download has a feed, nothing
    // can start from the server: the queue waits for the connection or the
    // cursor. What the device answers from disk goes now (POD-7159).
    const offline = !this.online || !this.replica.canFetch
    const queued = [...this.queue.values()]
      .sort((a, b) => rank(a.priority) - rank(b.priority))
      .map((entry) => entry.request)
    const batch: InstanceRequest[] = []
    // A fetch in flight, or the wait after a failed one: the queue waits.
    const blocked = this.sending || this.retryCancel !== null
    for (const queuedRequest of queued) {
      let request = queuedRequest
      const key = instanceKey(request)
      if (request.after !== undefined && this.inFlight.has(key)) {
        // POD-7560: a later page waits for its instance's answer in flight
        // (`send` arms again when it ends), then goes below what the device
        // holds after it.
        this.waited.add(key)
        continue
      }
      if (this.waited.delete(key) && request.after !== undefined) {
        const range = this.replica.isComplete(request)?.range
        if (range?.through !== undefined && !range.end) {
          request = { ...request, after: range.through }
          this.queue.set(key, { request, priority: this.queue.get(key)?.priority ?? 'background' })
        }
      }
      if (this.held(request)) {
        this.queue.delete(key)
        continue
      }
      if (offline && this.replica.onDevice?.(request) !== true) continue
      // One batch per fetch; the rest goes when its answer is in.
      if (blocked || batch.length >= MAX_INSTANCES) continue
      this.queue.delete(key)
      batch.push(request)
    }
    if (batch.length === 0) {
      await Promise.all(sends)
      return
    }
    sends.push(this.send(batch))
    await Promise.all(sends)
  }

  /** Forget everything; nothing further starts. */
  dispose(): void {
    this.disposed = true
    this.stopConnectivity?.()
    this.cancel?.()
    this.cancel = null
    this.retryCancel?.()
    this.retryCancel = null
    this.queue.clear()
    this.waited.clear()
    this.diskRecords.clear()
    this.listeners.clear()
  }

  // ------------------------------------------------------------ internals

  private async sendDiskRecords(): Promise<void> {
    const byEntity = new Map<string, string[]>()
    for (const { entity, id } of this.diskRecords.values()) {
      const ids = byEntity.get(entity)
      if (ids === undefined) byEntity.set(entity, [id])
      else ids.push(id)
    }
    this.diskRecords.clear()
    await Promise.all(
      [...byEntity].map(([entity, ids]) =>
        this.replica.loadRecords?.(entity, ids).catch(() => undefined),
      ),
    )
  }

  private async send(requests: readonly InstanceRequest[]): Promise<void> {
    if (requests.length === 0) return
    const fromDevice = new Set(
      requests.filter((request) => this.replica.onDevice?.(request) === true).map(instanceKey),
    )
    for (const request of requests) this.inFlight.set(instanceKey(request), request)
    this.sending = true
    this.stats.requests += 1
    this.stats.instances += requests.length
    let failed = false
    try {
      await this.replica.load(requests)
    } catch {
      // The answer broke off (the connection dropped mid-answer): what it
      // installed stays, and the rest is asked again.
      failed = true
      // A browser can reject a fetch before delivering its offline event.
      // Read the platform and feed state, never the browser's error text.
      if (!this.online) this.notify('connection')
    } finally {
      this.sending = false
      for (const request of requests) {
        const key = instanceKey(request)
        if (this.inFlight.get(key) === request) this.inFlight.delete(key)
      }
    }
    if (this.disposed) return
    // POD-7560: a later page that waited for this answer goes now.
    if (requests.some((request) => this.waited.has(instanceKey(request)))) this.arm()
    let retry = false
    for (const request of requests) {
      const key = instanceKey(request)
      if (this.replica.isComplete(request) !== undefined) {
        // A stale disk load requests its replacement before this send has
        // left inFlight. Keep that handoff: it was deduplicated while the
        // disk answer landed, and reconnect must still reload it. Only a
        // disk answer queues here at once.
        if (fromDevice.has(key) && this.replica.instanceStale?.(request) === true) {
          if (!this.queue.has(key)) this.queue.set(key, { request, priority: 'background' })
          if (this.connected) this.arm()
        } else if (failed && this.replica.instanceStale?.(request) === true) {
          // POD-7538: a stale reload that broke off goes again: after a wait
          // that doubles from 1 s to 60 s, and, like every request queued
          // again, with the next burst or cursor move. A screen never stays
          // refreshing for ever.
          if (!this.queue.has(key)) this.queue.set(key, { request, priority: 'background' })
          retry = true
        }
        continue
      }
      // Queued again behind the wait that doubles from 1 s to 60 s: a failing
      // route (the server's queue full) is never asked again on every burst
      // or cursor move.
      if (failed) {
        if (!this.queue.has(key)) this.queue.set(key, { request, priority: 'background' })
        retry = true
      } else this.refusedKeys.set(key, request)
    }
    if (retry) this.retryLater()
    else {
      if (!failed) this.retryMs = STALE_RETRY_MS
      // The rest of the queue goes now that this answer is in.
      if (this.queue.size > 0 && this.replica.canFetch) this.arm()
    }
    this.notify('markers')
  }

  /** POD-7538 — send the queue again after the current wait, then double the wait. */
  private retryLater(): void {
    if (this.retryCancel !== null || this.disposed) return
    const wait = this.retryMs
    this.retryMs = Math.min(this.retryMs * 2, STALE_RETRY_MAX_MS)
    this.retryCancel = this.schedule(() => {
      this.retryCancel = null
      if (this.queue.size > 0) this.arm()
    }, wait)
  }

  /**
   * Whether the device already holds what `request` asks for. An instance's
   * key ignores a page's position, so a later page (`after`) of a paged
   * instance the device holds part of is not held yet: its marker has a
   * range short of the end, through exactly that position (POD-7158: next
   * pages were dropped as complete and never loaded).
   */
  private held(request: InstanceRequest): boolean {
    const marker = this.replica.isComplete(request)
    if (marker === undefined) return false
    // POD-7160: a stale instance is asked again: the Replica reloads it.
    if (this.replica.instanceStale?.(request) === true) return false
    if (request.after === undefined) return true
    const range = marker.range
    return range === undefined || range.end || !samePosition(range.through, request.after)
  }

  /**
   * Answered in full without a marker: the server will not say this one is
   * complete (POD-7595). A refused instance SETTLES: `request` drops it, so a
   * reader that reads it again asks for nothing. It is asked again only on a
   * real trigger: the connection returns (`reconnected`), this viewer's
   * access changes (`accessChanged`), or a view retries it (`retryRefused`).
   */
  private readonly refusedKeys = new SideMap<string, InstanceSpec>('loader.refusedKeys')
  /** The last connection state `reconnected` saw: a refusal is forgotten on the way back up. */
  private wasOnline = false

  /** Whether an answer came back in full without this instance's marker. */
  wasRefused(spec: InstanceSpec): boolean {
    return this.refusedKeys.has(instanceKey(spec))
  }

  /**
   * Forget a refusal (POD-7595): the instance, or every refused one, may be
   * asked for again. The views hear the markers moved, and a reader that
   * still reads the instance asks for it. A view's explicit retry.
   */
  retryRefused(spec?: InstanceSpec): void {
    if (this.disposed || this.refusedKeys.size === 0) return
    if (spec === undefined) this.refusedKeys.clear()
    else if (!this.refusedKeys.delete(instanceKey(spec))) return
    this.notify('markers')
  }

  /** The connection came back: what the server refused may be answered now. */
  private reconnected(): void {
    const online = this.online
    const back = online && !this.wasOnline
    this.wasOnline = online
    if (back) this.retryRefused()
  }

  /** This viewer's access may have changed: every refusal is asked again. */
  private accessChanged(): void {
    this.retryRefused()
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
    // While a failed fetch's wait runs, its timer arms the queue when it ends.
    if (this.cancel !== null || this.retryCancel !== null || this.disposed) return
    this.cancel = this.schedule(() => {
      this.cancel = null
      void this.flush()
    }, this.windowMs)
  }

  private notify(change: LoaderChange): void {
    if (this.burst > 0) {
      this.moved.add(change)
      return
    }
    this.stats.notifications += 1
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

/** Two page positions, value by value. */
const samePosition = (
  a: readonly unknown[] | undefined,
  b: readonly unknown[] | undefined,
): boolean =>
  a !== undefined &&
  b !== undefined &&
  a.length === b.length &&
  a.every((value, at) => value === b[at])

const hasStub = (kind: string): boolean => (recordOf(kind)?.stub.length ?? 0) > 0

/** The postures with a connection: a load can start, or will once the feed answers. */
function isConnected(posture: Posture): boolean {
  return posture === 'live' || posture === 'healing' || posture === 'bootstrapping'
}
