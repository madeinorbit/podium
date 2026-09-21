/**
 * POD-4447 — the worklist level: visible ids, banded order, groups with one
 * closed fold (spec §3 R-ORDER, R-GROUP). Three computeds, each with equality
 * that keeps the old identity while values settle, so the list re-renders
 * only when order actually changes.
 *
 * `visibleIds` is the ONE allowed table enumeration (methodology §5.3): it
 * reads each issue's `visible`, and per-issue early-exits keep unrelated
 * changes from invalidating anything.
 */

import { computed, computedStruct, makeObservable } from 'mobx'
import type { SliceGroup, SliceOrder } from '../../shared/src/slice-types'
import { closedFoldAt, compareRank, groupLabelOf, type RankInput } from './rules'
import type { MobXStore } from './store'

function shallowIdsEqual(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((id, index) => id === b[index])
}

export type Lane = 'pinned' | 'open' | 'closed'

export class WorklistModel {
  constructor(private readonly store: MobXStore) {
    makeObservable<WorklistModel, 'store' | 'foldAt'>(this, {
      store: false,
      visibleIds: computed({ equals: shallowIdsEqual }),
      order: computed({ equals: shallowIdsEqual }),
      groups: computedStruct,
      foldAt: false,
      laneOf: false,
      snapshotOrder: false,
    })
  }

  /** Every visible issue id (spec §3 R-VIS). The ONE table enumeration. */
  get visibleIds(): readonly string[] {
    // The enumeration itself is O(issues) per body run (counted; the per-row
    // reads are cached, so only invalidated rows re-derive).
    this.store.scan('visible-enumeration', this.store.issues.size)
    const out: string[] = []
    for (const [id, model] of this.store.issues) {
      if (model.visible) out.push(id)
    }
    return out
  }

  /** Visible ids in R-ORDER (spec §3 R-ORDER). Closed-fold rows keep position. */
  get order(): readonly string[] {
    const ranked = new Map<string, RankInput>()
    for (const id of this.visibleIds) {
      const model = this.store.issues.get(id)
      if (model) ranked.set(id, model.rankKey)
    }
    this.store.scan('order-sort', ranked.size)
    return [...this.visibleIds].sort((a, b) =>
      compareRank(ranked.get(a) as RankInput, ranked.get(b) as RankInput),
    )
  }

  /** Pinned section plus per-group open lanes and the closed fold (spec §3 R-GROUP). */
  get groups(): { pinnedIds: string[]; groups: SliceGroup[] } {
    const pinnedIds: string[] = []
    const buckets = new Map<string, { label: string; open: string[]; closed: string[] }>()
    const order = this.order
    this.store.scan('groups-bucket', order.length)
    for (const id of order) {
      const model = this.store.issues.get(id)
      if (!model) continue
      if (model.value.pinned === true) {
        pinnedIds.push(id)
        continue
      }
      const key = model.summary?.repoKey ?? model.value.repoId ?? model.value.repoPath
      let bucket = buckets.get(key)
      if (!bucket) {
        bucket = { label: groupLabelOf(model.value), open: [], closed: [] }
        buckets.set(key, bucket)
      }
      if (model.closed) bucket.closed.push(id)
      else bucket.open.push(id)
    }
    const groups: SliceGroup[] = []
    for (const [key, bucket] of buckets) {
      // Newest tucked (or finished) first; stable for ties (spec §3 R-GROUP).
      const closedIds = bucket.closed
        .map((id, index) => ({ id, index, at: this.foldAt(id) }))
        .sort((a, b) => b.at - a.at || a.index - b.index)
        .map((entry) => entry.id)
      groups.push({ key, label: bucket.label, rowIds: [...bucket.open], closedIds })
    }
    return { pinnedIds, groups }
  }

  private foldAt(id: string): number {
    const issue = this.store.issues.get(id)?.value
    return issue ? closedFoldAt(issue) : 0
  }

  /** Placement lane of one row: pinned, open, or closed (spec §3 R-GROUP). */
  laneOf(id: string): Lane | null {
    const model = this.store.issues.get(id)
    if (!model || !model.visible) return null
    if (model.value.pinned === true) return 'pinned'
    return model.closed ? 'closed' : 'open'
  }

  /** The ordered snapshot slice (spec §7). */
  snapshotOrder(): SliceOrder {
    const { pinnedIds, groups } = this.groups
    return {
      pinnedIds: [...pinnedIds],
      groups: groups.map((group) => ({
        key: group.key,
        label: group.label,
        rowIds: [...group.rowIds],
        closedIds: [...group.closedIds],
      })),
    }
  }
}
