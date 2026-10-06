/**
 * POD-4446 — groups with one closed fold (spec R-GROUP; folds.ts).
 * Pinned moves out; rest buckets by repo in first-appearance order; each
 * group holds one closed fold (settled/abandoned/tucked/grace-aged,
 * newest-tucked-first). Touched groups rebuild from the order array.
 */

import type { SliceIssue } from '@podium/client-graph/shared/slice-types'
import { assertNever, nullStats, type Delta, type DerivationStats } from './deltas'
import { closedFoldAt, groupKeyOf, groupLabelOf, inClosedFold } from './rules'
import type { OrderModule } from './order'
import type { RollupModule } from './rollup'
import type { SummaryModule } from './summary'
import type { IssueTable } from './tables'

export type Lane = 'pinned' | 'open' | 'closed'

export interface GroupView {
  key: string
  label: string
  rowIds: string[]
  closedIds: string[]
}

export interface SelectionState {
  selectedIssueId: string | null
  selectedIssueWasFolded: boolean
}

export class GroupsModule {
  /** Pinned ids in R-ORDER (the PINNED section). */
  pinnedIds: string[] = []
  /** Groups in first-appearance order. */
  groups: GroupView[] = []
  /** Per-row placement (lane + group). */
  readonly placement = new Map<string, { groupKey: string; lane: Lane }>()
  /** Finished rows whose fold membership can move with the coarse clock. */
  readonly graceSensitive = new Set<string>()

  constructor(
    private readonly tables: { issues: IssueTable },
    private readonly summary: SummaryModule,
    private readonly rollup: RollupModule,
    private readonly order: OrderModule,
    private readonly getSelection: () => SelectionState,
    private readonly getNow: () => number,
    private readonly stats: DerivationStats = nullStats,
  ) {}

  /** Closed-fold membership for one row (baseline or latched selection). */
  closedOf(issueId: string): boolean {
    const issue = this.tables.issues.rows.get(issueId)
    if (issue === undefined) return false
    const aggregate = this.rollup.aggregates.get(issueId)
    const selection = this.getSelection()
    return inClosedFold({
      issue,
      waiting: aggregate && aggregate.asking ? 1 : 0,
      selectedIssueId: selection.selectedIssueId,
      selectedIssueWasFolded: selection.selectedIssueWasFolded,
      now: this.getNow(),
    })
  }

  private laneOf(issueId: string): { groupKey: string; lane: Lane } | null {
    const issue = this.tables.issues.rows.get(issueId)
    if (issue === undefined) return null
    if (issue.stage === 'done' || issue.closedReason != null) this.graceSensitive.add(issueId)
    else this.graceSensitive.delete(issueId)
    if (issue.pinned === true) return { groupKey: '', lane: 'pinned' }
    const summary = this.summary.summaries.get(issueId)
    const groupKey = summary?.repoKey ?? groupKeyOf(issue)
    return { groupKey, lane: this.closedOf(issueId) ? 'closed' : 'open' }
  }

  apply(batch: Delta[]): Delta[] {
    const out: Delta[] = []
    const dirty = new Set<string>()
    for (const delta of batch) {
      switch (delta.kind) {
        case 'VisibilityChanged':
        case 'SummaryChanged':
        case 'RollupChanged':
        case 'IssueChanged':
          dirty.add(delta.id)
          break
        case 'MembershipChanged':
          // Membership alone moves no lane (retained counts feed visibility,
          // which arrives as its own delta); waiting flows via RollupChanged.
          break
        case 'SelectionChanged':
          if (delta.previous !== null) dirty.add(delta.previous)
          if (delta.current !== null) dirty.add(delta.current)
          break
        case 'ClockChanged':
          // Grace-window crossings move settled rows into the fold.
          for (const id of this.graceSensitive) dirty.add(id)
          break
        case 'SessionChanged':
        case 'SessionRemoved':
        case 'IssueRemoved':
        case 'WorktreeChanged':
        case 'WorktreeRemoved':
        case 'ChildrenChanged':
        case 'OriginChanged':
        case 'OrderChanged':
        case 'GroupChanged':
        case 'RowChanged':
          break
        default:
          assertNever(delta)
      }
    }
    if (dirty.size === 0) return out
    // Placement for dirty rows; collect touched groups (old + new seats).
    const touched = new Set<string>()
    for (const id of dirty) {
      const prev = this.placement.get(id)
      if (!this.order.has(id)) {
        if (prev !== undefined) {
          this.placement.delete(id)
          if (prev.lane !== 'pinned') touched.add(prev.groupKey)
        }
        continue
      }
      const next = this.laneOf(id)
      if (next === null) continue
      if (
        prev === undefined ||
        prev.groupKey !== next.groupKey ||
        prev.lane !== next.lane
      ) {
        this.placement.set(id, next)
        if (prev !== undefined && prev.lane !== 'pinned') touched.add(prev.groupKey)
        if (next.lane !== 'pinned') touched.add(next.groupKey)
      }
    }
    if (touched.size === 0 && this.groups.length > 0) return out
    this.rebuild(touched, out)
    return out
  }

