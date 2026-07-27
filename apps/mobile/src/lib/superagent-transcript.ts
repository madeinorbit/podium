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

import type { TranscriptItem } from '@podium/protocol'

/** Structural twin of the screen's `PendingTurn` — declared here so this module
 *  stays free of the component graph. */
interface EchoableTurn {
  text: string
}

interface IdentifiedTurn extends EchoableTurn {
  id: string
}

/**
 * The settled conversation plus the in-progress assistant text, which rides the
 * transcript as a live item so a streaming turn wears the same prose voice as a
 * settled one. Blank live text adds nothing (the spinner covers that beat).
 */
export function renderedTranscript(
  settled: readonly TranscriptItem[],
  liveText: string,
  running: boolean,
): TranscriptItem[] {
  const base = [...settled]
  if (running && liveText.trim()) {
    base.push({ id: 'super:live', role: 'assistant', text: liveText.trim() })
  }
  return base
}

/**
 * Drop optimistic turns the transcript has echoed back. Returns the ORIGINAL
 * array when nothing changed, so the caller's `setState` is a no-op instead of
 * a re-render loop.
 */
export function dropEchoedTurns<T extends EchoableTurn>(
  pending: readonly T[],
  items: readonly TranscriptItem[],
): readonly T[] {
  if (pending.length === 0) return pending
  const echoed = new Set(items.filter((i) => i.role === 'user').map((i) => i.text.trim()))
  const next = pending.filter((turn) => !echoed.has(turn.text.trim()))
  return next.length === pending.length ? pending : next
}

/**
 * Drop optimistic turns that can NEVER be echoed (POD-344).
 *
 * A transcript echo is the only thing that settles a pending turn, and a turn
 * that never ran writes no transcript — so a send the server REJECTED, or a
 * turn that ended in ERROR, leaves a row claiming "sending…" until the screen
 * is remounted. That is the reported symptom reached by a second path, past
 * the render-source fix: the error banner appears while the row still insists
 * it is sending.
 *
 * Pass `failedId` for a rejected send — only that turn is dropped, so a turn
 * queued behind it is left alone. Omit it when a dispatched turn ends in error:
 * the thread's writer lock is released and the server refuses a second
 * concurrent turn, so every row still pending belongs to the turn that just
 * died. Returns the ORIGINAL array when nothing changed, matching
 * `dropEchoedTurns` so the caller's `setState` stays a no-op.
 */
export function dropFailedTurns<T extends IdentifiedTurn>(
  pending: readonly T[],
  failedId?: string,
): readonly T[] {
  if (pending.length === 0) return pending
  if (failedId === undefined) return []
  const next = pending.filter((turn) => turn.id !== failedId)
  return next.length === pending.length ? pending : next
}
