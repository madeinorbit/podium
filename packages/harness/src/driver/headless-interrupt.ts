// Part of the Agent Runtime contract (POD-1761). See ./index.ts for the
// surface's five governing rules and the core-vs-extended tier boundary.

import type { TranscriptItem } from '@podium/model'
import type { TurnCompleted, TurnFailureReason } from './errors.js'

/**
 * THE DURABLE RECORD OF A STOPPED HEADLESS TURN (POD-3090).
 *
 * On the terminal family the mark is free: Claude Code writes
 * "[Request interrupted by user]" into its own transcript as a user turn, the
 * parser flags it (`isClaudeInterruptMarker`, `packages/transcript/src/claude.ts`)
 * and the chat renders the stop rule for `event: 'interrupt'`
 * (`ChatBlockView.tsx`). A HEADLESS driver has no such file: the provider simply
 * stops mid-sentence and the turn closes with a verdict nobody reading the
 * conversation back can see. Same product, two stories — and the one a human
 * gets is "the model lost its nerve".
 *
 * So the mark is SYNTHESIZED here, once, from the thing every headless driver
 * already computes at its fence: the turn's terminal result. Each driver had to
 * decide separately what an interrupt looks like before this, and they disagreed
 * — grok-acp minted an `event: 'interrupt'` item, claude-sdk a system note with
 * no event (so the render arm never fired), codex and opencode nothing at all.
 *
 * WHY A MAPPING RATHER THAN A HELPER EACH DRIVER CALLS WHEN IT REMEMBERS: the
 * input is the terminal result itself, so a driver cannot emit the mark for a
 * turn that was not interrupted, and cannot forget it for one that was. The
 * arms are total over what a headless fence produces — `completed` carrying one
 * of the contract's verdicts, or `failed` carrying one of its reasons — and
 * `interrupted` appears on BOTH, because codex reports a stop as a completion
 * with `status: 'interrupted'` while opencode reports it as `MessageAborted`.
 */
export type HeadlessTurnResult =
  | { kind: 'completed'; verdict: TurnCompleted['verdict'] }
  | { kind: 'failed'; reason: TurnFailureReason }

/** Every family that mints a mark. The value is its id namespace, so two
 *  drivers can never collide on one transcript. */
export type HeadlessInterruptFamily = 'codex' | 'opencode' | 'claude-sdk'

/** The terminal path's exact wording, reused so a reader sees one product. */
export const HEADLESS_INTERRUPT_TEXT = '[Request interrupted by user]'

/**
 * STABLE IDENTITY IS THE WHOLE OF THE DEDUPE, and it has to survive three
 * things: a provider sending its terminal update twice, a session being
 * re-adopted from its journal, and a replayed event stream. The epoch is in the
 * id, so a second mark for the same stop is the SAME item — an update in place
 * for every consumer that keys by id — while a genuine second stop, on the next
 * turn, is a different one. A counter or a timestamp would have made a replay
 * look like two stops.
 */
export function headlessInterruptItemId(
  family: HeadlessInterruptFamily,
  sessionId: string,
  turnEpoch: number,
): string {
  return `${family}-interrupt-${sessionId}-${turnEpoch}`
}

/** True for the terminal results that mean "the operator stopped this turn". */
export function isHeadlessInterruptResult(result: HeadlessTurnResult): boolean {
  return result.kind === 'completed'
    ? result.verdict === 'interrupted'
    : result.reason === 'interrupted'
}

export interface HeadlessInterruptMarkInput {
  family: HeadlessInterruptFamily
  /** Podium's session id — the id namespace's second component. */
  sessionId: string
  /** The epoch of the turn that was stopped. */
  turnEpoch: number
  /** The fence's own timestamp, so the mark sits where the stop happened. */
  at: string
  result: HeadlessTurnResult
  /** Family-specific wording, when the driver knows more than "stopped" — the
   *  claude-sdk driver says whether the model host confirmed the interrupt.
   *  Defaults to the terminal path's marker text. */
  text?: string
  /** The role the family already uses for its record. 'user' matches the
   *  terminal path (the stop IS a user action); claude-sdk's record has always
   *  been a system note and its consumers key on that. */
  role?: 'user' | 'system'
}

/**
 * The mapping: a terminal headless result in, at most one transcript item out.
 * `undefined` for every result that is not an interrupt — a done turn, a failed
 * one, a question — so the call site is unconditional and cannot drift.
 */
export function headlessInterruptMark(
  input: HeadlessInterruptMarkInput,
): TranscriptItem | undefined {
  if (!isHeadlessInterruptResult(input.result)) return undefined
  return {
    id: headlessInterruptItemId(input.family, input.sessionId, input.turnEpoch),
    role: input.role ?? 'user',
    text: input.text ?? HEADLESS_INTERRUPT_TEXT,
    ts: input.at,
    event: 'interrupt',
  }
}
