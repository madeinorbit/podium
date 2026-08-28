import {
  boardIssues,
  flattenRowGroups,
  type IssueRow,
  issueRowsByStage,
  orderIssues,
  partitionIssueTree,
} from '@podium/client-core/viewmodels'
import type { IssueBoardStage, IssueWire } from '@podium/model'
import { STAGE_LABEL } from '../theme/stage'
import { buildScreeningQueue } from './screening'

/**
 * THE TASKS TAB'S POPULATION AND ORDER — the desktop board's roots, plus the
 * one phone-only promotion for proposals [POD-947].
 *
 * The shared derivation (`issueRowsByStage(..., { flatten: false })`) groups
 * ROOTS by stage and reveals a parent's children only while that parent is
 * expanded. That is the right map of how work is organised, and it is how the
 * desktop board works.
 *
 * THE PHONE PASSED AN EXPANDED SET THAT COULD NEVER GROW, and that is the
 * defect this signature now fixes (2026-08-29, operator report: "the mobile
 * work view has different tasks than desktop"). Roots-only was the right
 * DEFAULT — the tab is a thirty-second inbox, and an epic's decomposition
 * unrolled by default buries what is moving — but with no way to expand, a
 * sub-task existed on this tab only as a count on its parent. The desktop board
 * shows the same roots and hands the operator a chevron; the phone now hands
 * over the same one, against the same derivation, so the two lists hold the
 * same work rather than merely starting from the same rows.
 *
 * On top of that this module PROMOTES every screenable proposal that sits under
 * an approved parent into the Proposed section. A proposal is a decision, not a
 * part: hiding it under the epic that spawned it is how you miss it on the
 * couch. A proposal nested under another still-proposed parent stays hidden —
 * you cannot act on it yet [spec:SP-6144], and the screening deck already
 * leaves it out for the same reason.
 *
 * WHAT STAYS THE PHONE'S OWN, deliberately:
 *   · SECTION ORDER. The desktop list walks `ISSUE_STAGES` (lifecycle order,
 *     proposed → done) because it is a board being scanned in full. The phone
 *     leads with the stages that are moving, because the tab is opened for
 *     thirty seconds to answer "what is happening", and a backlog of two hundred
 *     must not be the first thing under the thumb. Membership and within-stage
 *     order are identical to the desktop's roots; only which section is nearest
 *     the top, and the proposal promotion above, differ.
 *   · A `done` FOLD. The board's Show done toggle is the phone's stand-in for the
 *     desktop's filter menu, which does not fit one-handed.
 *
 * VERTICAL SECTIONS, NOT HORIZONTAL PAGES. Triage needs cross-stage comparison at
 * a glance and a running count per stage; horizontal paging hides every other
 * stage behind a gesture and adds a mode to a screen whose whole job is "what is
 * the shape of my board right now". Sticky + collapsible headers give the same
 * compression — fold what you are not triaging — without hiding anything the
 * operator did not choose to hide.
 */

/** `DEFAULT_DISPLAY.ordering` on the desktop. Named here so the two cannot drift
 *  silently: a change on either side has to come past this constant. */
export const TASK_BOARD_ORDERING = 'priority' as const

/** Stages nearest the thumb first — see the module note on section order. */
export const TASK_STAGE_ORDER: readonly IssueBoardStage[] = [
  'in_progress',
  'review',
  'planning',
  'backlog',
  'proposed',
  'done',
]

/** Nothing expanded — a module constant so a default argument cannot hand the
 *  memoized derivation a fresh Set identity on every render. */
const EMPTY_EXPANDED: ReadonlySet<string> = new Set()

export interface TaskBoardSection {
  /** The stage this section is, and the `useCollapsed` key suffix. */
  stage: IssueBoardStage
  title: string
  /** Rows the section WOULD show — its count, independent of the fold. */
  rows: IssueRow<IssueWire>[]
}

/**
 * The board's sections, in phone order, empty stages dropped.
 *
 * Roots, the children of whichever roots are expanded, plus screenable
 * proposals lifted into Proposed even when they have a parent. An expanded
 * parent's children follow it indented in the PARENT's section, whatever their
 * own stage — the desktop board's rule, and the row's stage glyph is what
 * disambiguates.
 */
export function taskBoardSections(
  issues: IssueWire[],
  opts: { showDone: boolean; expanded?: ReadonlySet<string> },
): TaskBoardSection[] {
  const expanded = opts.expanded ?? EMPTY_EXPANDED
  // "Show done" filters the POPULATION, not the sections. It used to drop the
  // Done section at the end, which was the same thing while children could not
  // be revealed — now a done sub-task would ride into view under an expanded
  // parent (children sit in the PARENT's section whatever their own stage) and
  // walk straight past the operator's filter, with the parent's sub-task count
  // disagreeing about how many rows the chevron owes.
  const scoped = boardIssues(issues).filter((issue) => opts.showDone || issue.stage !== 'done')
  const groups = issueRowsByStage(scoped, TASK_BOARD_ORDERING, { flatten: false, expanded })
  const byStage = new Map(groups.map((g) => [g.stage, [...g.rows]]))
  promoteScreenableProposals(scoped, byStage, expanded)
  return TASK_STAGE_ORDER.map((stage) => ({
    stage,
    title: STAGE_LABEL[stage],
    rows: byStage.get(stage) ?? [],
  })).filter((section) => section.rows.length > 0)
}

