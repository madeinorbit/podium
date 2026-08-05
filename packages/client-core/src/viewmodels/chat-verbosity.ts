import type { ChatRow } from './chat'
import { isInteractiveTool } from './chat'

/**
 * TRANSCRIPT VERBOSITY (POD-376) — how much of a run the feed renders.
 *
 * Podium reduces on purpose: a forty-call run folds into one work line, and that
 * reduction is the best thing about this transcript. The problem the teardown
 * found is that the reduction had exactly one setting. A reader debugging a
 * failed turn wants everything; a reader skimming twelve sessions wants the
 * conclusions; today both get the same middle.
 *
 * Three modes, and NORMAL IS UNCHANGED — this ships additive, so no existing
 * session looks different until someone chooses otherwise.
 *
 *  - `summary`  the human's prompts, the agent's answers, anything that
 *               addressed the human, and anything that FAILED. Work that
 *               succeeded quietly is dropped, because in this mode the reader
 *               is asking "what came of this?", not "what happened?".
 *  - `normal`   today: prose, prompts, and one folded work line per run.
 *  - `verbose`  the same rows, with every run already unfolded.
 *
 * Failure is never hidden by any mode. A run with a failed call survives
 * `summary` for the same reason its count survives the fold: a failure behind a
 * disclosure is a failure the operator never sees.
 */
export type ChatVerbosity = 'summary' | 'normal' | 'verbose'

export const CHAT_VERBOSITIES: readonly ChatVerbosity[] = ['summary', 'normal', 'verbose'] as const

/** The stored preference, defaulting to `normal` for anything unrecognized —
 *  including the absent value, so an untouched device keeps today's feed. */
export function parseChatVerbosity(raw: string | null | undefined): ChatVerbosity {
  return raw === 'summary' || raw === 'verbose' ? raw : 'normal'
}

/** One-line explanation for the control's tooltip. */
export function chatVerbosityHint(v: ChatVerbosity): string {
  switch (v) {
    case 'summary':
      return 'Prompts, answers, questions and failures only'
    case 'verbose':
      return 'Every tool call, expanded'
    case 'normal':
      return 'Prose and one line per run of work'
  }
}

/** Does this row survive `summary`? Prose, prompts and human-facing calls do;
 *  a run of quiet successful work does not. */
export function rowSurvivesSummary(row: ChatRow): boolean {
  if (row.kind === 'block') {
    const { item } = row.block
    // A tool block that reached SingleRow is interactive (or an orphan result);
    // interactive rows are exactly what summary exists to preserve.
    if (item.role === 'tool') return isInteractiveTool(item)
    return true
  }
  // A folded run survives only when something in it failed.
  return row.blocks.some((b) => {
    const result = b.result ?? b.item.toolResult
    return result !== undefined && FAILED_RESULT_RE.test(result.trimStart().split('\n', 1)[0] ?? '')
  })
}

/** Kept in step with `toolVerdict` in ./chat — a conservative read of a result's
 *  first line, so ambiguous output never reads as a failure. */
const FAILED_RESULT_RE =
  /^\s*(?:error(?::|\b)|[A-Za-z]*Error:|exception\b|traceback \(most recent call last\)|fatal:|command failed|exit code [1-9]|exited with (?:code [1-9]|non-zero))/i

/** Apply a verbosity to a derived row list. `normal` and `verbose` return the
 *  same rows (verbose changes how a run RENDERS, not which rows exist), so this
 *  returns `rows` referentially unless summary actually drops something. */
export function applyChatVerbosity(rows: readonly ChatRow[], v: ChatVerbosity): readonly ChatRow[] {
  if (v !== 'summary') return rows
  const kept = rows.filter(rowSurvivesSummary)
  return kept.length === rows.length ? rows : kept
}
