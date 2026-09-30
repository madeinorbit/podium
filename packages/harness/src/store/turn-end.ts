import type { TranscriptItem } from '@podium/model'
// Extensionless, like cursor-codec: this module rides the browser closure of
// the slice reader.
import type { TranscriptRecordMapper } from '../transcript-types'

/**
 * THE ANSWER A TURN ENDED WITH, for grammars that learn it one record late
 * (POD-4936).
 *
 * Claude, Codex, Pi and OpenCode say on the reply record itself whether it is
 * the final answer. Grok's `updates.jsonl` cannot: its reply record
 * (`agent_message_chunk`) carries no finality, and whether it was narration or
 * the answer is decided by what Grok writes next — a `tool_call` (narration),
 * or `turn_completed` `end_turn` (the answer). Across 23 real Grok sessions
 * (2026-09-30) a reply was followed by exactly one of those two, 245 and 80
 * times, and every `end_turn` came straight after a reply.
 *
 * So a reader walks records in file order and remembers the reply that might
 * be the answer: the last item a record produced, when it is assistant text.
 * Any later user or tool item forgets it; records with no items (reasoning,
 * hooks, bookkeeping) keep it. An `answered` turn end returns it re-marked
 * `answer: true` under the SAME id and cursor, which every consumer merges as a
 * replacement of the row it already has. Any other turn end forgets it.
 *
 * One stamper per read: its memory is that read's position in one file.
 */
export interface TurnEndStamper {
  /** Observe one record and the cursor-stamped items it produced. Returns the
   *  reply this record ended the turn with, marked as the answer, or
   *  `undefined`. */
  observe(record: unknown, items: readonly TranscriptItem[]): TranscriptItem | undefined
}

/** A stamper for this mapper's grammar, or `undefined` when its records mark
 *  answers themselves (no `endsTurn`). */
export function turnEndStamper(mapper: TranscriptRecordMapper): TurnEndStamper | undefined {
  const endsTurn = mapper.endsTurn
  if (!endsTurn) return undefined
  let reply: TranscriptItem | undefined
  return {
    observe(record, items) {
      const end = endsTurn(record)
      if (end !== undefined) {
        const answered = end === 'answered' ? reply : undefined
        reply = undefined
        return answered ? { ...answered, answer: true } : undefined
      }
      const last = items.at(-1)
      if (last === undefined) return undefined
      reply = last.role === 'assistant' && last.text && last.answer !== true ? last : undefined
      return undefined
    },
  }
}

/** Put a stamped answer in place of the row it re-marks (same id), searching
 *  from the end, where it almost always is. False when that row is not in
 *  `items` — a live tail delivered it in an earlier poll. */
export function placeAnswer(items: TranscriptItem[], answer: TranscriptItem): boolean {
  for (let i = items.length - 1; i >= 0; i--) {
    if (items[i]?.id === answer.id) {
      items[i] = answer
      return true
    }
  }
  return false
}
