/**
 * POD-4570 (Mb2) — the worklist's groups and closed folds, over the ordered
 * visible ids (`visible.ts`).
 *
 * THE RULE IS THE SPEC'S. R-GROUP (`docs/plans/pod-4441-round-two-slice.md`
 * §3): pinned rows move out into one flat PINNED section; the rest bucket by
 * `repoKey` (`repoId ?? repoPath`) in the rank order of each group's first
 * member, open or closed (`groupUnifiedWorkRows`, `folds.ts:185-222`), labelled
 * by that first member's path tail (`folds.ts:200-203`); each group has ONE
 * closed fold, newest `foldAt` first, ties in rank order (`folds.ts:214-220`,
 * L1b `compareClosedFold`). The fold verdict is views.ts `closedOf` (the one
 * the row's `closed` field uses), so a row and its lane cannot disagree.
 *
 * WHAT A ROW CONTRIBUTES is its `placement` (`placementPartOf`): the pinned
 * flag, the group key and label, the fold verdict and the fold stamp. It is a
 * `computedStruct` on the row's `IssueNode`, read from the own row hot OR cold
 * (a closed issue is cold, and 376 of 732 visible rows are cold at 1x), so a
 * row is placed without being loaded. A change that leaves the placement
 * equal (a rename, a phase change, a heartbeat) stops at the node.
 *
 * THE LAYOUT IS MAINTAINED, NOT RE-ENUMERATED (POD-4686). One reaction per
 * node (`pool.layout.<id>`, filed in `VisibleCollection.sync`) files its
 * placement into the buckets below when it changes, like the visible set
 * itself: a stage move files one id between two lanes, and the counters
 * (`counters.groupRuns`, `counters.groupElements`) count the filed id and the
 * lanes it re-sorts — never the visible count. The old view-time layout
 * (`layoutOf` over the whole visible order, still the pure function the
 * rebuild and the scaling plant use) re-ran over every visible row per stage
 * move (732 elements at 1x, 2,928 at 4x) and failed the excess-slope budget.
 *
 * THE LANES SORT AT VIEW TIME, PER GROUP (audit §7: Linear sorts a collection
 * when a view reads it). Each lane is a shallow-compared computed over its
 * own bucket's set and its members' ranks: a filing re-sorts only its own
 * group's lanes, so a lane change redraws only its own header. The group
 * keys sort each bucket's head rank (one computed per group over its own
 * lanes), so a move inside a bucket re-validates O(lane) plus O(groups) —
 * never O(visible) — and usually re-runs nothing outside its bucket at all.
 * The latch re-inserts a selected row at its rank by comparing ranks, never
 * through a whole-order index.
 *
 * THE SNAPSHOT'S LAYOUT HAS NO SELECTION (spec §7: the oracle projects the
 * unselected baseline). The UI's lanes add the R-GROUP 5 latch
 * (`latchedOpenId`): a selected row the grace window folded stays in the open
 * lane until focus moves, unless the fold was a dismissal (abandoned or
 * tucked) or the row was folded when clicked (`selectedIssueWasFolded`). The
 * latch is one computed, so a click on any other row re-runs nothing here.
 */

import {
  compareShallow,
  computed,
  makeObservable,
  type ObservableMap,
  type ObservableSet,
  observable,
} from 'mobx'
import { compareRank, type RowRank } from '../../../../shared/src/row-view'
import type { SliceGroup, SliceIssue, SliceOrder } from '../../../../shared/src/slice-types'
import { closedOf, foldAtOf, issueAbandoned } from '../views'
import type { IssueNode, VisibleCounters, VisibleInputs } from './visible'

/** Where one visible row goes (R-GROUP), before selection. */
export interface Placement {
  /** R-GROUP 1: pinned rows move to the PINNED section, whatever their fold verdict. */
  readonly pinned: boolean
  /** R-GROUP 2: `repoId ?? repoPath`. */
  readonly repoKey: string
  /** The group label this row would give its group as first member (`folds.ts:200-203`). */
  readonly label: string
  /** R-GROUP 3, no selection: the row's `closed` field (views.ts `closedOf`). */
  readonly closed: boolean
  /** Folded by the operator's own terminal choice (abandoned or tucked): the latch never holds it open. */
  readonly dismissed: boolean
  /** `Date.parse(tuckedAt ?? closedAt ?? updatedAt)`: the fold sorts newest first. */
  readonly foldMs: number
}

