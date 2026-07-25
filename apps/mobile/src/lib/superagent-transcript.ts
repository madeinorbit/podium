/**
 * How the Super agent screen builds its transcript (POD-344).
 *
 * The thread's conversation lives in its HEADLESS SESSION TRANSCRIPT — the same
 * pipeline a normal chat renders, which is why the desktop embeds `ChatView`
 * for this surface. `superagent.history` (the `superagent_messages` table) is
 * the FROZEN legacy buffer: the server appends only turn-FAILURE notices to it
 * now, so a screen composed from it alone shows neither the turn the user just
 * sent nor the reply — the phone sat on "sending" forever.
 *
 * Kept pure and RN-free so the composition rules are testable in the node lane.
 */

import type { TranscriptItem } from '@podium/protocol'
import type { SuperagentMessage } from '../client/trpc'

/** Structural twin of the screen's `PendingTurn` — declared here so this module
 *  stays free of the component graph. */
interface EchoableTurn {
  text: string
}

/** Legacy buffered rows → transcript items. Tool/system rows collapse to quiet
 *  lines, exactly as in a session. */
export function legacyToTranscript(rows: readonly SuperagentMessage[]): TranscriptItem[] {
  const items: TranscriptItem[] = []
  for (const row of rows) {
    const text = row.content.trim()
    if (row.role === 'tool') {
      if (!row.toolName && !text) continue
      items.push({
        id: `super:${row.id}`,
        role: 'tool',
        ts: row.createdAt,
        text: '',
        ...(row.toolName ? { toolName: row.toolName } : {}),
        ...(text ? { toolInput: text.split('\n')[0] } : {}),
      })
      continue
    }
    if (!text) continue
    items.push({
      id: `super:${row.id}`,
      role: row.role === 'user' ? 'user' : row.role === 'system' ? 'system' : 'assistant',
      ts: row.createdAt,
      text,
    })
  }
  return items
}

/**
 * The settled conversation: frozen legacy rows first, then the live session
 * transcript. The two sources are disjoint — nothing new is ever written to the
 * legacy buffer — so this is a concatenation, not a merge.
 */
export function settledTranscript(
  legacy: readonly SuperagentMessage[],
  items: readonly TranscriptItem[],
): TranscriptItem[] {
  return [...legacyToTranscript(legacy), ...items]
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
