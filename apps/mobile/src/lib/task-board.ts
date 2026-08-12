import {
  boardIssues,
  flattenRowGroups,
  type IssueRow,
  issueRowsByStage,
} from '@podium/client-core/viewmodels'
import type { IssueStage, IssueWire } from '@podium/model'
import { STAGE_LABEL } from '../theme/stage'

/**
 * THE TASKS TAB'S POPULATION AND ORDER — the desktop board's, not a second one
 * [POD-724].
 *
 * The defect this fixes was reported as "I see many strange tasks here". It was
 * not a filter fault: the phone's scope predicate (`boardIssues`) has agreed with
 * the desktop's since POD-338. It was that the phone rendered every scoped issue
 * FLAT at top level while the desktop defaults to `flatten: false` — grouping only
 * ROOTS by stage and revealing children under an expanded parent. So an epic's
 * decomposition sub-tasks, which the desktop only ever shows nested beneath the
 * work they belong to, arrived on the phone as peers of that work. Fifteen
 * top-level rows where the desk showed three, and no way to tell which was which.
 *
 * Everything structural now comes from the shared derivation:
 *   · population — `boardIssues`: nothing archived, nothing tombstoned, no draft
 *     vessels, and no agent-audience decomposition at top level
 *     (`showAgentTasks: false`, the desktop's `DEFAULT_DISPLAY`);
 *   · rows — `issueRowsByStage(..., 'priority', { flatten: false })`: roots grouped
 *     by their own stage, an expanded root's children following it indented
 *     whatever THEIR stage is (the row's stage glyph disambiguates);
 *   · order within a stage — `priority` ascending, then `seq`, which is
 *     `DEFAULT_DISPLAY.ordering` and holds still while agents work, unlike
 *     `updated`.
 *
 * WHAT STAYS THE PHONE'S OWN, deliberately:
 *   · SECTION ORDER. The desktop list walks `ISSUE_STAGES` (lifecycle order,
 *     proposed → done) because it is a board being scanned in full. The phone
 *     leads with the stages that are moving, because the tab is opened for
 *     thirty seconds to answer "what is happening", and a backlog of two hundred
 *     must not be the first thing under the thumb. Membership and within-stage
 *     order are identical to the desktop; only which section is nearest the top
 *     differs.
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
export const TASK_STAGE_ORDER: readonly IssueStage[] = [
  'in_progress',
  'review',
  'planning',
  'backlog',
  'proposed',
  'done',
]

export interface TaskBoardSection {
  /** The stage this section is, and the `useCollapsed` key suffix. */
  stage: IssueStage
  title: string
  /** Rows the section WOULD show — its count, independent of the fold. */
  rows: IssueRow<IssueWire>[]
}

/**
 * The board's sections, in phone order, empty stages dropped.
 *
 * `expanded` is the set of parent ids the operator has opened. Passing an empty
 * set yields the desktop's collapsed default: roots only.
 */
export function taskBoardSections(
  issues: IssueWire[],
  expanded: ReadonlySet<string>,
  opts: { showDone: boolean },
): TaskBoardSection[] {
  const groups = issueRowsByStage(boardIssues(issues), TASK_BOARD_ORDERING, {
    flatten: false,
    expanded,
  })
  const byStage = new Map(groups.map((g) => [g.stage, g.rows]))
  return TASK_STAGE_ORDER.filter((stage) => opts.showDone || stage !== 'done')
    .map((stage) => ({ stage, title: STAGE_LABEL[stage], rows: byStage.get(stage) ?? [] }))
    .filter((section) => section.rows.length > 0)
}

/**
 * Every board issue as one flat id list, in the same stage/priority order —
 * the task page's prev/next basis.
 *
 * FLAT, NOT THE VISIBLE ROWS, and that is the honest choice on this platform.
 * The desktop's `issuePageOrderIds` prefers the rows currently on screen and
 * falls back to the flat order for a task whose parent is collapsed. The phone's
 * expansion state belongs to the Tasks tab's own component, and the task page is
 * a PUSHED screen that is just as often reached from a notification, a deep link
 * or the Work tab — so "the rows behind me" is frequently a set that was never
 * rendered. The flat order is the one that always exists and never dead-ends.
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
