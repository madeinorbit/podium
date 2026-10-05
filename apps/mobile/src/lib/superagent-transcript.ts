/**
 * How the Super agent screen builds its transcript (POD-344).
 *
 * The thread's conversation lives in its HEADLESS SESSION TRANSCRIPT — the same
 * pipeline a normal chat renders, which is why the desktop embeds `ChatView`
 * for this surface. That transcript is the ONLY source: `superagent.history`
 * (the `superagent_messages` table) is the frozen legacy buffer, and a screen
 * composed from it showed neither the turn the user just sent nor the reply —
 * the phone sat on "sending" forever.
 *
 * The legacy buffer is not read here at all, matching the desktop. It is not
 * inert — `finishPendingTurn` still appends "turn failed" notices to it
 * (server service.ts:625) — and rendering those was worse than skipping them:
 * they are durable, they carry no cursor, and they landed as a PREFIX above the
 * whole conversation, so one failed turn pinned a stale error line to the top
 * of the chat forever. A failed turn already reports itself live, in the right
 * place, through the turn-end event's error (the screen's banner).
 *
 * Kept pure and RN-free so the composition rules are testable in the node lane.
 */

import type { TranscriptItem } from '@podium/model'

/**
 * The in-progress assistant text as a separate feed item. Keeping it separate
 * from the settled item array preserves the settled transcript's identity, so
 * each streaming paint shapes only this row instead of the complete history.
 * Blank live text adds nothing (the spinner covers that beat).
 */
export function liveTranscriptItem(liveText: string, running: boolean): TranscriptItem | undefined {
  const text = liveText.trim()
  return running && text ? { id: 'super:live', role: 'assistant', text } : undefined
}
