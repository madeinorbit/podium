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
 * recomputed in the commit's settle step only when the order moved or a
 * placement reported a change, and costs the visible count then
 * (`counters.groupRuns`, `counters.groupElements`). A cell-per-placement plus
 * an explicit settle keeps the "recomputed only when order or a row's
 * group/closed flag changes" where the pool's other maintenance lives,
 * instead of behind a second subscription graph. Each group's UI lanes are
 * kept by identity: a settle that leaves a group's lists equal keeps their
 * object, so its header does not redraw.
 *
 * THE SNAPSHOT'S LAYOUT HAS NO SELECTION (spec §7: the oracle projects the
 * unselected baseline). The UI's lanes add the R-GROUP 5 latch
 * (`latchedOpenId`): a selected row the grace window folded stays in the open
 * lane until focus moves, unless the fold was a dismissal (abandoned or
 * tucked) or the row was folded when clicked (`selectedIssueWasFolded`). The
 * latch is recomputed with the lanes, so a click on any other row re-runs no
 * layout.
 *
 * STUBS UNTIL Hb3 (POD-4584), named as the MobX arm names them (Mb2). The
 * fold verdict's "nothing in the subtree waits" conjunct is `STUB_WAITING`
 * (a roll-up): a settled closed root whose subtree asks stays open in the
 * oracle and folds here. The groups test derives that exact exception set
 * from the oracle and fails as soon as the roll-ups are wired.
 */

