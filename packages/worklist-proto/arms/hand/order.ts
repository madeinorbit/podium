/**
 * POD-4446 — banded order over the visible set (spec R-ORDER; row-order.ts).
 * Sorted visible-id array by ranked insert/remove/move; only the changed
 * row's rank recomputes. Closed-fold rows keep R-ORDER position here.
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
  /** Membership mirror of `ordered` (H4 R-H1: `includes` per dirty row was an
   *  O(visible) scan hiding inside group placement). */
  private readonly members = new Set<string>()
  /** Last committed rank key per ordered row: a re-rank whose key did not
   *  move skips the position walk entirely (M2: burst50 paid ~1,100
   *  indexOf probes for activity-only summary changes that never sort). */
  private readonly ranks = new Map<string, RankKey>()

  constructor(
    private readonly tables: { issues: IssueTable },
    private readonly indexes: IndexSet,
    private readonly summary: SummaryModule,
    private readonly visible: VisibleModule,
    private readonly getNow: () => number,
    private readonly stats: DerivationStats = nullStats,
  ) {
    void this.indexes
  }

  /** O(1) membership for placement checks (replaces the order-array scan). */
  has(id: string): boolean {
    return this.members.has(id)
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
    this.members.add(id)
    this.ranks.set(id, key)
    return true
  }

  private remove(id: string): boolean {
    const at = this.indexOf(id)
    if (at < 0) return false
    this.ordered.splice(at, 1)
    this.members.delete(id)
    this.ranks.delete(id)
    return true
  }

  /** Position lookup with honest probe counting (H4 R-H1 slope material:
   *  re-ranking a moved row walks the array; the count says how far). */
  private indexOf(id: string): number {
    for (let i = 0; i < this.ordered.length; i += 1) {
      if (this.ordered[i] === id) {
        this.stats.scan('order-index', i + 1)
        return i
      }
    }
    this.stats.scan('order-index', this.ordered.length)
    return -1
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
          // No ClockChanged arm here on purpose: summary runs before order in
          // topology order, and every band flip it finds arrives as
          // SummaryChanged (M2: the old timeSensitive sweep re-ranked ~540
          // carriers per tick at 1x, each paying an O(visible) indexOf, even
          // when no rank moved).
          if (this.visible.isVisible(delta.id)) moves.add(delta.id)
          break
        case 'ClockChanged':
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
      const key = this.rankOf(id)
      if (key === null) continue
      // Rank inputs are exactly the key fields: an unchanged key cannot
      // have moved, so skip the position walk (no scan, no splice).
      if (sameRank(this.ranks.get(id), key)) continue
      const at = this.indexOf(id)
      if (at < 0) {
        changed = this.insert(id) || changed
        continue
      }
      this.ordered.splice(at, 1)
      const next = this.locate(key)
      this.ordered.splice(next, 0, id)
      this.ranks.set(id, key)
      if (next !== at) changed = true
    }
    if (changed) out.push({ kind: 'OrderChanged' })
    return out
  }

  /** Full derive for replace/bootstrap (no deltas; store derives after). */
  rebuildAll(): void {
    this.ordered.length = 0
    this.members.clear()
    this.ranks.clear()
    const keys = new Map<string, RankKey>()
    for (const id of this.visible.orderedIds()) {
      const key = this.rankOf(id)
      if (key !== null) keys.set(id, key)
    }
    const sorted = [...keys.keys()].sort((a, b) =>
      compareRank(keys.get(a) as RankKey, keys.get(b) as RankKey),
    )
    this.ordered.push(...sorted)
    for (const id of sorted) {
      this.members.add(id)
      const key = keys.get(id)
      if (key !== undefined) this.ranks.set(id, key)
    }
  }
}

/** Rank-key equality over exactly the fields compareRank reads. */
function sameRank(prev: RankKey | undefined, next: RankKey): boolean {
  return (
    prev !== undefined &&
    prev.band === next.band &&
    prev.sortKey === next.sortKey &&
    prev.createdAt === next.createdAt &&
    prev.seq === next.seq
  )
}
