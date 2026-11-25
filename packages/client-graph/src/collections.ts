/**
 * THE DEVICE'S COLLECTIONS, AS THE POOL READS THEM (POD-7087, design POD-7059
 * "Lookup", "Counts", "One loader, one route").
 *
 * The one loader (`@podium/sync` `CollectionLoader`, reached through the row
 * source) fetches whatever a lookup or a view asks for; this module makes its
 * answers TRACKED for MobX readers and puts the three lookup answers on them:
 *
 *  - here: the device holds it (a stub is "here" for a reader of stub fields);
 *  - on its way (`LOADING`): the loader was asked, in its 50 ms batch. Without
 *    a connection a load cannot start; the view reads `offline` from the
 *    connection state and shows "not available offline", never an endless
 *    loading row. That is the view's reading of LOADING, not a fourth answer;
 *  - gone: the server answered the record's "one record" instance complete
 *    and the record is not in it (not visible to this viewer).
 *
 * Counts (design "Counts"): a collection complete on the device is counted
 * locally. Counts by stage and by repository, child counts and tree progress
 * read the stubs, for all history, once the stub collection is complete (or
 * the tree's own instance is, at stub level or whole); until then LOADING. A
 * count under a filter the stub cannot answer is the total that came with
 * the first page of that list.
 *
 * Nothing here names a screen: a screen that needs another question gets a
 * collection definition.
 */

import { createDemandAtoms, observingViews } from '@podium/mobx-helpers'
import { RECORDS } from '@podium/model'
import { isFinished } from '@podium/model/browser'
import { SideMap, SideSet, sideStateUpkeep, signalledRead } from '@podium/sync/side-state'
import { action, createAtom, type IAtom, runInAction, spy } from 'mobx'
import { LOADING } from './loading'
import { type Gone, NOT_VISIBLE } from './lookup'
import type { Holding } from './shared/holding-relations'
import type { CollectionLoaderPort, LoaderInstance } from './shared/source'

/** The record kind of a pool entity whose records the loader fetches one by one. */
export const LOADER_KIND = { issue: 'issueProjection', session: 'session' } as const
export type LoaderEntity = keyof typeof LOADER_KIND

/** The issue stub's fields (`@podium/model` declaration): reference, state, parent. */
export interface IssueStub {
  readonly id: string
  readonly repoId?: string | null
  readonly seq?: number
  readonly type?: string
  readonly stage?: string
  readonly closedReason?: string | null
  readonly archived?: boolean
  readonly deletedAt?: string | null
  readonly isDraftVessel?: boolean
  readonly audience?: string | null
  readonly parentId?: string | null
}

/** The instance a lookup that finds a record absent loads. */
export function oneRecordOf(entity: LoaderEntity, id: string): LoaderInstance {
  return { collection: `${LOADER_KIND[entity]}.one`, args: { id }, part: 'main' }
}

/** Every issue at stub level: the collection counts over all history read. */
export const ISSUE_STUBS: LoaderInstance = { collection: 'issueProjection.stubs', part: 'stub' }

/** The tree under a top-level issue, at stub level or whole. */
export function treeOf(root: string, part: 'stub' | 'main' = 'main'): LoaderInstance {
  return { collection: 'issueProjection.tree', args: { root }, part }
}

/** One page of a stage, sorted: a board column, the proposal deck. */
export function stagePage(stage: string): LoaderInstance {
  return { collection: 'issueProjection.byStage', args: { stage }, part: 'main' }
}

/** One page of a stage under a priority filter: its total comes with the page. */
export function stagePriorityPage(stage: string, priority: number): LoaderInstance {
  return { collection: 'issueProjection.byStagePriority', args: { stage, priority }, part: 'main' }
}

/**
 * How a view reads an instance or a lookup: here, on its way, not loadable
 * offline, or refused by the server (`unavailable`, POD-7595).
 */
export type Availability = 'complete' | 'refreshing' | 'loading' | 'offline' | 'unavailable'

/** Freshness is separate from presence: refreshing answers remain usable. */
export type Reading = 'here' | 'refreshing' | 'loading' | 'offline' | 'unavailable' | 'gone'

export type { Holding }
export type AnswerSource = LoaderInstance | { readonly entity: LoaderEntity; readonly id: string }

/** Child counts as the issue close contract counts them: every child, only `done` completed. */
export interface StubChildCounts {
  readonly childCount: number
  readonly childDoneCount: number
}

/** A tree's members under its root, and how many are done. */
export interface StubTreeProgress {
  readonly total: number
  readonly done: number
}

const ISSUE = LOADER_KIND.issue

/** The replica's record kind of a pool entity (the row source's own mapping). */
const replicaKind = (entity: string): string => (entity === 'issue' ? ISSUE : entity)

/** What a reader of an instance's marker reads: whether it is held, to where, of how many, refused. */
interface MarkerSeen {
  readonly held: boolean
  readonly stale: boolean
  readonly end: boolean | undefined
  readonly through: string | undefined
  readonly total: number | undefined
  readonly refused: boolean
}

const sameMarker = (a: MarkerSeen, b: MarkerSeen): boolean =>
  a.held === b.held &&
  a.stale === b.stale &&
  a.end === b.end &&
  a.through === b.through &&
  a.total === b.total &&
  a.refused === b.refused

