import type { MobxPool } from '../pool'
/**
 * The worklist's groups and closed folds, over the ordered
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
 * WHAT A ROW CONTRIBUTES is its `placement` (`placementOfPart`): the pinned
 * flag, the group key and label, the fold verdict and the fold stamp, taken
 * from the row's own part (`views.ts` `ownPartOfRow`, where the fold verdict
 * is computed once per row). It is cached in the facts group of the row's
 * object, read from the own row hot OR cold, so a row is placed without
 * being loaded. A change that leaves the placement equal (a rename, a phase
 * change, a heartbeat) files nothing.
 *
 * THE LAYOUT IS MAINTAINED, ONE ROW AT A TIME. The one filing reaction per
 * issue (`VisibleCollection.track`) hands its visible row's placement and
 * rank to `WorklistGroups.file`, which keeps every list below IN ORDER by
 * moving that row alone (`sorted-lanes.ts`: out at its old place, in at its
 * new one, by binary search): the pinned section and, per group, its
 * members by rank (the head gives the group's label and its place among the
 * groups), its open lane by rank and its closed fold newest first. No lane
 * is re-sorted and none is enumerated to file a row, so a stage move costs
 * the moved row and the lanes it leaves and enters, never the visible count,
 * and a change that leaves a row's place alone (a rename, a phase change, a
 * label) moves nothing and redraws no lane. The group keys sort each
 * group's head rank: O(groups), re-run only when a head changes.
 *
 * A READER READS MEMBERS, NOT FILINGS. A lane is the order; anything else
 * about a member (the head's label, the latched row's rank) is read from the
 * member's own cached values, tracked, never from what was filed. A reader
 * gets a copy of a lane, cached until that lane moves, never the live list.
 *
 * THE SNAPSHOT'S LAYOUT HAS NO SELECTION (spec §7: the oracle projects the
 * unselected baseline). The UI's lanes add the R-GROUP 5 latch
 * (`latchedOpenId`): a selected row the grace window folded stays in the open
 * lane until focus moves, unless the fold was a dismissal (abandoned or
 * tucked) or the row was folded when clicked (`selectedIssueWasFolded`). The
 * latch is one computed, so a click on any other row re-runs nothing here.
 */

import { compareShallow, compareStructural, computed, makeObservable, observable, type IObservableValue } from 'mobx'
import { compareRank, type RowRank } from '../shared/row-view'
import type { SliceGroup, SliceOrder } from '../shared/slice-types'
import type { OwnPart } from '../views'
import { SortedLanes } from './sorted-lanes'

/** Where one visible row goes (R-GROUP), before selection. */
export interface Placement {
  /** R-GROUP 1: pinned rows move to the PINNED section, whatever their fold verdict. */
  readonly pinned: boolean
  /** R-GROUP 2: `repoId ?? repoPath`. */
  readonly repoKey: string
  /** The first member's path, retained with its existing placement facts. */
  readonly repoPath?: string
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
 * One row's placement from its own part (the fold verdict and the stamp the
 * row view shows) and its repo path, with "nothing in the subtree waits"
 * ASSUMED: the row applies the waiting roll-up only to a row this places in
 * the fold (`withWaiting`), so a row that could never fold never reads its
 * subtree.
 */
export function placementOfPart(part: OwnPart, repoPath: string): Placement {
  return {
    pinned: part.pinned,
    repoKey: part.repoKey,
    repoPath,
    label: repoLabelOf(repoPath),
    closed: part.closed,
    dismissed: part.dismissed,
    foldMs: Date.parse(part.foldAt) || 0,
  }
}

/** A fold candidate whose subtree waits on the human stays open (R-GROUP 3, `folds.ts:95-100`). */
export function withWaiting(placement: Placement): Placement {
  return { ...placement, closed: false, dismissed: false }
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
}

