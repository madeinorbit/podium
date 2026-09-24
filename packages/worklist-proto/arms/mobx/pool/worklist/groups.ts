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
 * (a closed issue is cold, and 376 of 732 visible rows are closed at 1x), so a
 * row is placed without being loaded. A change that leaves the placement
 * equal (a rename, a phase change, a heartbeat) stops at the node.
 *
 * THE LAYOUT is one computed over `order` and each visible row's placement:
 * it re-runs only when the order changes or a visible row's placement does,
 * and costs the visible count then (`counters.groupRuns`,
 * `counters.groupElements`). Each group is a `GroupNode` whose id lists are
 * shallow-compared computeds over the layout, so a layout run that leaves a
 * group's lists equal keeps their identity: its header does not redraw.
 *
 * THE SNAPSHOT'S LAYOUT HAS NO SELECTION (spec §7: the oracle projects the
 * unselected baseline). The UI's lanes add the R-GROUP 5 latch
 * (`latchedOpenId`): a selected row the grace window folded stays in the open
 * lane until focus moves, unless the fold was a dismissal (abandoned or
 * tucked) or the row was folded when clicked (`selectedIssueWasFolded`). The
 * latch is one computed, so a click on any other row re-runs nothing here.
 */

import { compareShallow, computed, makeObservable } from 'mobx'
import type { SliceGroup, SliceIssue, SliceOrder } from '../../../../shared/src/slice-types'
import { closedOf, foldAtOf, issueAbandoned, STUB_WAITING } from '../views'
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
 * deadline). `closed`'s "nothing waiting" conjunct is Mb3's roll-up
 * (`STUB_WAITING`, as the row's own `closed`).
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
 * live layout and the tests call it; the rebuild does not (it groups its own
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

/** One group's lanes as the UI draws them (the latch applied), each list shallow-compared. */
export class GroupNode {
  constructor(
    readonly key: string,
    private readonly groups: WorklistGroups,
  ) {
    makeObservable<GroupNode, 'groups' | 'entry'>(this, {
      key: false,
      groups: false,
      entry: computed,
      label: computed,
      rowIds: computed({ equals: compareShallow }),
      closedIds: computed({ equals: compareShallow }),
    })
  }

  private get entry(): LayoutGroup | undefined {
    return this.groups.layout.byKey.get(this.key)
  }

  get label(): string {
    return this.entry?.label ?? ''
  }

  /** The open lane, in rank order, plus a latched selected row at its rank. */
  get rowIds(): readonly string[] {
    const entry = this.entry
    if (entry === undefined) return EMPTY
    const latched = this.groups.latchedOpenId
    if (latched === null || !entry.closedIds.includes(latched)) return entry.rowIds
    const rank = this.groups.layout.rankIndex
    const at = rank.get(latched) ?? 0
    const index = entry.rowIds.findIndex((id) => (rank.get(id) ?? 0) > at)
    const open = [...entry.rowIds]
    open.splice(index === -1 ? open.length : index, 0, latched)
    return open
  }

  /** The closed fold, newest first, less a latched selected row. */
  get closedIds(): readonly string[] {
    const entry = this.entry
    if (entry === undefined) return EMPTY
    const latched = this.groups.latchedOpenId
    if (latched === null || !entry.closedIds.includes(latched)) return entry.closedIds
    return entry.closedIds.filter((id) => id !== latched)
  }
}

/**
 * The groups over the visible order: the layout (snapshot, no selection), the
 * group keys and pinned ids the list reads, one `GroupNode` per key for the
 * headers and lanes, and the latch.
 */
export class WorklistGroups {
  /** Group nodes by key, built on first access (an identity memo, like the pool's models). */
  private readonly nodes = new Map<string, GroupNode>()

  constructor(private readonly host: GroupsHost) {
    makeObservable<WorklistGroups, 'nodes' | 'host'>(this, {
      nodes: false,
      host: false,
      layout: computed,
      pinnedIds: computed({ equals: compareShallow }),
      keys: computed({ equals: compareShallow }),
      latchedOpenId: computed,
      group: false,
      clear: false,
    })
  }

  /** The grouped visible rows, no selection. Re-runs on an order or placement change only. */
  get layout(): Layout {
    const order = this.host.order()
    const counters = this.host.counters
    counters.groupRuns += 1
    counters.groupElements += order.length
    return layoutOf(order, (id) => this.host.node(id)?.placement)
  }

  get pinnedIds(): readonly string[] {
    return this.layout.pinnedIds
  }

  /** The group keys in spec order. */
  get keys(): readonly string[] {
    return this.layout.groups.map((group) => group.key)
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

  /** The node of group `key` (built on first access). */
  group(key: string): GroupNode {
    let node = this.nodes.get(key)
    if (node === undefined) {
      node = new GroupNode(key, this)
      this.nodes.set(key, node)
    }
    return node
  }

  /** Forget every group node (the pool's dispose). */
  clear(): void {
    this.nodes.clear()
  }
}