const sameStub = (a: IssueStub | undefined, b: IssueStub | undefined): boolean => {
  if (a === b) return true
  if (a === undefined || b === undefined) return false
  const keys = Object.keys(a) as (keyof IssueStub)[]
  return keys.length === Object.keys(b).length && keys.every((key) => a[key] === b[key])
}

const sameChildCounts = (a: StubChildCounts, b: StubChildCounts): boolean =>
  a.childCount === b.childCount && a.childDoneCount === b.childDoneCount

/**
 * POD-7165 — what views read at one key (an instance's marker, an issue's
 * stub, a parent's child counts), each key with its own atom. When the device
 * store says the markers or the stubs moved, each read key is read again and
 * only the readers of a key whose value moved are told. One atom for every
 * key told every reader after every install: opening a deck of 1,000 issues
 * re-ran every row's reads once per answer, and once per parent in a chain.
 */
class KeyedReads<T> {
  private readonly seen = new SideMap<string, T>('collections.keyedReads.seen')
  private readonly demand: ReturnType<typeof createDemandAtoms<string>>

  constructor(
    name: string,
    private readonly value: (key: string) => T,
    private readonly same: (a: T, b: T) => boolean,
    onUnobserved?: (key: string) => void,
  ) {
    this.demand = createDemandAtoms<string>((key) => `${name}:${key}`, {
      onUnobserved: (key) => {
        this.seen.delete(key)
        onUnobserved?.(key)
      },
    })
  }

  /** TRACKED: the value at `key`. */
  read(key: string): T {
    // untracked-read: collections-keyed-read
    return signalledRead(() => {
      const value = this.value(key)
      if (this.demand.observe(key) && !this.seen.has(key)) this.seen.set(key, value)
      return value
    })
  }

  /** Whether a reader observes `key`. */
  tracks(key: string): boolean {
    return this.seen.has(key)
  }

  /** What the keys read from moved: tell the readers of each key whose value did. Call inside an action. */
  moved(): void {
    for (const [key, before] of this.seen) {
      const now = this.value(key)
      if (this.same(before, now)) continue
      this.seen.set(key, now)
      this.demand.get(key)?.reportChanged()
    }
  }

  clear(): void {
    this.seen.clear()
    this.demand.clear()
  }
}

/** One instance, as the reads map keys it (the kernel's instance key, minus a page's position). */
const readKey = (spec: LoaderInstance): string =>
  JSON.stringify([
    spec.collection,
    spec.part,
    spec.via ?? '',
    Object.entries(spec.args ?? {}).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
  ])

/** A view reading bodies for a list is probably fetching one body per row. */
export const BODY_INSTANCE_WARNING_THRESHOLD = 20

/** Only constructed in development; no counters, scans or microtasks in production. */
class BodyReadWarnings {
  private queued = false
  private active = false
  private readonly warned = new WeakSet<object>()
  // side-state: declaration: collection-to-kind metadata for development diagnostics only
  private readonly kinds = new Map<string, string>(
    RECORDS.filter((record) => record.group === 'body').flatMap((record) =>
      Object.values(record.collections).map((collection) => [collection.id, record.kind] as const),
    ),
  )

  private readonly stop: () => void

  constructor(private readonly held: () => Iterable<{ spec: LoaderInstance; atom: IAtom }>) {
    // A second view can read already-cached computed fields without visiting
    // holdWhileRead again. Recheck after reaction tracking binds that reader.
    this.stop = spy((event) => {
      if (this.active && event.type === 'reaction') this.check()
    })
  }

  read(spec: LoaderInstance): void {
    if (!this.kinds.has(spec.collection)) return
    this.active = true
    this.check()
  }

  dispose(): void {
    this.stop()
  }

  private check(): void {
    if (this.queued) return
    this.queued = true
    // MobX binds a computed's observers after its getter returns. Count the
    // final live graph, so reruns and released holds cannot inflate it.
    queueMicrotask(() => {
      this.queued = false
      this.active = false
      const views = new Map<object, { name: string; count: number; kinds: Set<string> }>()
      for (const { spec, atom } of this.held()) {
        const kind = this.kinds.get(spec.collection)
        if (kind === undefined) continue
        this.active = true
        for (const { view, name } of observingViews(atom)) {
          if (this.warned.has(view)) continue
          let seen = views.get(view)
          if (seen === undefined) {
            seen = { name, count: 0, kinds: new Set() }
            views.set(view, seen)
          }
          seen.count += 1
          seen.kinds.add(kind)
        }
      }
      for (const [view, seen] of views) {
        if (seen.count <= BODY_INSTANCE_WARNING_THRESHOLD) continue
        this.warned.add(view)
        console.warn(
          `[pool] Body read misuse: ${seen.name} holds ${seen.count} body instances (${[...seen.kinds].join(', ')}); limit ${BODY_INSTANCE_WARNING_THRESHOLD}. Lists must not read body fields per row.`,
        )
      }
    })
  }
}

