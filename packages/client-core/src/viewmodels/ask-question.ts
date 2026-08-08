import type { TranscriptItem } from '@podium/model'

/** One option of an AskUserQuestion question. */
export interface AskOption {
  label: string
  description?: string
}

/** One question of an AskUserQuestion tool call, parsed from toolInputJson. */
export interface AskQuestion {
  question: string
  header?: string
  multiSelect?: boolean
  options: AskOption[]
}

/**
 * One question's answer on its way to the server: the listed options it picked
 * (1-based), or free text through the native Other entry — plus the SHAPE of the
 * question that produced it.
 *
 * The shape travels because the native menu the server types into drives the two
 * differently: a single-select commits on the digit, a multi-select only toggles
 * and needs a Tab to move on, and one pick looks identical from the server side
 * (POD-609). A card that answers without it leaves the agent on a dialog.
 */
export type AskAnswerChoice = { multiSelect?: boolean } & (
  | { optionIndices: number[] }
  /** The native menu's Other entry: `otherIndex` is 1-based (= option count + 1). */
  | { freeText: string; otherIndex: number }
)

/** Parse an AskUserQuestion tool call's raw `toolInputJson` into its questions,
 *  dropping any malformed entry (missing/non-array `options`). */
export function parseAskQuestions(toolInputJson: string | undefined): AskQuestion[] {
  if (!toolInputJson) return []
  try {
    const parsed = JSON.parse(toolInputJson) as { questions?: unknown }
    if (!Array.isArray(parsed?.questions)) return []
    return parsed.questions.filter(
      (q): q is AskQuestion =>
        typeof q === 'object' && q !== null && Array.isArray((q as AskQuestion).options),
    )
  } catch {
    return []
  }
}

export function isAskUserQuestion(item: TranscriptItem): boolean {
  return item.role === 'tool' && item.toolName === 'AskUserQuestion' && Boolean(item.toolInputJson)
}

/**
 * The single AskUserQuestion the user can answer right now: the LAST one in the
 * transcript, and only when it has no result yet. Everything earlier is history.
 */
export function latestPendingQuestion(items: TranscriptItem[]): TranscriptItem | null {
  for (let i = items.length - 1; i >= 0; i--) {
    const item = items[i]
    if (!item || !isAskUserQuestion(item)) continue
    return item.toolResult ? null : item
  }
  return null
}

/** The chosen-option check for an answered card: the result text quotes
 *  `"<label>"`. `answer` is the tool result text (callers resolve it — a paired
 *  ChatBlock.result, or a bare TranscriptItem.toolResult). */
export function isChosenOption(answer: string, label: string): boolean {
  return answer.includes(`"${label}"`)
}
