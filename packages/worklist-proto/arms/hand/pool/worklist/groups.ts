/**
 * POD-4583 (Hb2) — the worklist's groups and closed folds, over the ordered
 * visible ids (`worklist/visible.ts`).
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
 * WHAT A ROW CONTRIBUTES is its `placement`: the pinned flag, the group key
 * and label, the fold verdict and the fold stamp. One cell per issue, read
 * from the own row hot OR cold (a closed issue may be cold, and the layout
 * must place it without loading it). A change that leaves the placement
 * equal (a rename, a phase change, a heartbeat) keeps the old object
 * (`sameData`) and stops there: the layout below never re-runs.
 *
 * THE LAYOUT IS MAINTAINED, NOT A CELL. Like the order (`visible.ts`), it is
 * filed in the commit's settle step exactly for the rows that moved — one
 * bucket touch per placed id — and costs the moved lanes then
 * (`counters.groupRuns`, `counters.groupElements`), never the visible count.
 * A cell-per-placement plus an explicit settle keeps the "recomputed only
 * when order or a row's group/closed flag changes" where the pool's other
 * maintenance lives, instead of behind a second subscription graph. Each
 * group's UI lanes are kept by identity: a settle that leaves a group's
 * lists equal keeps their object, so its header does not redraw. The group
 * keys sort each bucket's head rank (like the MobX arm, POD-4686): a move
 * inside a bucket re-sorts only its own lanes plus O(groups), never
 * O(visible). The settle never iterates the visible order in steady state
 * (bootstrap files it once); the scaling test counts elements iterated out
 * of `host.order()` from outside, bound 0 per change.
 *
 * THE SNAPSHOT'S LAYOUT HAS NO SELECTION (spec §7: the oracle projects the
 * unselected baseline). The UI's lanes add the R-GROUP 5 latch
 * (`latchedOpenId`): a selected row the grace window folded stays in the open
 * lane until focus moves, unless the fold was a dismissal (abandoned or
 * tucked) or the row was folded when clicked (`selectedIssueWasFolded`). The
 * latch is recomputed with the lanes, so a click on any other row re-runs no
 * layout.
 *
 * THE ROLL-UP CONJUNCT (Hb3, POD-4584). The fold verdict's "nothing in the
 * subtree waits" conjunct is the waiting roll-up (`placementRuleOf` reads it
 * only for a row the settled placement puts in the fold, so a row that could
 * never fold never reads its subtree).
 */

import type { SliceGroup, SliceIssue, SliceOrder } from '../../../../shared/src/slice-types'
import { compareRank, type RowRank } from '../../../../shared/src/row-view'
import { type Cell, type CellGraph, sameData } from '../cells'
import { closedOf, foldAtOf, issueAbandoned } from '../views'
import type { VisibleCounters, VisibleInputs } from './visible'

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
 * deadline), with "nothing in the subtree waits" ASSUMED: Hb3 applies the
 * waiting roll-up only to a row this places in the fold, so a row that could
 * never fold never reads its subtree.
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

/** One row's placement through the visibility inputs (hot or cold, never loaded). */
export function placementRuleOf(input: PlacementInputs, id: string): Placement | undefined {
  const issue = input.issueRow(id)
  if (issue === undefined) return undefined
  const settled = placementOf(issue, input)
  // R-GROUP 3's "nothing waiting": a fold candidate whose subtree waits on
  // the human stays open. Read only for a row this places in the fold, so a
  // row that could never fold never reads its subtree (as Mb3).
  if (!settled.closed) return settled
  return input.waiting(id) ? withWaiting(settled) : settled
}

/** One group of the layout: label, open lane and closed fold, each in its spec order. */
export interface LayoutGroup {
  readonly key: string
  readonly label: string
  readonly rowIds: readonly string[]
  readonly closedIds: readonly string[]
}

/** The grouped visible rows, no selection. */
export interface Layout {
  readonly pinnedIds: readonly string[]
  readonly groups: readonly LayoutGroup[]
  /** The same groups by key (a header finds its own without a scan). */
  readonly byKey: ReadonlyMap<string, LayoutGroup>
}

/**
 * The grouping itself, over ids in rank order and each one's placement. The
 * live settle and the tests call it; the rebuild does not (it groups its own
 * row views with L1b's `groupKeyOf` / `compareClosedFold`).
 *
 * O(changed): one bucket touch per placed id, and no per-id index — the
 * latch finds its row's rank position by binary search over the maintained
 * ranks (`GroupsHost.rankOf`), so a push never walks the order (H3-F1).
 */