export class PoolCollections {
  /** A reader with no loader yet must hear when a device store is attached. */
  private readonly attachment = createAtom('pool.collections.attachment')
  private readonly markers: IAtom
  private readonly stubs: IAtom
  private readonly connection: IAtom
  private bound: CollectionLoaderPort | undefined
  private off: (() => void) | undefined
  private disposed = false
  /** Only the shared fullDevice fixture helper opts into the old row-only answers. */
  private fullDeviceFixture = false
  /** Per stub array the kernel hands out (its own memo): tallies already counted. */
  private readonly tallies = new WeakMap<object, Map<string, ReadonlyMap<unknown, number>>>()
  /** Per stub array: the issue of each repository and number. */
  private readonly refIndexes = new WeakMap<object, Map<string, string>>()
  /** Per stub array: whether each repository has a live issue, or only deleted ones. */
  private readonly repoPresence = new WeakMap<object, Map<string, 'live' | 'deleted'>>()
  /**
   * What an open view reads, by its key: the instance, its hold's release
   * once taken, and for a "one record" instance the record it is for.
   */
  private readonly reads = new SideMap<
    string,
    { spec: LoaderInstance; release?: () => void; record?: { entity: LoaderEntity; id: string } }
  >('collections.reads')
  /**
   * The records whose "one record" instance an open view holds now, by
   * entity: a reader of such a record keeps the hold after the record
   * arrived (`keepRecord`). Only held ones; a release forgets the id.
   */
  private readonly heldRecords: Record<LoaderEntity, Set<string>> = {
    issue: new SideSet('collections.heldRecords.issue'),
    session: new SideSet('collections.heldRecords.session'),
  }
  /**
   * HOLDING FOLLOWS READING (POD-7155, POD-7158; design POD-7157 "Layer 2:
   * memory"). An instance an open view reads is held while the view reads
   * it (design "Two holders of an instance": the policy and an open view)
   * and is cache again once no view does, with no timer here (the warm
   * set's grace is POD-7161's). Every read that needs an instance takes its
   * hold here: `held`, `pageEnded`, `pageTotal`, `treeHeld`, a lookup
   * (`absent`, then `keepRecord` while the record is read) and the records
   * a request returned (`holdRecords`). There is no other way for a view to
   * ask the loader for an instance: as cache, a tree or a page bigger than
   * the cap was trimmed after every answer while its view still read it,
   * and asked for again (the flight deck never settled, POD-7155).
   */
  private readonly readDemand = createDemandAtoms<string>((key) => `pool.collections.read:${key}`, {
    onObserved: (key) => {
      const read = this.reads.get(key)
      const loader = this.loader()
      if (read === undefined || read.release !== undefined || loader === undefined) return
      read.release = loader.show(read.spec)
    },
    onUnobserved: (key) => this.releaseRead(key),
  })

  private declare readonly bodyReadWarnings?: BodyReadWarnings

  /** Development diagnostics only: the live views retaining this instance. */
  observedBy(spec: LoaderInstance, view: object): boolean {
    if (process.env.NODE_ENV !== 'production') {
      const atom = this.readDemand.get(readKey(spec))
      return atom !== undefined && observingViews(atom).some((entry) => entry.view === view)
    }
    return false
  }

  /** POD-7165: the instances whose markers views read, by key, each told only when it moved. */
  private readonly markerSpecs = new SideMap<string, LoaderInstance>('collections.markerSpecs')
  private readonly markerReads = new KeyedReads<MarkerSeen>(
    'pool.collections.marker',
    (key) => this.markerOf(this.markerSpecs.get(key)),
    sameMarker,
    (key) => this.markerSpecs.delete(key),
  )
  private readonly recordStaleReads = new KeyedReads<boolean>(
    'pool.collections.recordStale',
    (key) => {
      const [entity, id] = JSON.parse(key) as [string, string]
      return this.loader()?.recordStale?.(replicaKind(entity), id) === true
    },
    Object.is,
  )
  /** POD-7165: an issue's stub, by id, told only when it moved. */
  private readonly stubReads = new KeyedReads<IssueStub | undefined>(
    'pool.collections.stub',
    (id) => this.loader()?.stubOf(ISSUE, id) as IssueStub | undefined,
    sameStub,
  )
  /** POD-7165: a parent's child counts, by parent, told only when they moved. */
  private readonly childCountReads = new KeyedReads<StubChildCounts>(
    'pool.collections.children',
    (parentId) => {
      const loader = this.loader()
      const children = loader?.stubsByParent(parentId) ?? []
      let done = 0
      for (const id of children) if (isFinished(loader?.stubOf(ISSUE, id) ?? {})) done += 1
      return { childCount: children.length, childDoneCount: done }
    },
    sameChildCounts,
  )

  constructor(private source: () => CollectionLoaderPort | undefined) {
    this.markers = createAtom('pool.collections.markers')
    this.stubs = createAtom('pool.collections.stubs')
    this.connection = createAtom('pool.collections.connection')
    if (process.env.NODE_ENV !== 'production') {
      this.bodyReadWarnings = new BodyReadWarnings(() => {
        const held: { spec: LoaderInstance; atom: IAtom }[] = []
        for (const [key, atom] of this.readDemand) {
          const read = this.reads.get(key)
          if (read !== undefined) held.push({ spec: read.spec, atom })
        }
        return held
      })
    }
  }

  /**
   * Read another device store's collections (a pool built from rows, such as
   * the startup check's states). Every reader hears of it. Normal attachment
   * clears the declaration made by the shared fullDevice fixture helper.
   */
  @action attach(source: () => CollectionLoaderPort | undefined, fixture?: 'full-device'): void {
    this.source = source
    this.fullDeviceFixture = fixture === 'full-device'
    this.attachment.reportChanged()
    this.markersMoved()
    this.stubsMoved()
    this.connection.reportChanged()
  }

