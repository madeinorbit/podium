import { ISSUE_STATUS_LABELS, type IssueStatus } from '@podium/model'
import { color } from './theme'

/**
 * Workflow-stage colour, on the phone [POD-529 parity].
 *
 * ONE table, three surfaces. The desktop paints a task's stage in exactly three
 * places — the React `StageGlyph`, the chat `.ref-link` chip, and the terminal's
 * `REF_STAGE_ACCENT` underline — and POD-583 already caught what happens when a
 * surface is added without being wired to the same values: the terminals kept
 * amber for `in_progress` a whole release after amber became "operator
 * attention" everywhere else. The phone is the fourth surface, so it reads the
 * same values rather than picking hexes that merely look similar.
 *
 * Blue for `in_progress`/`review`, NOT amber: amber is reserved for "waiting on
 * you" (The Signal Rule), and a stage is never an ask.
 */
export const STAGE_COLOR: Readonly<Record<IssueStatus, string>> = {
  proposed: '#d946ef',
  backlog: color.textFaint,
  planning: color.textDim,
  in_progress: '#3b82f6',
  review: '#0ea5e9',
  shipping: '#8b5cf6',
  done: color.success,
  // The cancelled family is DIM, never green (POD-1074). Success is the colour
  // of work that landed; an issue closed as cancelled, duplicate or superseded
  // did not land, and wearing the same tick was the whole complaint.
  cancelled: color.textFaint,
  duplicate: color.textFaint,
  superseded: color.textFaint,
}

/** A ref that parses but has no live row — muted, never a stage colour, so a
 *  replica gap cannot announce a task as something it is not (POD-676). */
export const STAGE_UNKNOWN = color.textFaint

export function stageColor(stage: IssueStatus | null | undefined): string {
  return stage ? STAGE_COLOR[stage] : STAGE_UNKNOWN
}

/** The phone's fourth copy of the stage words, retired (POD-1074): the labels
 *  now come from the model's one status table, so "In Progress" cannot be title
 *  cased here and sentence cased on the desktop. */
export const STAGE_LABEL: Readonly<Record<IssueStatus, string>> = ISSUE_STATUS_LABELS

/** Stage as one word for a dense strip — the sidebar/board vocabulary. */
export function stageWord(stage: IssueStatus): string {
  return STAGE_LABEL[stage]
}
