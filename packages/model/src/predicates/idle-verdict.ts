/**
 * What an {@link IdleVerdict} MEANS — the two questions every status surface
 * asks of a stopped agent, answered once.
 *
 *   NEEDS THE HUMAN — the agent stopped and cannot go on without us: a question,
 *   a plan awaiting approval, or a turn the human aborted (it stopped mid-work;
 *   only we know what comes next). This is the needs-you group, the amber dot,
 *   the notification sound, the push.
 *
 *   FINISHED ITS TURN — the agent ran to a natural stop: `done`, and
 *   `open_todos` (it ended the turn with items still on its internal task list).
 *   An unfinished list is ORDINARY with a fleet running — worth SAYING on the
 *   row, and worth nothing else — so `open_todos` answers this question exactly
 *   like `done` wherever completion is what is being asked: the ✓ motion phase,
 *   the finished-row decay, the terminal-verdict-beats-"paused" rule.
 *
 * Both are `Record<…, boolean>` rather than a switch or a `!== 'done'` test, so
 * a NEW verdict kind is a compile error here and has to declare what it means.
 * That is the whole reason this module exists: `open_todos` shipped as a kind on
 * the wire in June with no producer, and six consumers had each spelled one of
 * these two questions inline as its own `kind !== 'done'` — so the day a
 * producer appeared, one line in a harness adapter silently moved every
 * Claude session that ends with a todo left over into NEEDS YOU, rang a sound,
 * cleared its snoozes and cancelled its issue defer. [POD-415]
 */

import type { IdleVerdict } from '../entities/session'

const NEEDS_HUMAN: Record<IdleVerdict['kind'], boolean> = {
  question: true,
  approval: true,
  interrupted: true,
  done: false,
  open_todos: false,
}

const FINISHED_TURN: Record<IdleVerdict['kind'], boolean> = {
  done: true,
  open_todos: true,
  question: false,
  approval: false,
  interrupted: false,
}

/** Is the human the blocker? `undefined` (idle with no verdict — an older daemon,
 *  or a Stop we could not classify) is NOT a request for attention. */
export function idleVerdictNeedsHuman(kind: IdleVerdict['kind'] | undefined): boolean {
  return kind !== undefined && NEEDS_HUMAN[kind]
}

/** Did the turn reach a natural end? `undefined` stays false: an unclassified
 *  stop is not evidence of completion, and callers used to test `=== 'done'`. */
export function idleVerdictFinishedTurn(kind: IdleVerdict['kind'] | undefined): boolean {
  return kind !== undefined && FINISHED_TURN[kind]
}