  /** The loader, subscribed once it exists. */
  private loader(): CollectionLoaderPort | undefined {
    // Observe before any early return, including the no-loader fixture path.
    this.attachment.reportObserved()
    if (this.disposed) return undefined
    const loader = this.source()
    if (loader !== this.bound) {
      this.off?.()
      this.bound = loader
      this.off = loader?.subscribe((change) => {
        if (change === 'markers' || change === 'stubs') this.moved(change)
        else this.connection.reportChanged()
      })
    }
    return loader
  }

  /**
   * A TRACKED answer's loader reads (POD-7454). The loader's state is side
   * state; each caller observes, in the same derivation, the marker, stub,
   * connection or attachment atom its answer depends on, and the loader's
   * notifications report those atoms.
   */
  private behind<T>(read: () => T): T {
    // untracked-read: collections-loader-read
    return signalledRead(read)
  }

  /** Whether this pool reads a device store with collections at all. */
  get available(): boolean {
    return this.loader() !== undefined
  }

  // ------------------------------------------------------------ instances

  /** TRACKED: whether the device holds the instance complete. */
  complete(spec: LoaderInstance): boolean {
    return this.behind(() => {
      this.observeMarker(spec)
      return this.loader()?.isComplete(spec) !== undefined
    })
  }

  /** TRACKED: here, on its way, or not loadable without a connection. */
  status(spec: LoaderInstance): Availability {
    return this.behind(() => {
      this.observeMarker(spec)
      this.connection.reportObserved()
      const loader = this.loader()
      if (loader?.isComplete(spec) !== undefined && loader.isStale?.(spec)) return 'refreshing'
      if (loader?.isComplete(spec) === undefined && loader?.wasRefused(spec)) return 'unavailable'
      return (
        loader?.status(spec) ?? (this.fullDeviceFixture && !this.disposed ? 'complete' : 'loading')
      )
    })
  }

  /**
   * TRACKED (POD-7160): the device holds the instance behind the feed: a gap
   * the feed could not bridge left it on the device, readable as usual, and
   * a read reloads it in place. POD-7166 shows it as refreshing.
   */
  isStale(spec: LoaderInstance): boolean {
    return this.behind(() => {
      this.observeMarker(spec)
      return this.loader()?.isStale?.(spec) === true
    })
  }

  /** TRACKED: whether the device has a connection to load over. */
  get online(): boolean {
    return this.behind(() => {
      this.connection.reportObserved()
      return this.loader()?.online ?? true
    })
  }

  /**
   * TRACKED: the device started empty and its first download is under way.
   * A reload after a gap is not one: its old rows stay on screen.
   */
  get firstDownload(): boolean {
    return this.behind(() => {
      this.markers.reportObserved()
      return this.loader()?.firstDownload ?? false
    })
  }

  /**
   * TRACKED: how a view reads an answer from its own instances. A stale,
   * complete instance still vouches for the answer at the device's cursor,
   * even offline while its reload is queued. Scalars carry no provenance:
   * their reader supplies the instances it used, never all pool instances.
   * Without a
   * connection a load cannot start: the view shows "not available offline"
   * (`offline`), never an endless loading row; it recovers by itself when the
   * connection returns and the record arrives. An answer from an instance
   * the server refused is `unavailable` (POD-7595): settled on what the
   * device holds, never an endless loading row.
   */
  reading(answer: unknown, instances: readonly AnswerSource[] = []): Reading {
    if (typeof answer === 'object' && answer !== null && (answer as Gone).kind === 'gone')
      return 'gone'
    const statuses = instances.map((spec) =>
      'collection' in spec ? this.status(spec) : this.recordStale(spec.entity, spec.id),
    )
    const refused = statuses.includes('unavailable')
    if (answer === LOADING) return refused ? 'unavailable' : this.online ? 'loading' : 'offline'
    if (statuses.some((status) => status === 'refreshing' || status === true)) return 'refreshing'
    return refused ? 'unavailable' : 'here'
  }

  /** TRACKED: freshness of a lookup/search hit, regardless of which instance fetched it. */
  recordStale(entity: LoaderEntity, id: string): boolean {
    return this.recordStaleReads.read(JSON.stringify([entity, id]))
  }

  /** TRACKED: the same tree instance that `treeHeld` reads (own tree, else its top ancestor). */
  treeStatus(id: string): Availability {
    const root = this.complete(treeOf(id)) ? id : (this.topOf(id) ?? id)
    return this.status(treeOf(root))
  }

  /**
   * TRACKED: whether the device holds a paged instance to its end (or
   * whole). The reader holds it, every page of it, while it reads it; a
   * device that holds no page of it asks for the first.
   */
  pageEnded(spec: LoaderInstance): boolean {
    return this.behind(() => {
      const loader = this.loader()
      this.observeMarker(spec)
      this.holdWhileRead(spec)
      const marker = loader?.isComplete(spec)
      // A refused page is not asked again because it is read (`Holding`).
      if (marker === undefined) return loader?.wasRefused(spec) === true ? false : this.ask(spec)
      return marker.range === undefined || marker.range.end
    })
  }

