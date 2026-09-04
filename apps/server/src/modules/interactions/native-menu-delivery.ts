/**
 * ANSWERING A MENU THE ROW ITSELF READ (POD-2414).
 *
 * The established delivery gate answers a live AskUserQuestion by re-deriving
 * its options from the transcript's last matching tool call. That is right for
 * Claude's AskUserQuestion and structurally impossible for the prompts this
 * issue exists to serve: Claude's onboarding and trust dialogs are drawn by the
 * CLI itself, so there is no tool call, no `toolInputJson`, and nothing in the
 * transcript to match an answer against. The transcript route refuses them with
 * "no pending AskUserQuestion found", which is how a dialog that blocks every
 * turn an operator sends ends up visible in the app and unanswerable from it.
 *
 * A `screen-classifier` ask already carries what the classifier saw. This
 * types against THAT, which is both the only available source and the safer
 * one: it cannot match an answer against a stale AskUserQuestion still sitting
 * in the tail of a transcript whose menu has since been replaced.
 *
 * WHAT THIS DOES NOT RELAX. The menu gate still decides whether any digit may
 * touch the PTY — {@link isNativeMenuLive}, the contract's own predicate — and
 * a choice this cannot express in full is a refusal, never a partial script.
 * Both rules are the delivery gate's, restated against a different option
 * source rather than loosened.
 */

import type { AgentRuntimeState, SessionId } from '@podium/model'
import { isNativeMenuLive } from '@podium/model'
import type { QuestionPrompt, QuestionSelection } from '@podium/protocol'
import type { AnswerChoice, InboxPrincipalReference } from '../sessions/inbox'

export interface NativeMenuDeliveryDeps {
  /** The session's live observed state, for the menu gate. */
  getState(sessionId: SessionId): AgentRuntimeState | null | undefined
  /** The existing keystroke path. Refuses BEFORE typing anything. */
  answer(input: {
    sessionId: SessionId
    choices: AnswerChoice[]
    principal: InboxPrincipalReference
  }): { ok: boolean; reason?: string }
}

export interface NativeMenuDeliveryInput {
  sessionId: SessionId
  /** The ask's own prompts — the shape the classifier observed. */
  questions: readonly QuestionPrompt[]
  /** One selection per prompt, in `questions` order (the contract's rule). */
  selections: readonly QuestionSelection[]
  principal: InboxPrincipalReference
}

/**
 * Map the ask's prompts + the human's selections onto the keystroke path's
 * choices, or say why not.
 *
 * PARTIAL IS A REFUSAL. A menu holds every prompt open at once and the closing
 * CR commits all of them, so answering three of four questions would commit the
 * fourth on whatever row it happened to be sitting. Anything short of one
 * expressible choice per prompt returns null and nothing is typed.
 */
export function nativeMenuChoices(
  questions: readonly QuestionPrompt[],
  selections: readonly QuestionSelection[],
): { ok: true; choices: AnswerChoice[] } | { ok: false; reason: string } {
  if (questions.length === 0) {
    return { ok: false, reason: 'this ask carries no readable options to answer' }
  }
  if (selections.length !== questions.length) {
    return {
      ok: false,
      reason: `this menu holds ${questions.length} prompt(s) and the answer covers ${selections.length}`,
    }
  }
  const choices: AnswerChoice[] = []
  for (const [at, question] of questions.entries()) {
    // Checked by the length guard above; the index read is narrowed for the
    // compiler, not re-validated.
    const selection = selections[at]
    if (!selection) return { ok: false, reason: `prompt ${at + 1}: missing` }
    const shape = {
      ...(question.multiSelect ? { multiSelect: true as const } : {}),
      ...(question.previewLayout ? { previewLayout: true as const } : {}),
    }
    if (selection.text !== undefined) {
      // THE "OTHER" ROW ONLY EXISTS WHERE THE MENU DREW IT. `otherIndex` is set
      // at synthesis from the native rule; without it there is no row to type
      // free text into, and typing it anyway would land the sentence as menu
      // keys.
      if (question.otherIndex === undefined) {
        return { ok: false, reason: `prompt ${at + 1}: this menu has no free-text row` }
      }
      choices.push({ ...shape, freeText: selection.text, otherIndex: question.otherIndex })
      continue
    }
    if (selection.optionIndices.length === 0) {
      return { ok: false, reason: `prompt ${at + 1}: no option chosen` }
    }
    const beyond = selection.optionIndices.find((index) => index > question.options.length)
    if (beyond !== undefined) {
      // The classifier read N options; an index past them is an answer to a
      // menu this is not looking at. Refusing beats pressing row N on a dialog
      // that has moved on.
      return {
        ok: false,
        reason: `prompt ${at + 1}: option ${beyond} is beyond the ${question.options.length} option(s) on screen`,
      }
    }
    choices.push({ ...shape, optionIndices: [...selection.optionIndices] })
  }
  return { ok: true, choices }
}

/**
 * Type an answer at the menu the ask itself read.
 *
 * Returns the keystroke path's own verdict. Every `ok: false` here is a
 * PRE-SEND refusal — the gate, the mapping, or the inbox's own deliverability
 * check — so a caller may treat it as "nothing was typed" and reopen the ask.
 */
export function deliverToNativeMenu(
  deps: NativeMenuDeliveryDeps,
  input: NativeMenuDeliveryInput,
): { ok: boolean; reason?: string } {
  // THE GATE FIRST, and it is about the SCREEN, not about the session's
  // lifecycle status: a session still `starting` with its onboarding dialog up
  // is exactly the case this route exists for, and it is the phase that says
  // whether a menu is drawn.
  const state = deps.getState(input.sessionId)
  if (!isNativeMenuLive(state)) {
    return { ok: false, reason: `no menu on screen (phase=${state?.phase ?? 'unknown'})` }
  }
  const mapped = nativeMenuChoices(input.questions, input.selections)
  if (!mapped.ok) return { ok: false, reason: mapped.reason }
  return deps.answer({
    sessionId: input.sessionId,
    choices: mapped.choices,
    principal: input.principal,
  })
}