/**
 * Lift every proposal the screening deck would offer into the Proposed section
 * as a depth-0 row. Roots that are already proposed are left alone; only
 * parented (and therefore previously hidden) screenable proposals are added.
 * Order is the board's, not the deck's, so a promoted row sits where it would
 * if it had been filed at the top level.
 *
 * A PROMOTED ROW EXPANDS LIKE ANY OTHER. It is not a root, so the shared
 * derivation never emits its children — which would leave the row wearing a
 * sub-task chevron that does nothing. Its subtree is emitted here, by the same
 * rule and against the same `expanded` set.
 *
 * AND THE RE-SORT REORDERS BLOCKS, NOT ROWS. A row at depth 1 belongs to the
 * root above it; sorting the section flat by priority tore revealed children
 * away from their parent and left them indented under whatever row happened to
 * sort in front (found in review, 2026-08-29).
 */
function promoteScreenableProposals(
  scoped: IssueWire[],
  byStage: Map<IssueBoardStage, IssueRow<IssueWire>[]>,
  expanded: ReadonlySet<string>,
): void {
  const listed = new Set([...byStage.values()].flatMap((rows) => rows.map((row) => row.issue.id)))
  const { childrenByParent } = partitionIssueTree(scoped)
  const extras = buildScreeningQueue(scoped).filter((issue) => !listed.has(issue.id))
  if (extras.length === 0) return

  const emit = (issue: IssueWire, depth: number, out: IssueRow<IssueWire>[]): void => {
    if (listed.has(issue.id)) return
    listed.add(issue.id)
    const children = childrenByParent.get(issue.id) ?? []
    const open = children.length > 0 && expanded.has(issue.id)
    out.push({ issue, depth, childCount: children.length, expanded: open })
    if (!open) return
    for (const child of orderIssues(children, TASK_BOARD_ORDERING)) emit(child, depth + 1, out)
  }

  const blocks = rootBlocks(byStage.get('proposed') ?? [])
  for (const issue of extras) {
    const block: IssueRow<IssueWire>[] = []
    emit(issue, 0, block)
    if (block.length > 0) blocks.push(block)
  }
  const byRootId = new Map(
    blocks.map((block) => [(block[0] as IssueRow<IssueWire>).issue.id, block]),
  )
  byStage.set(
    'proposed',
    orderIssues(
      blocks.map((block) => (block[0] as IssueRow<IssueWire>).issue),
      TASK_BOARD_ORDERING,
    ).flatMap((issue) => byRootId.get(issue.id) ?? []),
  )
}

/** Split a section into blocks — each a depth-0 row plus the rows it revealed.
 *  A block is the unit that may be reordered; its inside never is. */
function rootBlocks(rows: readonly IssueRow<IssueWire>[]): IssueRow<IssueWire>[][] {
  const blocks: IssueRow<IssueWire>[][] = []
  for (const row of rows) {
    if (row.depth === 0 || blocks.length === 0) blocks.push([row])
    else (blocks[blocks.length - 1] as IssueRow<IssueWire>[]).push(row)
  }
  return blocks
}

/**
 * Every board issue as one flat id list, in the same stage/priority order —
 * the task page's prev/next basis.
 *
 * FLAT, NOT THE VISIBLE ROWS, and that is the honest choice on this platform.
 * The Tasks tab hides decomposition children, but the task page is a PUSHED
 * screen just as often reached from a notification, a deep link, the Work tab,
 * or a parent's sub-task list. Prev/next from a child you opened that way
 * should not dead-end just because the child is not a list row.
 */
export function taskBoardOrder(issues: IssueWire[]): string[] {
  const groups = issueRowsByStage(boardIssues(issues), TASK_BOARD_ORDERING, {
    flatten: true,
    expanded: new Set<string>(),
  })
  const byStage = new Map(groups.map((g) => [g.stage, g]))
  // Walked in the PHONE's stage order, not `ISSUE_STAGES`. Prev/next means "the
  // next one down the board I am looking at"; running it in lifecycle order
  // would send the operator from the bottom of Review to the top of Backlog,
  // which is nowhere near where their thumb just was.
  return flattenRowGroups(
    TASK_STAGE_ORDER.map((stage) => byStage.get(stage) ?? { stage, rows: [] }),
  )
}

/** The task before / after `id` in the board's flat order. */
export function taskNeighbours(
  order: readonly string[],
  id: string,
): { prev?: string; next?: string } {
  const at = order.indexOf(id)
  if (at < 0) return {}
  return {
    ...(at > 0 ? { prev: order[at - 1] as string } : {}),
    ...(at < order.length - 1 ? { next: order[at + 1] as string } : {}),
  }
}