  /**
   * TRACKED: a paged instance's whole size for this viewer, from its first
   * page. The reader holds the instance while it reads it, as `pageEnded`.
   */
  pageTotal(spec: LoaderInstance): number | typeof LOADING {
    return this.behind(() => {
      const loader = this.loader()
      this.observeMarker(spec)
      this.holdWhileRead(spec)
      const marker = loader?.isComplete(spec)
      if (marker === undefined && loader?.wasRefused(spec) !== true) this.ask(spec)
      return marker?.total ?? LOADING
    })
  }

  /**
   * A paged instance an open view reads (`pageEnded`, `pageTotal`, `held`)
   * and the device holds part of: ask for the page after the last one it
   * holds, unless that was the end. A view calls it when its reader nears
   * the end of what is held ("the next cards"). The next page is part of
   * the same instance, so the reader that holds the first page holds it
   * too; an instance no view reads gets no next page.
   */
  nextPage(spec: LoaderInstance): void {
    const loader = this.loader()
    if (loader === undefined || !this.reads.has(readKey(spec))) return
    const range = loader.isComplete(spec)?.range
    if (range === undefined || range.end || range.through === undefined) return
    loader.request([{ ...spec, after: range.through as LoaderInstance['after'] }], 'visible')
  }

  /**
   * TRACKED: whether the server answered the instance in full without its
   * marker, and the device does not hold it complete: it will not say the
   * instance is complete. The reads below answer not held and ask for
   * nothing more (`Holding`).
   */
  refused(spec: LoaderInstance): boolean {
    return this.behind(() => {
      this.observeMarker(spec)
      const loader = this.loader()
      return loader?.isComplete(spec) === undefined && (loader?.wasRefused(spec) ?? false)
    })
  }

  /**
   * POD-7595 — ask for a refused instance again, or for every refused one: a
   * view's "try again". Its readers read it as loading until it is answered.
   * The connection's return and an access change retry by themselves.
   */
  retry(spec?: LoaderInstance): void {
    // untracked-read: collections-retry
    sideStateUpkeep(() => {
      this.loader()?.retryRefused?.(spec)
    })
  }

  /**
   * TRACKED: whether the device holds the instance complete; if not, and
   * the server has not refused it, ask for it at the front of the queue. The
   * reader holds it while it reads it. Without a loader, false unless
   * fullDevice explicitly vouches for a fixture. A refused instance answers
   * false and asks for nothing: a reader that shows it reads `holding` to
   * say it is unavailable.
   */
  held(spec: LoaderInstance): boolean {
    return this.holding(spec) === 'held'
  }

  /** TRACKED: where a read of the instance stands (`Holding`); asks for it while loading. */
  holding(spec: LoaderInstance): Holding {
    return this.behind(() => {
      const loader = this.loader()
      if (loader === undefined) return this.fullDeviceFixture && !this.disposed ? 'held' : 'loading'
      this.holdWhileRead(spec)
      if (this.complete(spec)) return 'held'
      if (loader.wasRefused(spec)) return 'refused'
      this.ask(spec)
      return 'loading'
    })
  }

  /** Ask for an instance a reader waits on, at the front of the queue. The loader drops a refused one. */
  private ask(spec: LoaderInstance): false {
    this.loader()?.request([spec], 'visible')
    return false
  }

  /**
   * TRACKED: a view reads these records by id, the records a request
   * returned (server search hits). Each one's "one record" instance is held
   * while the view reads the ids, and loads first; once no view does, they
   * are cache. The view reads each record through `pool.model`, so there is
   * still one shared model per record.
   */
  holdRecords(entity: LoaderEntity, ids: readonly string[]): void {
    if (this.loader() === undefined) return
    for (const id of ids) this.holdRecord(entity, id)
  }

  // ------------------------------------------------------------ lookups

  /**
   * A record the device does not hold whole: LOADING and one batched load,
   * or gone once the server answered without it. Without a loader there is
   * nothing to ask: `undefined`, and the caller answers as it did before.
   */
  absent(entity: LoaderEntity, id: string): typeof LOADING | Gone | undefined {
    return this.behind(() => {
      const loader = this.loader()
      if (loader === undefined) return undefined
      const spec = this.holdRecord(entity, id)
      this.observeMarker(spec)
      if (loader.isComplete(spec) !== undefined || loader.wasRefused(spec)) return NOT_VISIBLE
      loader.request([spec], 'visible')
      return LOADING
    })
  }

  /**
   * POD-7159 — whether a record of a pool entity is whole on the device's
   * disk and not in memory: its reader gets LOADING and a disk load.
   */
  unloaded(entity: string, id: string): boolean {
    const loader = this.loader()
    // untracked-read: collections-unloaded
    return signalledRead(() => loader?.unloaded?.(replicaKind(entity), id) === true)
  }

  /** POD-7159 — read an unloaded record from disk, batched in the loader's window. */
  reload(entity: string, id: string): void {
    // untracked-read: collections-reload
    sideStateUpkeep(() => {
      this.loader()?.loadFromDisk?.(replicaKind(entity), [id])
    })
  }

  /**
   * TRACKED: a reader reads a record the pool holds. When an open view holds
   * the record's "one record" instance (it looked the record up, or a
   * request returned it), this reader keeps that hold: the record stays
   * while it is read, and is cache once nothing reads it. The pool calls it
   * for every issue and session row it hands out; a record nobody looked up
   * costs one set lookup.
   */
  keepRecord(entity: LoaderEntity, id: string): void {
    // untracked-read: collections-keep-record
    if (sideStateUpkeep(() => this.heldRecords[entity].has(id)))
      this.holdWhileRead(oneRecordOf(entity, id))
  }

