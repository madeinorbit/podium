/**
 * POD-4446 — banded order over the visible set (spec R-ORDER).
 *
 * A sorted array of visible ids, maintained by ranked insert/remove/move —
 * only the changed row's rank is recomputed, never the whole list. Rank is
 * band, manual sortKey (keyed before unkeyed, siblings only), creation desc,
 * seq desc, id; activity never sorts (row-order.ts:60-64). Closed-fold rows
 * keep their R-ORDER position here (the fold sorts by tuck time in groups).
 */

import { assertNever, nullStats, type Delta, type DerivationStats } from './deltas'
import type { IndexSet } from './indexes'
import { compareRank } from './rules'
import type { SummaryModule } from './summary'
import type { IssueTable } from './tables'
import type { VisibleModule } from './visible'

interface RankKey {
  band: number
  sortKey: string | null
  createdAt: string
  seq: number
  id: string
}

export class OrderModule {
  /** Visible ids in R-ORDER (closed-fold rows included, in position). */
  readonly ordered: string[] = []

  constructor(
    private readonly tables: { issues: IssueTable },
    private readonly indexes: IndexSet,
    private readonly summary: SummaryModule,
    private readonly visible: VisibleModule,
    private readonly getNow: () => number,
    private readonly stats: DerivationStats = nullStats,
  ) {
    void this.indexes
    void this.stats
  }

  private rankOf(id: string): RankKey | null {
    const issue = this.tables.issues.rows.get(id)
    if (issue === undefined) return null
    const summary = this.summary.summaries.get(id)
    return {
      band: summary?.band ?? 1,
      sortKey: issue.sortKey ?? null,
      createdAt: issue.createdAt,
      seq: issue.seq,
      id,
    }
  }

  private locate(key: RankKey): number {
    let lo = 0
    let hi = this.ordered.length
    while (lo < hi) {
      const mid = (lo + hi) >> 1
      const at = this.rankOf(this.ordered[mid] as string) as RankKey
      if (compareRank(at, key) < 0) lo = mid + 1
      else hi = mid
    }
    return lo
  }

  private insert(id: string): boolean {
    const key = this.rankOf(id)
    if (key === null) return false
    const at = this.locate(key)
    this.ordered.splice(at, 0, id)
    return true
  }

  private remove(id: string): boolean {
    const at = this.ordered.indexOf(id)
    if (at < 0) return false
    this.ordered.splice(at, 1)
    return true
  }

  apply(batch: Delta[]): Delta[] {
    const out: Delta[] = []
    let changed = false
    const moves = new Set<string>()
    for (const delta of batch) {
      switch (delta.kind) {
        case 'VisibilityChanged':
          if (delta.visible) changed = this.insert(delta.id) || changed
          else changed = this.remove(delta.id) || changed
          break
        case 'SummaryChanged':
        case 'IssueChanged':
          // Rank reads band (summary) + pinned/sortKey (issue). Re-rank when
          // visible; the locate-compare makes a no-move free of deltas.
          if (this.visible.isVisible(delta.id)) moves.add(delta.id)
          break
        case 'ClockChanged':
          // Bands of deferUntil carriers may have flipped (summary level
          // already recomputed them); re-rank the time-sensitive rows.
          for (const id of this.summary.timeSensitive) {
            if (this.visible.isVisible(id)) moves.add(id)
          }
          break
        case 'MembershipChanged':
        case 'SessionChanged':
        case 'SessionRemoved':
        case 'IssueRemoved':
        case 'WorktreeChanged':
        case 'WorktreeRemoved':
        case 'ChildrenChanged':
        case 'OriginChanged':
        case 'RollupChanged':
        case 'OrderChanged':
        case 'GroupChanged':
        case 'RowChanged':
        case 'SelectionChanged':
          break
        default:
          assertNever(delta)
      }
    }
    for (const id of moves) {
      const at = this.ordered.indexOf(id)
      if (at < 0) {
        changed = this.insert(id) || changed
        continue
      }
      const key = this.rankOf(id)
      if (key === null) continue
      this.ordered.splice(at, 1)
      const next = this.locate(key)
      this.ordered.splice(next, 0, id)
      if (next !== at) changed = true
    }
    if (changed) out.push({ kind: 'OrderChanged' })
    return out
  }

  /** Full derive for replace/bootstrap (no deltas; store derives after). */
  rebuildAll(): void {
    this.ordered.length = 0
    const keys = new Map<string, RankKey>()
    for (const id of this.visible.orderedIds()) {
      const key = this.rankOf(id)
      if (key !== null) keys.set(id, key)
    }
    const sorted = [...keys.keys()].sort((a, b) =>
      compareRank(keys.get(a) as RankKey, keys.get(b) as RankKey),
    )
    this.ordered.push(...sorted)
  }
}