/**
 * The grouping itself, over ids in rank order and each one's placement. The
 * rebuild and the tests call it; the live pool files one row at a time
 * instead (`WorklistGroups.file`), and the scaling plant calls this to show
 * what a whole-list layout costs. The maintained lanes hold the same result: same
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
  for (const id of order) {
    const placement = placementOfId(id)
    if (placement === undefined) continue
    if (placement.pinned) {
      pinnedIds.push(id)
      continue
    }
    let bucket = byKey.get(placement.repoKey)
    if (bucket === undefined) {
      bucket = { label: placement.label, open: [], closed: [] }
      byKey.set(placement.repoKey, bucket)
    }
    if (placement.closed) bucket.closed.push([id, placement.foldMs])
    else bucket.open.push(id)
  }
  const groups: LayoutGroup[] = []
  for (const [key, bucket] of byKey) {
    groups.push({
      key,
      label: bucket.label,
      rowIds: bucket.open,
      // Stable: ties keep rank order (L1b `compareClosedFold`).
      closedIds: bucket.closed.sort((a, b) => b[1] - a[1]).map(([id]) => id),
    })
  }
  return { pinnedIds, groups }
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
  /** TRACKED: a known issue's cached rank, placement and visibility; undefined when unknown. */
  node(id: string):
    | {
        readonly rank: RowRank | undefined
        readonly placement: Placement | undefined
        readonly visible: boolean
        readonly nestParent?: string | null
      }
    | undefined
  /** TRACKED: the selected issue id, or null. */
  selectedId(): string | null
  /** TRACKED: `SliceLocals.selectedIssueWasFolded`. */
  foldLatch(): boolean
  /** Every lane read: the lanes are filed only while read or held (POD-5423). */
  demand?(): void
}

/** What one visible row files: its placement and its rank. */
export interface Filing {
  readonly placement: Placement
  readonly rank: RowRank
  /** Flat real-sidebar rows; nested rows retain the existing prototype lanes. */
  readonly root?: boolean
}

/** A closed fold's order: newest `foldMs` first, ties in rank order (L1b `compareClosedFold`). */
interface FoldSort {
  readonly foldMs: number
  readonly rank: RowRank
}

function compareFold(a: FoldSort, b: FoldSort): number {
  return b.foldMs - a.foldMs || compareRank(a.rank, b.rank)
}

/** The first index in `lane` (rank order) whose member ranks after `rank`. */
function rankInsertionPoint(
  lane: readonly string[],
  rank: RowRank,
  rankOfId: (id: string) => RowRank | undefined,
): number {
  let lo = 0
  let hi = lane.length
  while (lo < hi) {
    const mid = (lo + hi) >>> 1
    const at = rankOfId(lane[mid] as string)
    if (at !== undefined && compareRank(at, rank) < 0) lo = mid + 1
    else hi = mid
  }
  return lo
}

/** One group's lanes as the UI draws them (the latch applied). */
export class GroupNode {
  constructor(
    readonly key: string,
    private readonly groups: WorklistGroups,
  ) {
    makeObservable<GroupNode, 'groups' | 'latchedHere'>(this, {
      key: false,
      groups: false,
      latchedHere: false,
      headRank: computed({ equals: compareStructural }),
      metadata: computed({ equals: compareStructural }),
      sidebarMetadata: computed({ equals: compareStructural }),
      label: false,
      repoPath: false,
      sidebarRows: computed({ equals: compareStructural }),
      baseRowIds: computed,
      baseClosedIds: computed,
      rowIds: computed({ equals: compareShallow }),
      closedIds: computed({ equals: compareShallow }),
    })
  }

  /** The rank-first member's rank (open or closed), or undefined once the group is empty. */
  get headRank(): RowRank | undefined {
    const head = this.groups.members.lane(this.key)[0]
    return head === undefined ? undefined : this.groups.rankOf(head)
  }

  /** The rank-first member's label (`folds.ts:200-203`), read from that member. */
  get label(): string {
    return this.metadata.label
  }

  get repoPath(): string {
    return this.metadata.repoPath
  }

  /** Label and path share the existing head cache; renames never read its row. */
  get metadata(): { readonly label: string; readonly repoPath: string } {
    const head = this.groups.members.lane(this.key)[0]
    const placement = head === undefined ? undefined : this.groups.placementOf(head)
    return { label: placement?.label ?? '', repoPath: placement?.repoPath ?? this.key }
  }

  /** The real sidebar groups root rows, including folded roots, before nesting.
   * Use the existing rank lane and cached placement; retain no new cold-id index. */
  get sidebarMetadata(): { readonly label: string; readonly repoPath: string; readonly headBand: RowRank['band'] | undefined } {
    const head = this.groups.members.lane(this.key).find(id => this.groups.isRoot(id))
    const placement = head === undefined ? undefined : this.groups.placementOf(head)
    const headBand = head === undefined ? undefined : this.groups.rankOf(head)?.band
    return { label: placement?.label ?? '', repoPath: placement?.repoPath ?? this.key, headBand }
  }