  /** TRACKED: the issue's stub as the device holds it (a stub, or picked from the whole record). */
  stubOf(id: string): IssueStub | undefined {
    return this.stubReads.read(id)
  }

  /** TRACKED: the issue with this repository and number, by the stubs the device holds. */
  stubIdAt(repoId: string, seq: number): string | undefined {
    return this.behind(() => {
      const loader = this.loader()
      if (loader === undefined) return undefined
      this.stubs.reportObserved()
      if (loader.stubIdAt !== undefined) return loader.stubIdAt(ISSUE, repoId, seq)
      const rows = loader.stubRows(ISSUE)
      let index = this.refIndexes.get(rows)
      if (index === undefined) {
        index = new Map()
        for (const row of rows) {
          const { repoId: repo, seq: number } = row.stub
          if (typeof repo !== 'string' || typeof number !== 'number') continue
          const key = `${repo}:${number}`
          const held = index.get(key)
          if (held === undefined || row.id < held) index.set(key, row.id)
        }
        this.refIndexes.set(rows, index)
      }
      return index.get(`${repoId}:${seq}`)
    })
  }

  /** TRACKED: whether the device holds a stub in the repository (undeleted unless asked). */
  hasStubIn(repoId: string, includeDeleted = false): boolean {
    return this.behind(() => {
      const loader = this.loader()
      if (loader === undefined) return false
      this.stubs.reportObserved()
      const rows = loader.stubRows(ISSUE)
      let presence = this.repoPresence.get(rows)
      if (presence === undefined) {
        presence = new Map()
        for (const row of rows) {
          const repo = row.stub['repoId']
          if (typeof repo !== 'string') continue
          const live = !row.stub['deletedAt']
          presence.set(repo, presence.get(repo) === 'live' || live ? 'live' : 'deleted')
        }
        this.repoPresence.set(rows, presence)
      }
      const held = presence.get(repoId)
      return held === 'live' || (includeDeleted && held === 'deleted')
    })
  }

  /** An existence question over the fixed issue stub fields, for all history. */
  someIssue(test: (stub: IssueStub) => boolean): boolean | typeof LOADING {
    return this.behind(() => {
      const loader = this.loader()
      if (!loader || !this.stubsComplete) return LOADING
      this.stubs.reportObserved()
      return loader.stubRows(ISSUE).some(({ stub }) => test(stub as unknown as IssueStub))
    })
  }

  /** TRACKED: whether the device's stubs cover all history. */
  get stubsComplete(): boolean {
    return this.complete(ISSUE_STUBS)
  }

  // ------------------------------------------------------------ counts

  /**
   * TRACKED: issues over all history by the value of one stub field
   * (`stage`, `repoId`), counted locally once the stubs are complete.
   */
  countBy(field: keyof IssueStub): ReadonlyMap<unknown, number> | typeof LOADING {
    return this.behind(() => {
      const loader = this.loader()
      if (loader === undefined || !this.stubsComplete) return LOADING
      this.stubs.reportObserved()
      const rows = loader.stubRows(ISSUE)
      let byField = this.tallies.get(rows)
      if (byField === undefined) {
        byField = new Map()
        this.tallies.set(rows, byField)
      }
      let tally = byField.get(field)
      if (tally === undefined) {
        const counts = new Map<unknown, number>()
        for (const row of rows) {
          const value = row.stub[field] ?? null
          counts.set(value, (counts.get(value) ?? 0) + 1)
        }
        tally = counts
        byField.set(field, tally)
      }
      return tally
    })
  }

  /**
   * TRACKED: how many issues over all history pass `test`, which reads only
   * stub fields (the issue's and, through `stubOf`, its ancestors'). LOADING
   * until the stubs are complete. `key` names the test for the tally memo:
   * one tally per stub table and key.
   */
  countStubs(
    key: string,
    test: (stub: IssueStub, stubOf: (id: string) => IssueStub | undefined) => boolean,
  ): number | typeof LOADING {
    return this.behind(() => {
      const loader = this.loader()
      if (loader === undefined || !this.stubsComplete) return LOADING
      this.stubs.reportObserved()
      const rows = loader.stubRows(ISSUE)
      let byKey = this.tallies.get(rows)
      if (byKey === undefined) {
        byKey = new Map()
        this.tallies.set(rows, byKey)
      }
      const memo = `test:${key}`
      let tally = byKey.get(memo)
      if (tally === undefined) {
        const stubOf = (id: string) => loader.stubOf(ISSUE, id) as IssueStub | undefined
        let count = 0
        for (const row of rows)
          if (test({ id: row.id, ...row.stub } as IssueStub, stubOf)) count += 1
        tally = new Map([[true, count]])
        byKey.set(memo, tally)
      }
      return tally.get(true) ?? 0
    })
  }

  /** TRACKED: a parent's children and how many are done, from the stubs, for all history. */
  childCounts(parentId: string): StubChildCounts | typeof LOADING {
    const loader = this.loader()
    if (loader === undefined || !this.coversTreeOf(parentId)) return LOADING
    return this.childCountReads.read(parentId)
  }

