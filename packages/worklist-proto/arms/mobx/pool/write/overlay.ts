/**
 * POD-4743 — the write layer's pending display, as the seam the pool's one
 * reader calls (`RowOverlay`, `MobxPool.row`).
 *
 * The write arm creates it, passes it to the pool at construction and to the
 * write api (`createMobxWriteApi`), which mirrors the pending log into it
 * inside its actions. The pool only reads it: every row it serves is the
 * server row with this entry laid over it, so models, row views, visibility
 * nodes and roll-ups see one value, and no reader is replaced at runtime.
 *
 * One observable map entry per issue with a pending display: the newest
 * pending value per editable field (title, stage, readAt), never a row copy
 * (the pool's tables hold the borrowed server rows). Reading an absent key is
 * tracked too, so a node built before the first edit follows it.
 */

import { type ObservableMap, observable } from 'mobx'
import type { EntityName } from '../../../../shared/src/schema'
import type { RowOverlay } from '../pool'

/** The editable fields of an issue row, as the overlay holds them. */
export type IssueOverlay = { title?: string; stage?: string; readAt?: string | null }

export class PendingOverlay implements RowOverlay {
  private readonly entries: ObservableMap<string, IssueOverlay> = observable.map<
    string,
    IssueOverlay
  >(undefined, { deep: false, name: 'write.overlays' })

  /** TRACKED: the pending display of `entity:id`. Only issues carry editable fields. */
  pending(entity: EntityName, id: string): IssueOverlay | undefined {
    if (entity !== 'issue') return undefined
    return this.entries.get(id)
  }

  /** Mirror the log's display for issue `id` (inside the write layer's action). */
  set(id: string, display: IssueOverlay): void {
    this.entries.set(id, display)
  }

  /** Drop issue `id`'s display; whether there was one (inside the write layer's action). */
  delete(id: string): boolean {
    if (!this.entries.has(id)) return false
    this.entries.delete(id)
    return true
  }

  /** Drop every display: the pool shows server truth again (the write layer's dispose). */
  clear(): void {
    this.entries.clear()
  }
}