/** The group label of a repo path: its last segment (`folds.ts:203`). */
export function repoLabelOf(repoPath: string): string {
  return repoPath.split('/').pop() || repoPath
}

/**
 * One row's placement from its own row, hot or cold, and the clock (the grace
 * deadline), with "nothing in the subtree waits" ASSUMED: the node applies
 * the waiting roll-up (Mb3) only to a row this places in the fold
 * (`withWaiting`), so a row that could never fold never reads its subtree.
 */
export function placementOf(issue: SliceIssue, input: Pick<VisibleInputs, 'passed'>): Placement {
  const closed = closedOf(issue, false, input)
  return {
    pinned: issue.pinned === true,
    repoKey: issue.repoId ?? issue.repoPath,
    label: repoLabelOf(issue.repoPath),
    closed,
    dismissed: closed && (issueAbandoned(issue) || issue.tuckedAt != null),
    foldMs: Date.parse(foldAtOf(issue)) || 0,
  }
}

/** A fold candidate whose subtree waits on the human stays open (R-GROUP 3, `folds.ts:95-100`). */
export function withWaiting(placement: Placement): Placement {
  return { ...placement, closed: false, dismissed: false }
}

export function placementPartOf(input: VisibleInputs, id: string): Placement | undefined {
  const issue = input.issueRow(id)
  return issue === undefined ? undefined : placementOf(issue, input)
}

/** One group of the layout: label, open lane and closed fold, each in its spec order. */
export interface LayoutGroup {
  readonly key: string
  readonly label: string
  readonly rowIds: readonly string[]
  readonly closedIds: readonly string[]
}

/** The grouped list without selection: the snapshot's `order`. */
export interface Layout {
  readonly pinnedIds: readonly string[]
  readonly groups: readonly LayoutGroup[]
  /** The same groups by key (a group node finds its own without a scan). */
  readonly byKey: ReadonlyMap<string, LayoutGroup>
  /** Each placed id's position in `order` (the latch re-inserts a row at its rank). */
  readonly rankIndex: ReadonlyMap<string, number>
}

/**
 * The grouping itself, over ids in rank order and each one's placement. The
 * rebuild and the tests call it; the live pool files incrementally instead
 * (`WorklistGroups.file`), and the scaling plant calls this to show what a
 * whole-list layout costs. The maintained buckets hold the same result: same
 * pinned order, same group order (first-member rank order; ranks are total,
 * L1b `compareRank`), same lanes (open in rank order, closed newest first
 * with ties in rank order).
 */
export function layoutOf(
  order: readonly string[],
  placementOfId: (id: string) => Placement | undefined,
): Layout {
  const pinnedIds: string[] = []
  const byKey = new Map<string, { label: string; open: string[]; closed: [string, number][] }>()
  const rankIndex = new Map<string, number>()
  order.forEach((id, index) => {
    const placement = placementOfId(id)
    if (placement === undefined) return
    rankIndex.set(id, index)
    if (placement.pinned) {
      pinnedIds.push(id)
      return
    }
    let bucket = byKey.get(placement.repoKey)
    if (bucket === undefined) {
      bucket = { label: placement.label, open: [], closed: [] }
      byKey.set(placement.repoKey, bucket)
    }
    if (placement.closed) bucket.closed.push([id, placement.foldMs])
    else bucket.open.push(id)
  })
  const groups: LayoutGroup[] = []
  const groupsByKey = new Map<string, LayoutGroup>()
  for (const [key, bucket] of byKey) {
    const group: LayoutGroup = {
      key,
      label: bucket.label,
      rowIds: bucket.open,
      // Stable: ties keep rank order (L1b `compareClosedFold`).
      closedIds: bucket.closed.sort((a, b) => b[1] - a[1]).map(([id]) => id),
    }
    groups.push(group)
    groupsByKey.set(key, group)
  }
  return { pinnedIds, groups, byKey: groupsByKey, rankIndex }
}

/** The layout as the frozen `SliceOrder` (copies: the snapshot must not alias live arrays). */
export function sliceOrderOf(layout: Layout): SliceOrder {
  return {
    pinnedIds: [...layout.pinnedIds],
    groups: layout.groups.map(
      (group): SliceGroup => ({
        key: group.key,
        label: group.label,
        rowIds: [...group.rowIds],
        closedIds: [...group.closedIds],
      }),
    ),
  }
}