  /** TRACKED: every issue under `root` and how many are done, from the stubs. */
  treeProgress(root: string): StubTreeProgress | typeof LOADING {
    return this.behind(() => {
      const loader = this.loader()
      if (loader === undefined || !this.coversTreeOf(root)) return LOADING
      this.stubs.reportObserved()
      let total = 0
      let done = 0
      const todo = [...loader.stubsByParent(root)]
      const seen = new Set<string>([root])
      while (todo.length > 0) {
        const id = todo.pop()!
        if (seen.has(id)) continue
        seen.add(id)
        total += 1
        if (isFinished(loader.stubOf(ISSUE, id) ?? {})) done += 1
        todo.push(...loader.stubsByParent(id))
      }
      return { total, done }
    })
  }

  /**
   * TRACKED: whether the device holds every member under `id` WHOLE (main
   * part): the tree of its top-level ancestor, or of `id` itself, is
   * complete. Otherwise it asks for the top-level tree, at the front of the
   * queue, and answers false: a view that shows a tree (a flight deck) reads
   * its members as LOADING until then. No tree is preloaded (design "No tree
   * preloading"); a reader holds the tree while it reads it, and once no
   * reader does it is cache, kept while it fits. Without a loader it answers
   * false unless fullDevice explicitly vouches for a fixture.
   */
  treeHeld(id: string): boolean {
    return this.treeHolding(id) === 'held'
  }

  /** TRACKED: where `treeHeld`'s read stands (`Holding`): a refused tree is not asked again. */
  treeHolding(id: string): Holding {
    return this.behind(() => {
      const loader = this.loader()
      if (loader === undefined) return this.fullDeviceFixture && !this.disposed ? 'held' : 'loading'
      const own = this.complete(treeOf(id, 'main'))
      const root = own ? id : (this.topOf(id) ?? id)
      this.holdWhileRead(treeOf(root, 'main'))
      if (own || this.complete(treeOf(root, 'main'))) return 'held'
      if (loader.wasRefused(treeOf(root, 'main'))) return 'refused'
      this.ask(treeOf(root, 'main'))
      return 'loading'
    })
  }

  /**
   * TRACKED (POD-7582): whether the device holds every issue under `id`
   * WHOLE, as a child relation reads it (`issue.children`,
   * `issue.treeChildren`): the tree of `id` or of one of its ancestors is
   * complete, and the reader holds that tree (the widest complete one) while
   * it reads it. While an
   * open view holds such a tree that is still loading (a flight deck opening
   * on its root), the reader holds it too and waits, asking for nothing
   * more. Otherwise it holds and asks for the tree of `id` itself, never of
   * its top-level ancestor, so a leaf of a large epic downloads only its own
   * subtree. A flight deck that holds its root's tree answers every child
   * read under it from that one instance.
   */
  subtreeHeld(id: string): boolean {
    return this.subtreeHolding(id) === 'held'
  }

  /**
   * TRACKED: where `subtreeHeld`'s read stands (`Holding`). An ancestor's
   * tree the server refused is not waited on; the source's own refused tree
   * is not asked again.
   */
  subtreeHolding(id: string): Holding {
    return this.behind(() => {
      const loader = this.loader()
      if (loader === undefined) return this.fullDeviceFixture && !this.disposed ? 'held' : 'loading'
      const chain = this.chainOf(id)
      // The widest complete tree: once an ancestor's completes, the source's
      // own subtree is no longer held for this read.
      for (const at of [...chain].reverse()) {
        const tree = treeOf(at, 'main')
        if (!this.complete(tree)) continue
        this.holdWhileRead(tree)
        return 'held'
      }
      // An ancestor's: the source's own tree is asked for below, as every read asks.
      for (const at of chain.slice(1)) {
        const tree = treeOf(at, 'main')
        if (!this.heldByView(tree) || loader.wasRefused(tree)) continue
        this.holdWhileRead(tree)
        return 'loading'
      }
      const own = treeOf(id, 'main')
      this.holdWhileRead(own)
      if (loader.wasRefused(own)) return 'refused'
      this.ask(own)
      return 'loading'
    })
  }

  /** Whether an open view holds `spec` now: it asked for it, and it is on its way or here. */
  private heldByView(spec: LoaderInstance): boolean {
    const key = readKey(spec)
    // untracked-read: collections-tree-in-flight
    return sideStateUpkeep(() => this.reads.get(key)?.release !== undefined)
  }

  /** TRACKED: `id` and each ancestor the device holds a stub of, nearest first. */
  private chainOf(id: string): string[] {
    const loader = this.loader()
    if (loader === undefined) return [id]
    this.stubs.reportObserved()
    const chain = [id]
    const seen = new Set(chain)
    let at = id
    for (;;) {
      const parent = loader.stubOf(ISSUE, at)?.['parentId']
      if (typeof parent !== 'string' || parent === '' || seen.has(parent)) return chain
      seen.add(parent)
      chain.push(parent)
      at = parent
    }
  }

  /** TRACKED: what a reader reads of `spec`'s marker. */
  private observeMarker(spec: LoaderInstance): void {
    const key = readKey(spec)
    // untracked-read: collections-observe-marker
    sideStateUpkeep(() => {
      if (!this.markerSpecs.has(key)) {
        const { after: _position, ...instance } = spec
        this.markerSpecs.set(key, instance)
      }
      this.markerReads.read(key)
      // Read outside a view: nothing to tell later.
      if (!this.markerReads.tracks(key)) this.markerSpecs.delete(key)
    })
  }

