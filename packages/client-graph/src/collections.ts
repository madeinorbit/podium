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

import { createAtom, type IAtom } from 'mobx'
import { LOADING } from './loading'
import { type Gone, NOT_VISIBLE } from './lookup'
import type { CollectionLoaderPort, LoaderInstance } from './shared/source'

/** The record kind of a pool entity whose records the loader fetches one by one. */
export const LOADER_KIND = { issue: 'issueProjection', session: 'session' } as const
export type LoaderEntity = keyof typeof LOADER_KIND

/** The issue stub's fields (`@podium/model` declaration): reference, state, parent. */
export interface IssueStub {
  readonly id: string
  readonly repoId?: string | null
  readonly seq?: number
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

/** How a view reads an instance or a lookup: here, on its way, or not loadable offline. */
export type Availability = 'complete' | 'loading' | 'offline'

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

export class PoolCollections {
  private readonly markers: IAtom
  private readonly stubs: IAtom
  private readonly connection: IAtom
  private bound: CollectionLoaderPort | undefined
  private off: (() => void) | undefined
  private disposed = false
  /** Per stub array the kernel hands out (its own memo): tallies already counted. */
  private readonly tallies = new WeakMap<object, Map<string, ReadonlyMap<unknown, number>>>()

  constructor(private source: () => CollectionLoaderPort | undefined) {
    this.markers = createAtom('pool.collections.markers')
    this.stubs = createAtom('pool.collections.stubs')
    this.connection = createAtom('pool.collections.connection')
  }

  /**
   * Read another device store's collections (a pool built from rows, such as
   * the startup check's states). Every reader hears of it.
   */
  attach(source: () => CollectionLoaderPort | undefined): void {
    this.source = source
    this.markers.reportChanged()
    this.stubs.reportChanged()
    this.connection.reportChanged()
  }

  /** The loader, subscribed once it exists. */
  private loader(): CollectionLoaderPort | undefined {
    if (this.disposed) return undefined
    const loader = this.source()
    if (loader !== this.bound) {
      this.off?.()
      this.bound = loader
      this.off = loader?.subscribe((change) => {
        if (change === 'markers') this.markers.reportChanged()
        else if (change === 'stubs') this.stubs.reportChanged()
        else this.connection.reportChanged()
      })
    }
    return loader
  }

  /** Whether this pool reads a device store with collections at all. */
  get available(): boolean {
    return this.loader() !== undefined
  }

  // ------------------------------------------------------------ instances

  /** TRACKED: whether the device holds the instance complete. */
  complete(spec: LoaderInstance): boolean {
    this.markers.reportObserved()
    return this.loader()?.isComplete(spec) !== undefined
  }

  /** TRACKED: here, on its way, or not loadable without a connection. */
  status(spec: LoaderInstance): Availability {
    this.markers.reportObserved()
    this.connection.reportObserved()
    return this.loader()?.status(spec) ?? 'complete'
  }

  /** TRACKED: whether the device has a connection to load over. */
  get online(): boolean {
    this.connection.reportObserved()
    return this.loader()?.online ?? true
  }

  /**
   * TRACKED: the device started empty and its first download is under way.
   * A reload after a gap is not one: its old rows stay on screen.
   */
  get firstDownload(): boolean {
    this.markers.reportObserved()
    return this.loader()?.firstDownload ?? false
  }

  /**
   * TRACKED: how a view reads a lookup that is on its way. Without a
   * connection a load cannot start: the view shows "not available offline"
   * (`offline`), never an endless loading row; it recovers by itself when the
   * connection returns and the record arrives.
   */
  reading(answer: unknown): 'here' | 'loading' | 'offline' | 'gone' {
    if (answer === LOADING) return this.online ? 'loading' : 'offline'
    if (typeof answer === 'object' && answer !== null && (answer as Gone).kind === 'gone')
      return 'gone'
    return 'here'
  }

  /** TRACKED: a paged instance's whole size for this viewer, from its first page. */
  pageTotal(spec: LoaderInstance): number | typeof LOADING {
    this.markers.reportObserved()
    return this.loader()?.isComplete(spec)?.total ?? LOADING
  }

  /** An open view holds an instance; it loads first. Returns the release (the instance becomes cache). */
  show(spec: LoaderInstance): () => void {
    return this.loader()?.show(spec) ?? (() => {})
  }

  /** Ask for instances without holding them (cache). */
  request(
    specs: readonly LoaderInstance[],
    priority: 'visible' | 'background' = 'background',
  ): void {
    this.loader()?.request(specs, priority)
  }

  /**
   * The records a request returned (server search hits): installed as "one
   * record" instances, cache. The view keeps the ids and reads each through
   * `pool.model`, so there is still one shared model per record.
   */
  adopt(entity: LoaderEntity, ids: readonly string[]): void {
    this.loader()?.requestRecords(LOADER_KIND[entity], ids)
  }

  // ------------------------------------------------------------ lookups

  /**
   * A record the device does not hold whole: LOADING and one batched load,
   * or gone once the server answered without it. Without a loader there is
   * nothing to ask: `undefined`, and the caller answers as it did before.
   */
  absent(entity: LoaderEntity, id: string): typeof LOADING | Gone | undefined {
    const loader = this.loader()
    if (loader === undefined) return undefined
    const spec = oneRecordOf(entity, id)
    this.markers.reportObserved()
    if (loader.isComplete(spec) !== undefined || loader.wasRefused(spec)) return NOT_VISIBLE
    loader.request([spec], 'visible')
    return LOADING
  }

  /** TRACKED: the issue's stub as the device holds it (a stub, or picked from the whole record). */
  stubOf(id: string): IssueStub | undefined {
    this.stubs.reportObserved()
    return this.loader()?.stubOf(ISSUE, id) as IssueStub | undefined
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
  }

  /** TRACKED: a parent's children and how many are done, from the stubs, for all history. */
  childCounts(parentId: string): StubChildCounts | typeof LOADING {
    const loader = this.loader()
    if (loader === undefined || !this.coversTreeOf(parentId)) return LOADING
    this.stubs.reportObserved()
    const children = loader.stubsByParent(parentId)
    let done = 0
    for (const id of children) if (loader.stubOf(ISSUE, id)?.['stage'] === 'done') done += 1
    return { childCount: children.length, childDoneCount: done }
  }

  /** TRACKED: every issue under `root` and how many are done, from the stubs. */
  treeProgress(root: string): StubTreeProgress | typeof LOADING {
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
      if (loader.stubOf(ISSUE, id)?.['stage'] === 'done') done += 1
      todo.push(...loader.stubsByParent(id))
    }
    return { total, done }
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
    this.stubs.reportObserved()
    let at = id
    for (let guard = 0; guard < 10_000; guard += 1) {
      const stub = loader.stubOf(ISSUE, at)
      if (stub === undefined) return false
      const parent = stub['parentId']
      if (typeof parent !== 'string' || parent === '') break
      at = parent
    }
    return this.complete(treeOf(at, 'stub')) || this.complete(treeOf(at, 'main'))
  }

  dispose(): void {
    this.disposed = true
    this.off?.()
    this.off = undefined
    this.bound = undefined
  }
}