/** What the groups read from the pool. */
export interface GroupsHost {
  /** The visible ids in rank order (`VisibleCollection.order`). */
  order(): readonly string[]
  /** A known issue's node. */
  node(id: string): IssueNode | undefined
  /** TRACKED: the selected issue id, or null. */
  selectedId(): string | null
  /** TRACKED: `SliceLocals.selectedIssueWasFolded`. */
  foldLatch(): boolean
  readonly counters: VisibleCounters
}

const EMPTY: readonly string[] = Object.freeze([]) as readonly string[]

/** Two placements file the same row the same way. */
function placementEqual(a: Placement, b: Placement): boolean {
  return (
    a.pinned === b.pinned &&
    a.repoKey === b.repoKey &&
    a.label === b.label &&
    a.closed === b.closed &&
    a.dismissed === b.dismissed &&
    a.foldMs === b.foldMs
  )
}

/** One group's filed members, unordered: the lanes sort them at view time. */
export interface Bucket {
  readonly open: ObservableSet<string>
  readonly closed: ObservableSet<string>
}

/** The lane a placement files into (pinned rows file into the pinned set, not a bucket). */
function laneOf(placement: Placement): 'open' | 'closed' {
  return placement.closed ? 'closed' : 'open'
}

/** Ids with a rank, in L1b rank order (unranked ids are transient and stay out, as in `order`). */
function rankSorted(
  ids: Iterable<string>,
  rankOfId: (id: string) => RowRank | undefined,
): string[] {
  const ranked: { id: string; rank: RowRank }[] = []
  for (const id of ids) {
    const rank = rankOfId(id)
    if (rank !== undefined) ranked.push({ id, rank })
  }
  ranked.sort((a, b) => compareRank(a.rank, b.rank))
  return ranked.map(({ id }) => id)
}

/** A fold: newest `foldMs` first, ties in rank order (L1b `compareClosedFold`). */
function sortClosedFold(
  ids: Iterable<string>,
  rankOfId: (id: string) => RowRank | undefined,
  foldMsOfId: (id: string) => number,
): string[] {
  const ranked: { id: string; rank: RowRank; foldMs: number }[] = []
  for (const id of ids) {
    const rank = rankOfId(id)
    if (rank === undefined) continue
    ranked.push({ id, rank, foldMs: foldMsOfId(id) })
  }
  ranked.sort((a, b) => b.foldMs - a.foldMs || compareRank(a.rank, b.rank))
  return ranked.map(({ id }) => id)
}

/** One group's lanes as the UI draws them (the latch applied), each list shallow-compared. */
export class GroupNode {
  constructor(
    readonly key: string,
    private readonly groups: WorklistGroups,
  ) {
    makeObservable<GroupNode, 'groups' | 'bucket'>(this, {
      key: false,
      groups: false,
      bucket: computed,
      label: computed,
      headRank: computed,
      baseRowIds: computed({ equals: compareShallow }),
      baseClosedIds: computed({ equals: compareShallow }),
      rowIds: computed({ equals: compareShallow }),
      closedIds: computed({ equals: compareShallow }),
    })
  }

  /** The filed bucket, or undefined once its last member files out. */
  private get bucket(): Bucket | undefined {
    return this.groups.bucket(this.key)
  }

  /** The rank-first member's rank, or undefined when no member has one. */
  get headRank(): RowRank | undefined {
    const bucket = this.bucket
    if (bucket === undefined) return undefined
    let best: RowRank | null = null
    for (const lane of [bucket.open, bucket.closed] as const) {
      for (const id of lane) {
        const rank = this.groups.rankOf(id)
        if (rank === undefined) continue
        if (best === null || compareRank(rank, best) < 0) best = rank
      }
    }
    return best ?? undefined
  }

  /** The rank-first member's label (`folds.ts:200-203`). */
  get label(): string {
    const bucket = this.bucket
    if (bucket === undefined) return ''
    let bestRank: RowRank | null = null
    let bestLabel = ''
    for (const lane of [bucket.open, bucket.closed] as const) {
      for (const id of lane) {
        const rank = this.groups.rankOf(id)
        if (rank === undefined) continue
        const memberLabel = this.groups.filedLabel(id)
        if (memberLabel === undefined) continue
        if (bestRank === null || compareRank(rank, bestRank) < 0) {
          bestRank = rank
          bestLabel = memberLabel
        }
      }
    }
    return bestLabel
  }