  private markerOf(spec: LoaderInstance | undefined): MarkerSeen {
    const loader = this.loader()
    const marker = spec === undefined ? undefined : loader?.isComplete(spec)
    return {
      held: marker !== undefined,
      stale: spec !== undefined && (loader?.isStale?.(spec) ?? false),
      end: marker?.range?.end,
      through:
        marker?.range?.through === undefined ? undefined : JSON.stringify(marker.range.through),
      total: marker?.total,
      refused: spec !== undefined && (loader?.wasRefused(spec) ?? false),
    }
  }

  /**
   * The device store's markers or stubs moved. The views hear of it in the
   * next microtask, in one action: after the row source's publication of the
   * same burst, which it queued first. A view never reads a marker that
   * vouches for a record the pool does not show yet, which reads as "gone".
   */
  private moved(change: 'markers' | 'stubs'): void {
    if (this.pendingMoves === undefined) {
      this.pendingMoves = new SideSet('collections.pendingMoves')
      queueMicrotask(() => {
        const moves = this.pendingMoves
        this.pendingMoves = undefined
        if (moves === undefined || this.disposed) return
        runInAction(() => {
          if (moves.has('markers')) this.markersMoved()
          if (moves.has('stubs')) this.stubsMoved()
        })
      })
    }
    this.pendingMoves.add(change)
  }

  private pendingMoves: Set<'markers' | 'stubs'> | undefined

  /** The markers moved: tell the readers of each instance whose marker did, in one action. */
  private markersMoved(): void {
    runInAction(() => {
      this.markers.reportChanged()
      this.markerReads.moved()
      this.recordStaleReads.moved()
    })
  }

  /** The stubs moved: tell the readers of a whole-history question, and of each stub and child count that did. */
  private stubsMoved(): void {
    runInAction(() => {
      this.stubs.reportChanged()
      this.stubReads.moved()
      this.childCountReads.moved()
    })
  }

  /**
   * TRACKED: an open view reads `spec`; it is held while that view observes
   * it. Returns the read's key while a view observes it, else undefined.
   */
  private holdWhileRead(spec: LoaderInstance): string | undefined {
    const key = readKey(spec)
    // untracked-read: collections-hold-while-read
    return sideStateUpkeep(() => {
      if (!this.reads.has(key)) {
        const { after: _position, ...instance } = spec
        this.reads.set(key, { spec: instance })
      }
      if (!this.readDemand.observe(key) && !this.readDemand.has(key)) {
        this.reads.delete(key)
        return undefined
      }
      if (process.env.NODE_ENV !== 'production') this.bodyReadWarnings?.read(spec)
      return key
    })
  }

  /** TRACKED: an open view reads one record: its "one record" instance, held while observed. */
  private holdRecord(entity: LoaderEntity, id: string): LoaderInstance {
    const spec = oneRecordOf(entity, id)
    const key = this.holdWhileRead(spec)
    // untracked-read: collections-hold-record
    const read = key === undefined ? undefined : sideStateUpkeep(() => this.reads.get(key))
    if (read !== undefined && read.record === undefined) {
      read.record = { entity, id }
      this.heldRecords[entity].add(id)
    }
    return spec
  }

  private releaseRead(key: string): void {
    const read = this.reads.get(key)
    this.reads.delete(key)
    if (read?.record !== undefined) this.heldRecords[read.record.entity].delete(read.record.id)
    read?.release?.()
  }

  /** TRACKED: the top-level ancestor of `id` by the stubs, or undefined when the chain leaves them. */
  private topOf(id: string): string | undefined {
    return this.behind(() => {
      const loader = this.loader()
      if (loader === undefined) return undefined
      this.stubs.reportObserved()
      let at = id
      for (let guard = 0; guard < 10_000; guard += 1) {
        const stub = loader.stubOf(ISSUE, at)
        if (stub === undefined) return undefined
        const parent = stub['parentId']
        if (typeof parent !== 'string' || parent === '') return at
        at = parent
      }
      return undefined
    })
  }

  /**
   * TRACKED: whether the device holds every member under `id`: all stubs, or
   * the tree of its top-level ancestor at stub level or whole. A chain that
   * reaches an issue the device does not hold cannot say.
   */
  private coversTreeOf(id: string): boolean {
    if (this.stubsComplete) return true
    const loader = this.loader()
    if (loader === undefined) return false
    const at = this.topOf(id)
    if (at === undefined) return false
    return this.complete(treeOf(at, 'stub')) || this.complete(treeOf(at, 'main'))
  }

  dispose(): void {
    if (process.env.NODE_ENV !== 'production') this.bodyReadWarnings?.dispose()
    this.disposed = true
    for (const key of [...this.reads.keys()]) this.releaseRead(key)
    this.readDemand.clear()
    this.heldRecords.issue.clear()
    this.heldRecords.session.clear()
    this.markerReads.clear()
    this.recordStaleReads.clear()
    this.markerSpecs.clear()
    this.stubReads.clear()
    this.childCountReads.clear()
    this.off?.()
    this.off = undefined
    this.bound = undefined
  }
}