  /**
   * Rebuild group sequence (first appearance over the order array) and the
   * touched groups' lanes. One O(visible) pass per affecting batch; contents
   * are replaced only for touched groups. The pass is counted
   * (`groups-rebuild`): placing groups in rank order needs the global
   * sequence, so the scan is inherent to this design — the slope record says
   * how much it costs per event (M2 note).
   */
  private rebuild(touched: Set<string>, out: Delta[]): void {
    const issues = this.tables.issues.rows
    const pinned: string[] = []
    const buckets = new Map<string, { label: string; open: string[]; closed: string[] }>()
    for (const id of this.order.ordered) {
      const place = this.placement.get(id)
      if (place === undefined) continue
      if (place.lane === 'pinned') {
        pinned.push(id)
        continue
      }
      let bucket = buckets.get(place.groupKey)
      if (bucket === undefined) {
        const issue = issues.get(id) as SliceIssue
        bucket = { label: groupLabelOf(issue), open: [], closed: [] }
        buckets.set(place.groupKey, bucket)
      }
      if (place.lane === 'closed') bucket.closed.push(id)
      else bucket.open.push(id)
    }
    this.stats.scan('groups-rebuild', this.order.ordered.length)
    // Closed fold sorts newest-tucked-first (folds.ts:214-220), stable.
    for (const bucket of buckets.values()) {
      bucket.closed.sort((a, b) => {
        const ia = issues.get(a) as SliceIssue
        const ib = issues.get(b) as SliceIssue
        return closedFoldAt(ib) - closedFoldAt(ia)
      })
    }
    const pinnedMoved =
      pinned.length !== this.pinnedIds.length || pinned.some((id, i) => id !== this.pinnedIds[i])
    if (pinnedMoved) {
      this.pinnedIds = pinned
      out.push({ kind: 'GroupChanged', key: '' })
    }
    const next: GroupView[] = []
    const prevByKey = new Map(this.groups.map((g) => [g.key, g]))
    for (const [key, bucket] of buckets) {
      const prev = prevByKey.get(key)
      const isTouched = touched.has(key) || prev === undefined
      if (
        isTouched ||
        prev === undefined ||
        prev.label !== bucket.label ||
        !sameIds(prev.rowIds, bucket.open) ||
        !sameIds(prev.closedIds, bucket.closed)
      ) {
        next.push({ key, label: bucket.label, rowIds: bucket.open, closedIds: bucket.closed })
        if (isTouched || prev === undefined) out.push({ kind: 'GroupChanged', key })
      } else {
        next.push(prev)
      }
    }
    // Dropped groups (emptied) emit too — a header unmounts.
    for (const prev of this.groups) {
      if (!buckets.has(prev.key)) out.push({ kind: 'GroupChanged', key: prev.key })
    }
    this.groups = next
  }

  /** Full derive for replace/bootstrap (no deltas; store derives after). */
  rebuildAll(): void {
    this.pinnedIds = []
    this.groups = []
    this.placement.clear()
    const out: Delta[] = []
    for (const id of this.order.ordered) {
      const next = this.laneOf(id)
      if (next !== null) this.placement.set(id, next)
    }
    this.rebuild(new Set([...this.placement.values()].map((p) => p.groupKey)), out)
  }
}

function sameIds(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i += 1) if (a[i] !== b[i]) return false
  return true
}