  /** The open lane, in rank order, no selection (the snapshot's lane). */
  get baseRowIds(): readonly string[] {
    const bucket = this.bucket
    if (bucket === undefined) return EMPTY
    return rankSorted(bucket.open, (id) => this.groups.rankOf(id))
  }

  /** The closed fold, newest first, no selection (the snapshot's lane). */
  get baseClosedIds(): readonly string[] {
    const bucket = this.bucket
    if (bucket === undefined) return EMPTY
    return sortClosedFold(
      bucket.closed,
      (id) => this.groups.rankOf(id),
      (id) => this.groups.filedFoldMs(id),
    )
  }

  /** The open lane, in rank order, plus a latched selected row at its rank. */
  get rowIds(): readonly string[] {
    const bucket = this.bucket
    if (bucket === undefined) return EMPTY
    const lane = this.baseRowIds
    const latched = this.groups.latchedOpenId
    if (latched === null || !bucket.closed.has(latched)) return lane
    const latchedRank = this.groups.rankOf(latched)
    if (latchedRank === undefined) return lane
    const index = lane.findIndex((id) => {
      const rank = this.groups.rankOf(id)
      return rank !== undefined && compareRank(rank, latchedRank) > 0
    })
    const open = [...lane]
    open.splice(index === -1 ? open.length : index, 0, latched)
    return open
  }

  /** The closed fold, newest first, less a latched selected row. */
  get closedIds(): readonly string[] {
    const bucket = this.bucket
    if (bucket === undefined) return EMPTY
    const lane = this.baseClosedIds
    const latched = this.groups.latchedOpenId
    if (latched === null || !lane.includes(latched)) return lane
    return lane.filter((id) => id !== latched)
  }
}

/**
 * The groups over the visible order: the filed buckets (snapshot, no
 * selection), the group keys and pinned ids the list reads, one `GroupNode`
 * per key for the headers and lanes, and the latch.
 */
export class WorklistGroups {
  /** Group nodes by key, built on first access (an identity memo, like the pool's models). */
  private readonly nodes = new Map<string, GroupNode>()
  /** The last filed placement per visible id (plain: lanes subscribe through the sets below). */
  private readonly filed = new Map<string, Placement>()
  /** The filed buckets by key, stable while non-empty. */
  private readonly buckets: ObservableMap<string, Bucket>
  /** The filed pinned ids, unordered: `pinnedIds` sorts them at view time. */
  private readonly pinnedSet: ObservableSet<string>

  constructor(private readonly host: GroupsHost) {
    this.buckets = observable.map<string, Bucket>(undefined, {
      deep: false,
      name: 'pool.groups.buckets',
    })
    this.pinnedSet = observable.set<string>(undefined, {
      deep: false,
      name: 'pool.groups.pinned',
    })
    makeObservable<WorklistGroups, 'nodes' | 'filed' | 'buckets' | 'pinnedSet' | 'host'>(this, {
      nodes: false,
      filed: false,
      buckets: false,
      pinnedSet: false,
      host: false,
      pinnedIds: computed({ equals: compareShallow }),
      keys: computed({ equals: compareShallow }),
      latchedOpenId: computed,
      layout: false,
      bucket: false,
      rankOf: false,
      filedLabel: false,
      filedFoldMs: false,
      file: false,
      group: false,
      clear: false,
    })
  }

  /**
   * File one id's placement: add it, move it between lanes or buckets, or
   * drop it when it has none (invisible or unknown). Inside an action (the
   * filing reaction's effect, or the pool's own). Costs the filed id and the
   * lanes it re-sorts (`counters.groupRuns`, `counters.groupElements`), never
   * the visible count.
   */
  file(id: string, placement: Placement | undefined): void {
    const before = this.filed.get(id)
    if (placement === undefined) {
      if (before === undefined) return
      const left = this.unfile(id, before)
      this.filed.delete(id)
      this.count(left)
      return
    }
    if (before !== undefined && placementEqual(before, placement)) return
    // A move within one bucket re-sorts one set of lanes: count them once.
    const same =
      before !== undefined &&
      (before.pinned ? placement.pinned : !placement.pinned && before.repoKey === placement.repoKey)
    const left = before === undefined ? 0 : this.unfile(id, before)
    const around = this.enfile(id, placement)
    this.filed.set(id, placement)
    this.count(same ? around : left + around)
  }