  /** Root rows only, cached per band rather than per issue or list render. */
  get sidebarRows(): { readonly rowIds: readonly string[]; readonly snoozedIds: readonly string[]; readonly closedIds: readonly string[] } {
    const rowIds = this.groups.rootOpen.lane(this.key).slice()
    const snoozedIds = this.groups.rootSnoozed.lane(this.key).slice()
    const closedIds = this.groups.rootClosed.lane(this.key).slice()
    const latched = this.latchedHere()
    if (latched !== null && this.groups.isRoot(latched)) {
      const rank = this.groups.rankOf(latched)
      if (rank !== undefined) {
        const lane = rank.band === 2 ? snoozedIds : rowIds
        lane.splice(rankInsertionPoint(lane, rank, id => this.groups.rankOf(id)), 0, latched)
        const at = closedIds.indexOf(latched)
        if (at >= 0) closedIds.splice(at, 1)
      }
    }
    return { rowIds, snoozedIds, closedIds }
  }

  /** The open lane in rank order, no selection (the snapshot's lane): a copy of the maintained list. */
  get baseRowIds(): readonly string[] {
    return this.groups.open.lane(this.key).slice()
  }

  /** The closed fold, newest first, no selection: a copy of the maintained list. */
  get baseClosedIds(): readonly string[] {
    return this.groups.closed.lane(this.key).slice()
  }

  /** The open lane plus a latched selected row at its rank. */
  get rowIds(): readonly string[] {
    const lane = this.baseRowIds
    const latched = this.latchedHere()
    if (latched === null) return lane
    const rank = this.groups.rankOf(latched)
    if (rank === undefined) return lane
    const open = [...lane]
    open.splice(rankInsertionPoint(lane, rank, (id) => this.groups.rankOf(id)), 0, latched)
    return open
  }

  /** The closed fold less a latched selected row. */
  get closedIds(): readonly string[] {
    const lane = this.baseClosedIds
    const latched = this.latchedHere()
    return latched === null ? lane : lane.filter((id) => id !== latched)
  }

  /** The latched row when it is filed in this group's fold, else null. */
  private latchedHere(): string | null {
    const latched = this.groups.latchedOpenId
    if (latched === null) return null
    return this.groups.placementOf(latched)?.repoKey === this.key ? latched : null
  }
}

/** The pinned section's one key. */
const PINNED = 'pinned'

/**
 * The groups over the visible rows: the maintained lanes (snapshot, no
 * selection), the group keys and pinned ids the list reads, one `GroupNode`
 * per key for the headers and lanes, and the latch.
 */
export class WorklistGroups {
  /**
   * Group nodes by key, built on first access: an identity memo (the node a
   * key answers never changes), read inside `keys`; every value the node
   * gives is tracked (`clock.ts` lists it).
   */
  private readonly nodes = new Map<string, GroupNode>()
  /** Reported by every lane read (`GroupsHost.demand`). */
  private readonly demand = (): void => this.host.demand?.()
  /** The pinned section, by rank. */
  readonly pinned = new SortedLanes<string, RowRank>(compareRank, 'pool.groups.pinned', this.demand)
  /** Each group's members (open and closed), by rank: the head labels and places the group. */
  readonly members = new SortedLanes<string, RowRank>(compareRank, 'pool.groups.members', this.demand)
  /** Each group's open lane, by rank. */
  readonly open = new SortedLanes<string, RowRank>(compareRank, 'pool.groups.open', this.demand)
  /** Each group's closed fold, newest first. */
  readonly closed = new SortedLanes<string, FoldSort>(compareFold, 'pool.groups.closed', this.demand)
  readonly rootPinned = new SortedLanes<string, RowRank>(compareRank, 'pool.groups.rootPinned', this.demand)
  readonly rootOpen = new SortedLanes<string, RowRank>(compareRank, 'pool.groups.rootOpen', this.demand)
  readonly rootSnoozed = new SortedLanes<string, RowRank>(compareRank, 'pool.groups.rootSnoozed', this.demand)
  readonly rootClosed = new SortedLanes<string, FoldSort>(compareFold, 'pool.groups.rootClosed', this.demand)

  constructor(private readonly host: GroupsHost) {
    makeObservable<WorklistGroups, 'nodes' | 'host' | 'demand'>(this, {
      nodes: false,
      host: false,
      demand: false,
      pinned: false,
      members: false,
      open: false,
      closed: false,
      rootPinned: false,
      rootOpen: false,
      rootSnoozed: false,
      rootClosed: false,
      pinnedIds: computed,
      pinnedRootIds: computed({ equals: compareShallow }),
      isRoot: false,
      keys: computed({ equals: compareShallow }),
      latchedOpenId: computed,
      layout: false,
      rankOf: false,
      placementOf: false,
      file: false,
      group: false,
      clear: false,
    })
  }