import type { SliceGroup, SliceIssue, SliceOrder } from '../../../../shared/src/slice-types'
import { type Cell, type CellGraph, sameData } from '../cells'
import { closedOf, foldAtOf, issueAbandoned, STUB_WAITING } from '../views'
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
  const closed = closedOf(issue, STUB_WAITING, input)
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
export function placementRuleOf(input: VisibleInputs, id: string): Placement | undefined {
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

/** The grouped visible rows, no selection. */
export interface Layout {
  readonly pinnedIds: readonly string[]
  readonly groups: readonly LayoutGroup[]
  /** The same groups by key (a header finds its own without a scan). */
  readonly byKey: ReadonlyMap<string, LayoutGroup>
  /** Each placed id's position in `order` (the latch re-inserts a row at its rank). */
  readonly rankIndex: ReadonlyMap<string, number>
}

/**
 * The grouping itself, over ids in rank order and each one's placement. The
 * live settle and the tests call it; the rebuild does not (it groups its own
 * row views with L1b's `groupKeyOf` / `compareClosedFold`).
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

/** What the groups read from the pool. */
export interface GroupsHost {
  readonly graph: CellGraph
  readonly inputs: VisibleInputs
  /** The visible ids in rank order (`VisibleCollection.order`). */
  order(): readonly string[]
  /** UNTRACKED: the selected issue id, or null (the settle is told about selection moves). */
  selectedId(): string | null
  /** UNTRACKED: `SliceLocals.selectedIssueWasFolded` (the R-GROUP 5 latch). */
  foldLatch(): boolean
  readonly counters: VisibleCounters
}

/** Whether two layouts place the same rows the same way (the settle keeps the old one then). */
function sameLayout(a: Layout, b: Layout): boolean {
  return (
    sameData(a.pinnedIds, b.pinnedIds) &&
    sameData(
      a.groups.map((group) => [group.key, group.label, group.rowIds, group.closedIds]),
      b.groups.map((group) => [group.key, group.label, group.rowIds, group.closedIds]),
    )
  )
}

/**
 * The groups over the visible order: the layout (snapshot, no selection), the
 * identity-kept view the list reads, one identity-kept lane object per key
 * for the headers, and the latch. Maintained in `settle`, which the pool
 * calls after the order handler with exactly what moved.
 */
export class WorklistGroups {
  /** One placement cell per issue ever placed (disposed when the issue leaves the pool). */
  private readonly placements = new Map<string, Cell<Placement | undefined>>()
  /** Ids whose placement cell reported a change since the last settle. */
  private readonly reported = new Set<string>()
  private built = false
  private layout: Layout = {
    pinnedIds: EMPTY_VIEW.pinnedIds,
    groups: [],
    byKey: new Map(),
    rankIndex: new Map(),
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
   * The groups handler (after the order handler): recompute the layout only
   * when the order moved or a placement reported, and the lanes only when the
   * layout or the selection moved. Reads no row itself: placements are cells,
   * current after the drain.
   */
  settle(orderMoved: boolean, selectionMoved: boolean): void {
    const { counters } = this.host
    let layoutChanged = false
    if (!this.built || orderMoved || this.reported.size > 0) {
      const order = this.host.order()
      const layout = layoutOf(order, (id) => this.placement(id))
      counters.groupRuns += 1
      counters.groupElements += order.length
      layoutChanged = !this.built || !sameLayout(this.layout, layout)
      if (layoutChanged) {
        this.layout = {
          pinnedIds: Object.freeze([...layout.pinnedIds]),
          groups: Object.freeze(
            layout.groups.map((group) =>
              Object.freeze({
                ...group,
                rowIds: Object.freeze([...group.rowIds]),
                closedIds: Object.freeze([...group.closedIds]),
              }),
            ),
          ),
          byKey: layout.byKey,
          rankIndex: layout.rankIndex,
        }
      }
      this.built = true
    }
    this.reported.clear()
    const latched = this.latchedOpenId()
    if (!layoutChanged && !selectionMoved && this.latched === latched && this.built) return
    this.latched = latched
    this.relane(latched)
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

  /** Rebuild the view and every lane from the layout and the latch, keeping equal objects. */
  private relane(latched: string | null): void {
    const { layout } = this
    const pinnedIds = layout.pinnedIds
    if (!sameData(this.view.pinnedIds, pinnedIds)) {
      this.view = Object.freeze({ pinnedIds, keys: this.view.keys })
      this.moved = true
    }
    const keys = layout.groups.map((group) => group.key)
    if (!sameData(this.view.keys, keys)) {
      this.view = Object.freeze({ pinnedIds: this.view.pinnedIds, keys: Object.freeze(keys) })
      this.moved = true
    }
    const seen = new Set<string>()
    for (const group of layout.groups) {
      seen.add(group.key)
      const entry = layout.byKey.get(group.key) as LayoutGroup
      let rowIds = entry.rowIds
      let closedIds = entry.closedIds
      if (latched !== null && entry.closedIds.includes(latched)) {
        const rank = layout.rankIndex
        const at = rank.get(latched) ?? 0
        const index = entry.rowIds.findIndex((id) => (rank.get(id) ?? 0) > at)
        const open = [...entry.rowIds]
        open.splice(index === -1 ? open.length : index, 0, latched)
        rowIds = open
        closedIds = entry.closedIds.filter((id) => id !== latched)
      }
      const next: GroupLanes = { label: entry.label, rowIds, closedIds }
      const held = this.lanes.get(group.key)
      if (held !== undefined && sameData(held, next)) continue
      this.lanes.set(
        group.key,
        Object.freeze({
          label: next.label,
          rowIds: Object.freeze([...next.rowIds]),
          closedIds: Object.freeze([...next.closedIds]),
        }),
      )
      this.changedKeys.add(group.key)
      this.moved = true
    }
    for (const key of [...this.lanes.keys()]) {
      if (!seen.has(key)) {
        this.lanes.delete(key)
        this.moved = true
      }
    }
    // The list rebuilds its items from the lanes on every view change, so a
    // lane-only move (a row crossing the fold inside one group) needs a new
    // view identity too; the lanes themselves stay identity-kept per group.
    if (this.changedKeys.size > 0) {
      this.view = Object.freeze({ pinnedIds: this.view.pinnedIds, keys: this.view.keys })
      this.moved = true
    }
  }

  /** An issue left the pool entirely: its placement cell goes. */
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
    this.built = false
    this.layout = {
      pinnedIds: EMPTY_VIEW.pinnedIds,
      groups: [],
      byKey: new Map(),
      rankIndex: new Map(),
    }
    this.view = EMPTY_VIEW
    this.lanes.clear()
    this.latched = null
    this.moved = false
    this.changedKeys.clear()
  }
}
