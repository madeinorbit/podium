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

/** Structural twin of `PendingTurn`'s failure marking (POD-346): a rejected or
 *  dead turn keeps its words on screen, reads "not sent", and offers a retry. */
interface FailableTurn extends EchoableTurn {
  failed?: string
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
 * Mark still-pending turns as failed when a DISPATCHED turn dies (POD-344).
 *
 * POD-346 already covers the send the server REJECTS: that mutation's catch
 * marks its own row. It cannot cover this one. A turn that is accepted and then
 * dies — harness crash, spawn failure — RESOLVES the mutation, so no catch
 * runs, and it writes no transcript for `dropEchoedTurns` to match against. The
 * row would claim "sending…" until the screen was remounted.
 *
 * Everything still pending belongs to the turn that just died: the writer lock
 * is released at turn-end and the server refuses a second concurrent turn on a
 * thread. Marking rather than dropping keeps POD-346's grammar — the words stay
 * on screen, the row reads "not sent" with the reason, and retry is one tap.
 * Already-failed rows keep their original reason, and the ORIGINAL array comes
 * back when nothing changed, so the caller's `setState` stays a no-op.
 */
export function markTurnsFailed<T extends FailableTurn>(
  pending: readonly T[],
  reason: string,
): readonly T[] {
  if (pending.length === 0) return pending
  if (pending.every((turn) => turn.failed !== undefined)) return pending
  return pending.map((turn) => (turn.failed === undefined ? { ...turn, failed: reason } : turn))
}