export function layoutOf(
  order: readonly string[],
  placementOfId: (id: string) => Placement | undefined,
): Layout {
  const pinnedIds: string[] = []
  const byKey = new Map<string, { label: string; open: string[]; closed: [string, number][] }>()
  order.forEach((id) => {
    const placement = placementOfId(id)
    if (placement === undefined) return
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
  return { pinnedIds, groups, byKey: groupsByKey }
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

/** One group's UI lanes (the latch applied), as its header observes them. */
export interface GroupLanes {
  readonly label: string
  readonly rowIds: readonly string[]
  readonly closedIds: readonly string[]
}

const EMPTY_LANES: GroupLanes = Object.freeze({
  label: '',
  rowIds: Object.freeze([]) as readonly string[],
  closedIds: Object.freeze([]) as readonly string[],
})

/** What the list draws: the pinned ids and group keys, identity-kept (a new object only when they move). */
export interface GroupsView {
  readonly pinnedIds: readonly string[]
  readonly keys: readonly string[]
}

const EMPTY_VIEW: GroupsView = Object.freeze({
  pinnedIds: Object.freeze([]) as readonly string[],
  keys: Object.freeze([]) as readonly string[],
})

/** What the placement rule reads: the visibility inputs plus the waiting roll-up. */
export interface PlacementInputs extends VisibleInputs {
  /** Whether anything in the issue's subtree waits on the human (Hb3). */
  waiting(id: string): boolean
}

/** What the groups read from the pool. */
export interface GroupsHost {
  readonly graph: CellGraph
  readonly inputs: PlacementInputs
  /** The visible ids in rank order (`VisibleCollection.order`; bootstrap only — steady state never walks it). */
  order(): readonly string[]
  /** Whether `id` is in the visible set (`VisibleCollection.has`, untracked). */
  has(id: string): boolean
  /** The rank an id was placed with (the order's maintained ranks, for the latch). */
  rankOf(id: string): RowRank | undefined
  /** UNTRACKED: the selected issue id, or null (the settle is told about selection moves). */
  selectedId(): string | null
  /** UNTRACKED: `SliceLocals.selectedIssueWasFolded` (the R-GROUP 5 latch). */
  foldLatch(): boolean
  readonly counters: VisibleCounters
}

/** Sentinel key for the pinned set in `touched` sets (pinned rows file outside buckets). */
const PINNED_KEY = '\0pinned'

/** One filed bucket, unordered: the lanes sort it at settle time, per group. */
interface Bucket {
  readonly open: Set<string>
  readonly closed: Set<string>
}

/** The lane a placement files into (pinned rows file into the pinned set, not a bucket). */
function laneOf(placement: Placement): 'open' | 'closed' {
  return placement.closed ? 'closed' : 'open'
}

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

/**
 * The groups over the visible order: the filed buckets (snapshot, no
 * selection), the identity-kept view the list reads, one identity-kept lane
 * object per key for the headers, and the latch. Filed in `settle`, which
 * the pool calls after the order handler with the order's membership delta.
 */
export class WorklistGroups {
  /** One placement cell per issue ever placed (disposed when the issue leaves the pool). */
  private readonly placements = new Map<string, Cell<Placement | undefined>>()
  /** Ids whose placement cell reported a change since the last settle. */
  private readonly reported = new Set<string>()
  /** The last filed placement per visible id (plain: lanes read through the buckets below). */
  private readonly filed = new Map<string, Placement>()
  /** The filed buckets by key, stable while non-empty. */
  private readonly buckets = new Map<string, Bucket>()
  /** The filed pinned ids, unordered: `pinnedIds` sorts them at settle time. */
  private readonly pinned = new Set<string>()
  /** Each bucket's head rank (rank-first member's rank), recomputed only for touched groups. */
  private readonly headRanks = new Map<string, RowRank | undefined>()
  private built = false
  private layout: Layout = {
    pinnedIds: EMPTY_VIEW.pinnedIds,
    groups: [],
    byKey: new Map(),
  }
  private view: GroupsView = EMPTY_VIEW
  private readonly lanes = new Map<string, GroupLanes>()
  /** Latch the lanes were built with (a lane rebuild is layout or selection news). */
  private latched: string | null = null
  private moved = false
  private readonly changedKeys = new Set<string>()

  constructor(private readonly host: GroupsHost) {}

  /** One issue's placement cell, created on first placement (kept current by the drain after that). */
  placement(id: string): Placement | undefined {
    let cell = this.placements.get(id)
    if (cell === undefined) {
      const { graph, inputs } = this.host
      cell = graph.cell(
        `placement:${id}`,
        () => placementRuleOf(inputs, id),
        sameData,
        () => this.reported.add(id),
      )
      this.placements.set(id, cell)
    }
    return this.host.graph.read(cell)
  }

  /** Placement cells held (tests: lifecycle, counts). */
  held(): number {
    return this.placements.size
  }

  /** The grouped visible rows, no selection (the snapshot reads this). */
  snapshot(): Layout {
    return this.layout
  }

  /** What the list draws (identity-kept: a new object only when the lanes moved). */
  drawn(): GroupsView {
    return this.view
  }

  /** One group's UI lanes (identity-kept: the same object while its lists are equal). */
  lanesOf(key: string): GroupLanes {
    return this.lanes.get(key) ?? EMPTY_LANES
  }

  /**
   * The groups handler (after the order handler): file exactly the rows that
   * moved — placements that reported, ids that entered or left the visible
   * set — then re-sort only the touched groups' lanes and the key order.
   * Reads no row itself beyond the moved placements (cells, current after
   * the drain) and never iterates the visible order in steady state:
   * bootstrap files it once. `delta` is the order's membership delta, drained
   * by `VisibleCollection.takeMoved`.
   */
  settle(
    delta: { readonly moved: boolean; readonly entered: readonly string[]; readonly left: readonly string[]; readonly rankMoved: readonly string[] },
    selectionMoved: boolean,
  ): void {
    if (!this.built) {
      this.bootstrap()
      this.reported.clear()
      return
    }
    const reported = [...this.reported]
    this.reported.clear()
    const left = new Set(delta.left)
    const entered = new Set(delta.entered)
    // Filing: exactly the rows that moved. Left ids unfile without reading
    // a placement cell; entered ids file their current placement; reported
    // ids file when visible (a hidden row's report files nothing).
    const toFile = new Set<string>()
    for (const id of entered) {
      if (!left.has(id)) toFile.add(id)
    }
    for (const id of reported) {
      if (!left.has(id) && !entered.has(id)) toFile.add(id)
    }
    const touched = new Set<string>()
    const latchedBefore = this.latched
    for (const id of left) {
      const before = this.filed.get(id)
      if (before === undefined) continue
      touched.add(this.keyOf(before))
      const behind = this.unfile(id, before)
      this.filed.delete(id)
      this.count(behind)
    }
    for (const id of toFile) {
      if (!this.host.has(id)) {
        const before = this.filed.get(id)
        if (before === undefined) continue
        touched.add(this.keyOf(before))
        const behind = this.unfile(id, before)
        this.filed.delete(id)
        this.count(behind)
        continue
      }
      const placement = this.placement(id)
      if (placement === undefined) {
        const before = this.filed.get(id)
        if (before === undefined) continue
        touched.add(this.keyOf(before))
        const behind = this.unfile(id, before)
        this.filed.delete(id)
        this.count(behind)
        continue
      }
      const before = this.filed.get(id)
      if (before !== undefined && placementEqual(before, placement)) continue
      const same =
        before !== undefined &&
        (before.pinned ? placement.pinned : !placement.pinned && before.repoKey === placement.repoKey)
      if (before !== undefined) touched.add(this.keyOf(before))
      touched.add(this.keyOf(placement))
      const behind = before === undefined ? 0 : this.unfile(id, before)
      const around = this.enfile(id, placement)
      this.filed.set(id, placement)
      this.count(same ? around : behind + around)
    }
    // Ranks moved without filing (a reorder inside the same lanes): their
    // groups' lanes and head ranks still need a re-sort.
    let pinnedRankMoved = false
    for (const id of delta.rankMoved) {
      if (left.has(id) || toFile.has(id)) continue
      const filed = this.filed.get(id)
      if (filed === undefined) continue
      if (filed.pinned) {
        pinnedRankMoved = true
        continue
      }
      touched.add(filed.repoKey)
    }
    if (pinnedRankMoved || [...touched].some((key) => key === PINNED_KEY)) {
      // Pinned re-sort is handled with the view below; mark it touched.
      touched.add(PINNED_KEY)
    }
    const latched = this.latchedOpenId()
    const latchChanged = latched !== latchedBefore
    this.latched = latched
    if (touched.size === 0 && !selectionMoved && !latchChanged) return
    this.resortTouched(touched, latched, selectionMoved, latchChanged)
  }

  /** Whether the lanes moved since the last call (the pool's publish step asks once per commit). */
  takeMoved(): { readonly moved: boolean; readonly changedKeys: readonly string[] } {
    const moved = this.moved
    const changedKeys = [...this.changedKeys]
    this.moved = false
    this.changedKeys.clear()
    return { moved, changedKeys }
  }

  /**
   * R-GROUP 5 (`closedFoldEligible`, L1b `groupKeyOf`): the selected row when
   * the grace window folded it and it was open when clicked; else null. Reads
   * the selection and that one row's placement only.
   */
  private latchedOpenId(): string | null {
    const id = this.host.selectedId()
    if (id === null || this.host.foldLatch()) return null
    const placement = this.placement(id)
    if (placement === undefined || placement.pinned || !placement.closed || placement.dismissed) {
      return null
    }
    return id
  }

  /** File one id's placement: add it, move it between lanes or buckets, or drop it. */
  private keyOf(placement: Placement): string {
    return placement.pinned ? PINNED_KEY : placement.repoKey
  }

  /** Drop `id` filed as `placement`; returns the lane members left behind. */
  private unfile(id: string, placement: Placement): number {
    if (placement.pinned) {
      this.pinned.delete(id)
      return this.pinned.size
    }
    const bucket = this.buckets.get(placement.repoKey)
    if (bucket === undefined) return 0
    bucket[laneOf(placement)].delete(id)
    const left = bucket.open.size + bucket.closed.size
    if (left === 0) {
      this.buckets.delete(placement.repoKey)
      this.headRanks.delete(placement.repoKey)
    }
    return left
  }

  /** Add `id` filed as `placement`; returns the lane members around it. */
  private enfile(id: string, placement: Placement): number {
    if (placement.pinned) {
      this.pinned.add(id)
      return this.pinned.size
    }
    let bucket = this.buckets.get(placement.repoKey)
    if (bucket === undefined) {
      bucket = { open: new Set(), closed: new Set() }
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

  /** Bootstrap: file the whole visible order once (the only whole-order walk). */
  private bootstrap(): void {
    const order = this.host.order()
    for (const id of order) {
      const placement = this.placement(id)
      if (placement === undefined) continue
      // Bootstrap files visible ids only: `order` is the visible set.
      const around = this.enfile(id, placement)
      void around
      this.filed.set(id, placement)
    }
    this.host.counters.groupRuns += 1
    this.host.counters.groupElements += order.length
    this.built = true
    // Build every lane, head rank, key and the pinned list from the buckets.
    const touched = new Set<string>(this.buckets.keys())
    touched.add(PINNED_KEY)
    this.resortTouched(touched, this.latchedOpenId(), false, false)
    this.latched = this.latchedOpenId()
  }

  /** Sort one bucket's lanes from its members' ranks and filed stamps. */
  private baseLanesOf(key: string): { label: string; rowIds: string[]; closedIds: string[] } | undefined {
    const bucket = this.buckets.get(key)
    if (bucket === undefined) return undefined
    const rankOf = (id: string): RowRank | undefined => this.host.rankOf(id)
    const openRanked: { id: string; rank: RowRank }[] = []
    for (const id of bucket.open) {
      const rank = rankOf(id)
      if (rank !== undefined) openRanked.push({ id, rank })
    }
    openRanked.sort((a, b) => compareRank(a.rank, b.rank))
    const closedRanked: { id: string; rank: RowRank; foldMs: number }[] = []
    for (const id of bucket.closed) {
      const rank = rankOf(id)
      if (rank === undefined) continue
      closedRanked.push({ id, rank, foldMs: this.filed.get(id)?.foldMs ?? 0 })
    }
    // Stable: ties keep rank order (L1b `compareClosedFold`).
    closedRanked.sort((a, b) => b.foldMs - a.foldMs || compareRank(a.rank, b.rank))
    const rowIds = openRanked.map(({ id }) => id)
    const closedIds = closedRanked.map(({ id }) => id)
    // The label is the rank-first member's (`folds.ts:200-203`).
    let label = ''
    let best: RowRank | null = null
    for (const { id, rank } of [...openRanked, ...closedRanked]) {
      const memberLabel = this.filed.get(id)?.label
      if (memberLabel === undefined) continue
      if (best === null || compareRank(rank, best) < 0) {
        best = rank
        label = memberLabel
      }
    }
    return { label, rowIds, closedIds }
  }

  /** One bucket's head rank (rank-first member's rank), or undefined when empty. */
  private headRankOf(key: string): RowRank | undefined {
    const bucket = this.buckets.get(key)
    if (bucket === undefined) return undefined
    let best: RowRank | null = null
    for (const lane of [bucket.open, bucket.closed] as const) {
      for (const id of lane) {
        const rank = this.host.rankOf(id)
        if (rank === undefined) continue
        if (best === null || compareRank(rank, best) < 0) best = rank
      }
    }
    return best ?? undefined
  }

  /** The pinned ids in rank order. */
  private sortedPinned(): string[] {
    const ranked: { id: string; rank: RowRank }[] = []
    for (const id of this.pinned) {
      const rank = this.host.rankOf(id)
      if (rank !== undefined) ranked.push({ id, rank })
    }
    ranked.sort((a, b) => compareRank(a.rank, b.rank))
    return ranked.map(({ id }) => id)
  }

  /**
   * Re-sort exactly the touched groups' lanes, then the key order (O(groups))
   * and the pinned list when touched. Updates the layout (snapshot, no
   * selection), the view and the UI lanes, keeping equal objects.
   */
  private resortTouched(
    touched: Set<string>,
    latched: string | null,
    selectionMoved: boolean,
    latchChanged: boolean,
  ): void {
    // The latch moves one row between its group's lanes: its old and new
    // groups need a re-sort even when nothing filed them.
    if (selectionMoved || latchChanged) {
      for (const id of [this.latched, latched]) {
        if (id === null) continue
        const filed = this.filed.get(id)
        if (filed !== undefined && !filed.pinned) touched.add(filed.repoKey)
      }
    }
    const pinnedTouched = touched.has(PINNED_KEY)
    // Base lanes + head ranks for touched groups.
    const base = new Map<string, { label: string; rowIds: string[]; closedIds: string[] }>()
    for (const key of touched) {
      if (key === PINNED_KEY) continue
      const lanes = this.baseLanesOf(key)
      if (lanes === undefined) {
        this.headRanks.delete(key)
        continue
      }
      base.set(key, lanes)
      this.headRanks.set(key, this.headRankOf(key))
    }
    // Keys: every bucket's cached head rank, sorted (ranks are total, L1b).
    const heads: { key: string; rank: RowRank }[] = []
    for (const key of this.buckets.keys()) {
      const rank = this.headRanks.get(key) ?? this.headRankOf(key)
      if (rank !== undefined) {
        this.headRanks.set(key, rank)
        heads.push({ key, rank })
      }
    }
    heads.sort((a, b) => compareRank(a.rank, b.rank))
    const keys = heads.map(({ key }) => key)
    // Pinned list when touched.
    let pinnedIds = this.layout.pinnedIds
    if (pinnedTouched || !this.built) {
      pinnedIds = Object.freeze(this.sortedPinned())
    }
    // Layout (snapshot, no selection): touched groups rebuilt, the rest kept.
    const byKey = new Map<string, LayoutGroup>(this.layout.byKey)
    let groups = this.layout.groups
    if (touched.size > 0 || !this.built) {
      for (const key of touched) {
        if (key === PINNED_KEY) continue
        const lanes = base.get(key)
        if (lanes === undefined) {
          byKey.delete(key)
          continue
        }
        const group: LayoutGroup = Object.freeze({
          key,
          label: lanes.label,
          rowIds: Object.freeze([...lanes.rowIds]),
          closedIds: Object.freeze([...lanes.closedIds]),
        })
        byKey.set(key, group)
      }
      for (const key of [...byKey.keys()]) {
        if (!this.buckets.has(key)) byKey.delete(key)
      }
      groups = Object.freeze(keys.map((key) => byKey.get(key) as LayoutGroup))
    }
    this.layout = { pinnedIds, groups, byKey }
    // View: pinned ids and keys, identity-kept.
    if (!sameData(this.view.pinnedIds, pinnedIds)) {
      this.view = Object.freeze({ pinnedIds, keys: this.view.keys })
      this.moved = true
    }
    if (!sameData(this.view.keys, keys)) {
      this.view = Object.freeze({ pinnedIds: this.view.pinnedIds, keys: Object.freeze(keys) })
      this.moved = true
    }
    // UI lanes for touched groups (the latch applied), identity-kept.
    const laneKeys = new Set<string>()
    for (const key of touched) {
      if (key === PINNED_KEY) continue
      if (!this.buckets.has(key)) {
        if (this.lanes.delete(key)) {
          this.moved = true
        }
        continue
      }
      laneKeys.add(key)
    }
    if (selectionMoved || latchChanged) {
      for (const key of this.buckets.keys()) {
        const group = byKey.get(key)
        if (group === undefined) continue
        if (laneKeys.has(key)) continue
        // A latch change only moves its own groups' lanes; skip the rest
        // unless the latch sits in them.
        const holdsLatch =
          latched !== null &&
          (group.closedIds.includes(latched) || group.rowIds.includes(latched))
        const heldBefore =
          this.latched !== null &&
          ((this.lanes.get(key)?.closedIds.includes(this.latched) ?? false) ||
            (this.lanes.get(key)?.rowIds.includes(this.latched) ?? false))
        void heldBefore
        if (!holdsLatch && latched !== this.latched) {
          // Only the latch's groups are re-derived below; others keep identity
          // unless their base lanes moved (handled above).
          continue
        }
        laneKeys.add(key)
      }
      // The latch's own groups are always re-derived (they may have been
      // skipped above when untouched).
      for (const id of [this.latched, latched]) {
        if (id === null) continue
        const filed = this.filed.get(id)
        if (filed !== undefined && !filed.pinned) laneKeys.add(filed.repoKey)
      }
    }
    for (const key of laneKeys) {
      const entry = byKey.get(key)
      if (entry === undefined) continue
      let rowIds: readonly string[] = entry.rowIds
      let closedIds: readonly string[] = entry.closedIds
      if (latched !== null && entry.closedIds.includes(latched)) {
        // The latch re-inserts the row at its rank among the open lane: the
        // lane is in rank order, and the maintained ranks give the position
        // by binary search, so no index over the order is built (H3-F1).
        const at = this.host.rankOf(latched)
        let index = entry.rowIds.length
        if (at !== undefined) {
          let lo = 0
          let hi = entry.rowIds.length
          while (lo < hi) {
            const mid = (lo + hi) >>> 1
            const rank = this.host.rankOf(entry.rowIds[mid] as string)
            if (rank !== undefined && compareRank(rank, at) < 0) lo = mid + 1
            else hi = mid
          }
          index = lo
        }
        const open = [...entry.rowIds]
        open.splice(index, 0, latched)
        rowIds = open
        closedIds = entry.closedIds.filter((id) => id !== latched)
      }
      const next: GroupLanes = { label: entry.label, rowIds, closedIds }
      const held = this.lanes.get(key)
      if (held !== undefined && sameData(held, next)) continue
      this.lanes.set(
        key,
        Object.freeze({
          label: next.label,
          rowIds: Object.freeze([...next.rowIds]),
          closedIds: Object.freeze([...next.closedIds]),
        }),
      )
      this.changedKeys.add(key)
      this.moved = true
    }
    // The list rebuilds its items from the lanes on every view change, so a
    // lane-only move (a row crossing the fold inside one group) needs a new
    // view identity too; the lanes themselves stay identity-kept per group.
    if (this.changedKeys.size > 0) {
      this.view = Object.freeze({ pinnedIds: this.view.pinnedIds, keys: this.view.keys })
      this.moved = true
    }
  }

  /** Bootstrap lanes + view (every group is touched). */
  private relaneAll(latched: string | null): void {
    const touched = new Set<string>(this.buckets.keys())
    touched.add(PINNED_KEY)
    this.resortTouched(touched, latched, false, false)
  }

  /**
   * An issue left the pool entirely: its placement cell goes. Its filing
   * stays for the settle, which unfles exactly the ids the order reports as
   * left (counted, with the touched lanes re-sorted) — unfiling here would
   * bypass the count and the header notices.
   */
  forgetIssue(id: string): void {
    const cell = this.placements.get(id)
    if (cell !== undefined) {
      this.host.graph.dispose(cell)
      this.placements.delete(id)
    }
    this.reported.delete(id)
  }

  /** Dispose every placement cell and forget the layout (the pool's dispose). */
  clear(): void {
    const { graph } = this.host
    for (const cell of this.placements.values()) graph.dispose(cell)
    this.placements.clear()
    this.reported.clear()
    this.filed.clear()
    this.buckets.clear()
    this.pinned.clear()
    this.headRanks.clear()
    this.built = false
    this.layout = {
      pinnedIds: EMPTY_VIEW.pinnedIds,
      groups: [],
      byKey: new Map(),
    }
    this.view = EMPTY_VIEW
    this.lanes.clear()
    this.latched = null
    this.moved = false
    this.changedKeys.clear()
  }
}