  /**
   * File one row: its placement and rank while it is visible, undefined when
   * it is not (hidden, unknown or released). Inside an action (the filing
   * reaction's effect). Moves the row alone in each list it leaves or enters,
   * never the visible count.
   */
  file(id: string, filing: Filing | undefined): void {
    const placement = filing?.placement
    const rank = filing?.rank
    const group = placement !== undefined && !placement.pinned ? placement.repoKey : undefined
    this.pinned.file(id, placement?.pinned === true ? PINNED : undefined, rank)
    this.members.file(id, group, rank)
    this.open.file(id, placement?.closed === false ? group : undefined, rank)
    this.closed.file(
      id,
      placement?.closed === true ? group : undefined,
      placement === undefined || rank === undefined ? undefined : { foldMs: placement.foldMs, rank },
    )
    const root = filing !== undefined && filing.root !== false
    this.rootPinned.file(id, root && placement?.pinned ? PINNED : undefined, rank)
    this.rootOpen.file(id, root && placement?.closed === false && rank?.band !== 2 ? group : undefined, rank)
    this.rootSnoozed.file(id, root && placement?.closed === false && rank?.band === 2 ? group : undefined, rank)
    this.rootClosed.file(id, root && placement?.closed === true ? group : undefined,
      placement === undefined || rank === undefined ? undefined : { foldMs: placement.foldMs, rank })
  }

  /** The pinned ids in rank order (the PINNED section): a copy of the maintained list. */
  get pinnedIds(): readonly string[] {
    return this.pinned.lane(PINNED).slice()
  }

  get pinnedRootIds(): readonly string[] {
    return this.rootPinned.lane(PINNED).slice()
  }

  isRoot(id: string): boolean {
    const node = this.host.node(id)
    return node !== undefined && node.nestParent == null
  }

  /** The group keys in spec order: each group's head rank, sorted (ranks are total, L1b). */
  get keys(): readonly string[] {
    const heads: { key: string; rank: RowRank }[] = []
    for (const key of this.members.keys()) {
      const rank = this.group(key).headRank
      if (rank !== undefined) heads.push({ key, rank })
    }
    heads.sort((a, b) => compareRank(a.rank, b.rank))
    return heads.map(({ key }) => key)
  }

  /**
   * R-GROUP 5 (`closedFoldEligible`, L1b `groupKeyOf`): the selected row when
   * it is visible, the grace window folded it and it was open when clicked;
   * else null. Reads the selection and that one row.
   */
  get latchedOpenId(): string | null {
    const id = this.host.selectedId()
    if (id === null || this.host.foldLatch()) return null
    const node = this.host.node(id)
    const placement = node?.placement
    if (
      node?.visible !== true ||
      placement === undefined ||
      placement.pinned ||
      !placement.closed ||
      placement.dismissed
    ) {
      return null
    }
    return id
  }

  /** The grouped visible rows, no selection: copied from the maintained lanes (snapshot and tests). */
  get layout(): Layout {
    // The unselected baseline (spec §7): the latch never reaches the snapshot.
    const groups = this.keys.map((key): LayoutGroup => {
      const node = this.group(key)
      return {
        key,
        label: node.label,
        rowIds: [...node.baseRowIds],
        closedIds: [...node.baseClosedIds],
      }
    })
    return { pinnedIds: [...this.pinnedIds], groups }
  }

  /** TRACKED: a known issue's cached rank, or undefined. */
  rankOf(id: string): RowRank | undefined {
    return this.host.node(id)?.rank
  }

  /** TRACKED: a known issue's cached placement, or undefined. */
  placementOf(id: string): Placement | undefined {
    return this.host.node(id)?.placement
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

  /** Forget every filing and group node (the pool's dispose; inside an action). */
  clear(): void {
    this.nodes.clear()
    this.pinned.clear()
    this.members.clear()
    this.open.clear()
    this.closed.clear()
    this.rootPinned.clear()
    this.rootOpen.clear()
    this.rootSnoozed.clear()
    this.rootClosed.clear()
  }
}

export type WorklistGroupView = WorklistGroups & {
  readonly foldLatch: IObservableValue<boolean>
  dispose(): void
}

/** Screen-local fold state and grouping share the existing view lifetime. */
export function worklistGroups(pool: MobxPool, initiallyFolded = false): WorklistGroupView {
  return pool.sources.view('worklist.groups', () => {
    const foldLatch = observable.box(initiallyFolded, { name: debugName(() => 'pool.foldLatch') })
    const groups = new WorklistGroups({
      node: id => pool.knownIssue(id),
      selectedId: () => pool.selection.keys().next().value ?? null,
      foldLatch: () => foldLatch.get(),
      demand: () => pool.worklist.need(),
    })
    return Object.assign(groups, { foldLatch, dispose: () => groups.clear() })
  })
}
