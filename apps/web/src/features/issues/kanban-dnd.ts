import { ISSUE_STAGES, type IssueStage } from '@podium/model'
import type { IssueViewModel } from '@/app/store'
import { type IssuesOrdering, orderIssues } from './issues-display'

const STAGES = new Set<string>(ISSUE_STAGES)

/** A drop target's stage, or null if the value isn't a real stage. */
export function dropTargetStage(raw: string): IssueStage | null {
  return STAGES.has(raw) ? (raw as IssueStage) : null
}

/** Pointer travel, in px, before a press becomes a drag. Below it the gesture is
 *  still a click — a card that slid two pixels under a heavy hand must open, not
 *  move to another stage. */
export const DRAG_THRESHOLD_PX = 5

export function passedDragThreshold(dx: number, dy: number): boolean {
  return Math.hypot(dx, dy) >= DRAG_THRESHOLD_PX
}

/**
 * WHERE THE CARD WILL ACTUALLY LAND, which is not where the pointer is.
 *
 * The board has no manual order: `orderIssues` sorts every column by the
 * Display menu's choice (priority+seq, updated, or created). So a drop
 * indicator that follows the cursor would promise a placement the board cannot
 * honour — the card would jump somewhere else the moment the store echoed, and
 * the operator would learn to distrust the preview.
 *
 * Instead the indicator SNAPS: this simulates the drop (the moved issue, at its
 * new stage, re-sorted into the target column) and returns the index it will
 * occupy. Dragging over a column then teaches what that column is sorted by,
 * and the settle animation lands exactly where the line was.
 *
 * `column` is the target column's issues as rendered — the moved issue is
 * removed here rather than by the caller, so a within-column drag is a no-op
 * rather than an off-by-one.
 */
export function plannedDropIndex(
  column: readonly IssueViewModel[],
  moved: IssueViewModel,
  stage: IssueStage,
  ordering: IssuesOrdering,
): number {
  const others = column.filter((issue) => issue.id !== moved.id)
  const landed = { ...moved, stage } as IssueViewModel
  const index = orderIssues([...others, landed], ordering).findIndex((i) => i.id === moved.id)
  return index < 0 ? others.length : index
}
