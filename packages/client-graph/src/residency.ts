/**
 * Where a row the pool does not hold stands (POD-4567, POD-7087, POD-7094).
 *
 * EVERY ROW ON THE DEVICE IS IN THE POOL. History is not on the device
 * (POD-7059): what the device holds is bounded by the server's policy, the
 * views' collections and the cache cap, so the pool places every row its feed
 * carries. There is no residency rule any more (the active-work rule and the
 * cold index it read are deleted, POD-7094), no cold row and no declared
 * summary of one.
 *
 * A ROW NOT IN THE POOL is one of three answers (frontend-data rule 7):
 * - REMOVED, when the replica's exit evidence says so;
 * - UNLOADED (POD-7159, design POD-7157 "Layer 2"): the record left memory
 *   and stays on the device's disk. Its reader gets LOADING and a disk load,
 *   never REMOVED or NOT_VISIBLE, whatever the entity, offline too;
 * - on its way (`LOADING`): a record the pool does not hold is asked for
 *   through the one loader (`absent`, `collections.ts`, `@podium/sync`
 *   `CollectionLoader`), which fetches its "one record" instance in a 50 ms
 *   batch. Nothing is read through the feed for it: the feed publishes every
 *   row the device holds to the pool, and a row it is about to publish fills
 *   its table slot, which the reader observes;
 * - NOT_VISIBLE, once the loader answered without it, for an entity no
 *   lookup can load, or without a loader.
 * An issue's reference, state and parent are read from its stub
 * (`MobxPool.stub`), which never fetches.
 *
 * REFERENCES. A typed reference (`POD-12`) that names no held issue is
 * resolved against the device's identities in a short window of its own
 * (`requestReference`), so a burst of references costs one action.
 */

import { SideSet } from '@podium/sync/side-state'
import { LOADING } from './loading'
import { type Gone, NOT_VISIBLE, REMOVED } from './lookup'
import type { EntityName, ModelSchema } from './shared/schema'

/** The kinds the feed can read by id (`RowSource.row`). */
export type LoadableEntity = 'issue' | 'session'

/** The feed's per-row read: the row's current value, or undefined when it is gone. */
export type LoadRow = (entity: LoadableEntity, id: string) => object | undefined

/** Arms a timer; returns its cancel. Tests pass a manual one. */
export type Schedule = (run: () => void, ms: number) => () => void

/** The batch window: references asked within it resolve in one action. */
export const LOAD_WINDOW_MS = 50

export interface ResidencyOptions {
  readonly schema: ModelSchema
  /** The pool's tables, read side. */
  readonly hot: { readonly [E in EntityName]: { has(id: string): boolean } }
  /**
   * POD-7087 — a record the device does not hold whole: the one loader asks
   * the server for it (its "one record" instance) and answers LOADING, or
   * gone once the server answered without it. `undefined` when there is no
   * loader.
   */
  readonly absent?: (entity: LoadableEntity, id: string) => typeof LOADING | Gone | undefined
  /** Borrow canonical replica exits; never copy its tombstone ledger. */
  readonly exitKind?: (entity: EntityName, id: string) => 'removed' | 'evicted' | undefined
  /** POD-7159 — the record is whole on the device's disk and not in memory. */
  readonly unloaded?: (entity: EntityName, id: string) => boolean
  /** POD-7159 — read an unloaded record from disk (batched by the loader). */
  readonly reload?: (entity: EntityName, id: string) => void
  readonly windowMs?: number
  readonly schedule?: Schedule
}

const realSchedule: Schedule = (run, ms) => {
  const timer = setTimeout(run, ms)
  return () => clearTimeout(timer)
}

export class Residency {
  readonly windowMs: number
  private readonly schema: ModelSchema
  private readonly hot: ResidencyOptions['hot']
  private readonly absent: ResidencyOptions['absent']
  private readonly exitKind: ResidencyOptions['exitKind']
  private readonly unloadedRow: ResidencyOptions['unloaded']
  private readonly reload: ResidencyOptions['reload']
  private readonly schedule: Schedule
  private readonly referenceQueue = new SideSet<string>('residency.referenceQueue')
  private cancel: (() => void) | null = null
  /** Runs a closed window's batch (the pool's action). */
  private due: () => void = () => {}

  constructor(options: ResidencyOptions) {
    this.schema = options.schema
    this.hot = options.hot
    this.absent = options.absent
    this.exitKind = options.exitKind
    this.unloadedRow = options.unloaded
    this.reload = options.reload
    this.windowMs = options.windowMs ?? LOAD_WINDOW_MS
    this.schedule = options.schedule ?? realSchedule
  }

  /** The pool's batch runner, called when a window closes. */
  onDue(run: () => void): void {
    this.due = run
  }

  /** Whether a lookup can load a row of `entity` that the pool does not hold. */
  loadable(entity: EntityName): entity is LoadableEntity {
    return (
      this.schema[entity].loadable !== undefined && (entity === 'issue' || entity === 'session')
    )
  }

  /**
   * TRACKED (through the loader's markers and the table slot the caller
   * read): whether the row the pool does not hold is on its way. Asking
   * starts its load: the "first access" of a derivation that reaches an
   * absent row through a lazy relation.
   */
  loading(entity: EntityName, id: string): boolean {
    if (this.hot[entity].has(id)) return false
    if (this.unloaded(entity, id)) return this.lookup(entity, id) === LOADING
    return this.loadable(entity) && this.lookup(entity, id) === LOADING
  }

  /**
   * A row the pool does not hold: removed, on its way, or not visible.
   * `request: false` (maintenance inside an action) starts nothing and
   * answers NOT_VISIBLE for a record the device does not hold.
   */
  lookup(entity: EntityName, id: string, request = true): typeof LOADING | Gone {
    if (this.removed(entity, id)) return REMOVED
    // On the device's disk: on its way, and read from there (never "gone").
    if (this.unloaded(entity, id)) {
      if (request) this.reload?.(entity, id)
      return LOADING
    }
    if (!this.loadable(entity) || !request) return NOT_VISIBLE
    return this.absent?.(entity, id) ?? NOT_VISIBLE
  }

  removed(entity: EntityName, id: string): boolean {
    return this.exitKind?.(entity, id) === 'removed'
  }

  /** POD-7159 — the row left memory and stays on the device (`unloaded`, not removed). */
  unloaded(entity: EntityName, id: string): boolean {
    return this.unloadedRow?.(entity, id) === true
  }

  /** Why a row is not in the pool, when the device knows: removed, or unloaded to disk. */
  exit(entity: EntityName, id: string): 'removed' | 'unloaded' | undefined {
    if (this.removed(entity, id)) return 'removed'
    if (this.unloaded(entity, id)) return 'unloaded'
    return undefined
  }

  /** Unknown reference identities share one short window; no transport batch. */
  requestReference(ref: string): boolean {
    if (this.referenceQueue.has(ref)) return false
    this.referenceQueue.add(ref)
    if (this.cancel === null) {
      this.cancel = this.schedule(() => {
        this.cancel = null
        this.due()
      }, this.windowMs)
    }
    return true
  }

  /** Close the window now: the queued references, cleared. */
  takeReferences(): string[] {
    this.cancel?.()
    this.cancel = null
    const batch = [...this.referenceQueue]
    this.referenceQueue.clear()
    return batch
  }

  /** Forget everything (the pool's dispose). */
  clear(): void {
    this.referenceQueue.clear()
    this.cancel?.()
    this.cancel = null
  }
}