  /** Drop `id` filed as `placement`; returns the lane members left behind. */
  private unfile(id: string, placement: Placement): number {
    if (placement.pinned) {
      this.pinnedSet.delete(id)
      return this.pinnedSet.size
    }
    const bucket = this.buckets.get(placement.repoKey)
    if (bucket === undefined) return 0
    bucket[laneOf(placement)].delete(id)
    const left = bucket.open.size + bucket.closed.size
    if (left === 0) this.buckets.delete(placement.repoKey)
    return left
  }

  /** Add `id` filed as `placement`; returns the lane members around it. */
  private enfile(id: string, placement: Placement): number {
    if (placement.pinned) {
      this.pinnedSet.add(id)
      return this.pinnedSet.size
    }
    let bucket = this.buckets.get(placement.repoKey)
    if (bucket === undefined) {
      bucket = {
        open: observable.set<string>(undefined, { deep: false, name: 'pool.groups.lane' }),
        closed: observable.set<string>(undefined, { deep: false, name: 'pool.groups.lane' }),
      }
      this.buckets.set(placement.repoKey, bucket)
    }
    bucket[laneOf(placement)].add(id)
    return bucket.open.size + bucket.closed.size
  }

  private count(elements: number): void {
    const counters = this.host.counters
    counters.groupRuns += 1
    counters.groupElements += elements
  }

  /** The pinned ids in rank order: the PINNED section. */
  get pinnedIds(): readonly string[] {
    return rankSorted(this.pinnedSet, (id) => this.rankOf(id))
  }

  /** The group keys in spec order: each bucket's head rank, sorted (ranks are total, L1b). */
  get keys(): readonly string[] {
    const heads: { key: string; rank: RowRank }[] = []
    for (const key of this.buckets.keys()) {
      const rank = this.group(key).headRank
      if (rank !== undefined) heads.push({ key, rank })
    }
    heads.sort((a, b) => compareRank(a.rank, b.rank))
    return heads.map(({ key }) => key)
  }

  /**
   * R-GROUP 5 (`closedFoldEligible`, L1b `groupKeyOf`): the selected row when
   * the grace window folded it and it was open when clicked; else null. Reads
   * the selection and that one row's placement.
   */
  get latchedOpenId(): string | null {
    const id = this.host.selectedId()
    if (id === null || this.host.foldLatch()) return null
    const placement = this.host.node(id)?.placement
    if (placement === undefined || placement.pinned || !placement.closed || placement.dismissed) {
      return null
    }
    return id
  }

  /** The grouped visible rows, no selection: assembled from the filed buckets (snapshot and tests). */
  get layout(): Layout {
    const order = this.host.order()
    const rankIndex = new Map<string, number>()
    order.forEach((id, index) => {
      // `layoutOf` indexes a row exactly when it places it.
      if (this.filed.has(id)) rankIndex.set(id, index)
    })
    const pinnedIds = [...this.pinnedIds]
    const groups: LayoutGroup[] = []
    const byKey = new Map<string, LayoutGroup>()
    for (const key of this.keys) {
      const node = this.group(key)
      // The unselected baseline (spec §7): the latch never reaches the snapshot.
      const group: LayoutGroup = {
        key,
        label: node.label,
        rowIds: [...node.baseRowIds],
        closedIds: [...node.baseClosedIds],
      }
      groups.push(group)
      byKey.set(key, group)
    }
    return { pinnedIds, groups, byKey, rankIndex }
  }

  /** The filed bucket of group `key` (tracked), or undefined. */
  bucket(key: string): Bucket | undefined {
    return this.buckets.get(key)
  }

  /** A known issue's cached rank (tracked), or undefined. */
  rankOf(id: string): RowRank | undefined {
    return this.host.node(id)?.rank
  }

  /** A filed id's group label, or undefined once it files out. */
  filedLabel(id: string): string | undefined {
    return this.filed.get(id)?.label
  }

  /** A filed id's fold stamp, or 0 once it files out. */
  filedFoldMs(id: string): number {
    return this.filed.get(id)?.foldMs ?? 0
  }

  /** The node of group `key` (built on first access). */
  group(key: string): GroupNode {
    let node = this.nodes.get(key)
    if (node === undefined) {
      node = new GroupNode(key, this)
      this.nodes.set(key, node)
    }
    return node
  }

  /** Forget every filing and group node (the pool's dispose). */
  clear(): void {
    this.nodes.clear()
    this.filed.clear()
    this.buckets.clear()
    this.pinnedSet.clear()
  }
}
