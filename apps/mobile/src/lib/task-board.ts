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
 * ROOTS by stage and hides children until a parent is expanded. That is the
 * right map of how work is organised, and it is how the desktop board works.
 *
 * The phone's Tasks tab is not that map. It is a thirty-second inbox: what is
 * the work, and what needs a call. An unfoldable tree of an epic's internal
 * decomposition is the wrong instrument — the children live on the task page
 * (`IssueSubIssues`), which is where you go to inspect or add them.
 *
 * So this module asks the shared derivation for roots only (empty `expanded`)
 * and then PROMOTES every screenable proposal that sits under an approved
 * parent into the Proposed section. A proposal is a decision, not a part:
 * hiding it under the epic that spawned it is how you miss it on the couch.
 * A proposal nested under another still-proposed parent stays hidden — you
 * cannot act on it yet [spec:SP-6144], and the screening deck already leaves
 * it out for the same reason.
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
 * Roots only, plus screenable proposals lifted into Proposed even when they
 * have a parent. Decomposition children stay off this list.
 */
export function taskBoardSections(
  issues: IssueWire[],
  opts: { showDone: boolean },
): TaskBoardSection[] {
  const scoped = boardIssues(issues)
  const groups = issueRowsByStage(scoped, TASK_BOARD_ORDERING, {
    flatten: false,
    expanded: new Set(),
  })
  const byStage = new Map(groups.map((g) => [g.stage, [...g.rows]]))
  promoteScreenableProposals(scoped, byStage)
  return TASK_STAGE_ORDER.filter((stage) => opts.showDone || stage !== 'done')
    .map((stage) => ({ stage, title: STAGE_LABEL[stage], rows: byStage.get(stage) ?? [] }))
    .filter((section) => section.rows.length > 0)
}

/**
 * Lift every proposal the screening deck would offer into the Proposed
 * section as a depth-0 row. Roots that are already proposed are left alone;
 * only parented (and therefore previously hidden) screenable proposals are
 * added. Order is the board's, not the deck's, so a promoted row sits where
 * it would if it had been filed at the top level.
 */
function promoteScreenableProposals(
  scoped: IssueWire[],
  byStage: Map<IssueBoardStage, IssueRow<IssueWire>[]>,
): void {
  const listed = new Set(
    [...byStage.values()].flatMap((rows) => rows.map((row) => row.issue.id)),
  )
  const { childrenByParent } = partitionIssueTree(scoped)
  const extras = buildScreeningQueue(scoped)
    .filter((issue) => !listed.has(issue.id))
    .map(
      (issue): IssueRow<IssueWire> => ({
        issue,
        depth: 0,
        childCount: childrenByParent.get(issue.id)?.length ?? 0,
        expanded: false,
      }),
    )
  if (extras.length === 0) return
  const proposed = byStage.get('proposed') ?? []
  const byId = new Map([...proposed, ...extras].map((row) => [row.issue.id, row]))
  byStage.set(
    'proposed',
    orderIssues(
      [...proposed, ...extras].map((row) => row.issue),
      TASK_BOARD_ORDERING,
    ).map((issue) => byId.get(issue.id)!),
  )
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
