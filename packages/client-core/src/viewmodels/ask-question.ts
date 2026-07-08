import type { TranscriptItem } from '@podium/protocol'

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
