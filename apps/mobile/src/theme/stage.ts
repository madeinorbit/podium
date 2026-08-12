import type { IssueStage } from '@podium/model'
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
export const STAGE_COLOR: Readonly<Record<IssueStage, string>> = {
  proposed: '#d946ef',
  backlog: color.textFaint,
  planning: color.textDim,
  in_progress: '#3b82f6',
  review: '#0ea5e9',
  done: color.success,
}

/** A ref that parses but has no live row — muted, never a stage colour, so a
 *  replica gap cannot announce a task as something it is not (POD-676). */
export const STAGE_UNKNOWN = color.textFaint

export function stageColor(stage: IssueStage | null | undefined): string {
  return stage ? STAGE_COLOR[stage] : STAGE_UNKNOWN
}

export const STAGE_LABEL: Readonly<Record<IssueStage, string>> = {
  proposed: 'Proposed',
  backlog: 'Backlog',
  planning: 'Planning',
  in_progress: 'In progress',
  review: 'Review',
  done: 'Done',
}

/** Stage as one word for a dense strip — the sidebar/board vocabulary. */
export function stageWord(stage: IssueStage): string {
  return STAGE_LABEL[stage]
}
