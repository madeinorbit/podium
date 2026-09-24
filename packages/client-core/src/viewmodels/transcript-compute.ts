import type { TranscriptItem } from '@podium/model'
import { buildChatRows, pairToolResults, type ChatBlock, type ChatRow } from './chat'
import { applyChatVerbosity, type ChatVerbosity } from './chat-verbosity'
import { transcriptSearchState, type TranscriptSearchState } from './slices/chat'

/**
 * The serializable input to the transcript compute boundary.
 *
 * This deliberately contains only transcript data and reader state. It can be
 * structured-cloned into a browser Worker, a native worker runtime, or run
 * synchronously by a test/fallback host without bringing React, the DOM, or a
 * platform renderer across the boundary.
 */
export interface TranscriptComputeInput {
  items: readonly TranscriptItem[]
  verbosity: ChatVerbosity
  query: string
  cursor: number
}

/** Stable, renderer-neutral result shared by desktop and mobile consumers. */
export interface TranscriptComputeResult {
  blocks: ChatBlock[]
  rows: ChatRow[]
  search: TranscriptSearchState
}

/**
 * Shape the loaded transcript once, then answer the current search over that
 * same block/row graph. The result is intentionally plain data: no React
 * elements, DOM nodes, callbacks, or platform-specific envelopes cross the
 * worker boundary.
 */
export function computeTranscript(input: TranscriptComputeInput): TranscriptComputeResult {
  const blocks = pairToolResults(promptsBeforeTheirReplies([...input.items]))
  const rows = applyChatVerbosity(buildChatRows(blocks), input.verbosity) as ChatRow[]
  const search = transcriptSearchState({
    blocks,
    rows,
    query: input.query,
    cursor: input.cursor,
  })
  return { blocks, rows, search }
}

/**
 * FILE ORDER IS NOT TURN ORDER (POD-4639).
 *
 * Items arrive in the harness file's byte order, and that order is the cursor
 * contract — paging and merging depend on it, so it is not touched upstream.
 * But Claude Code can write a synthetic reply it produces WITHOUT a model call
 * ("Not logged in · Please run /login") to its JSONL before it flushes the
 * prompt that caused it, so a signed-out launch rendered the reply above the
 * prompt on every client. Both lines carry honest timestamps; only the write
 * order is inverted. It is a race, not a format: 2.1.280 inverted it on a
 * Podium launch, while a local 2.1.281 run wrote the same pair in order.
 *
 * So a prompt is lifted, here where rows are shaped, above the replies
 * directly over it that are stamped AFTER it. The lift is deliberately
 * narrow: it stops at another prompt, at anything unstamped, and at the first
 * reply stamped at or before the prompt — it is a local repair of one inverted
 * write, never a timestamp sort of the transcript. Mutates and returns `items`.
 */
function promptsBeforeTheirReplies(items: TranscriptItem[]): TranscriptItem[] {
  for (let i = 1; i < items.length; i++) {
    const prompt = items[i]!
    if (prompt.role !== 'user') continue
    const at = stampOf(prompt)
    if (at === undefined) continue
    let j = i
    while (j > 0) {
      const above = items[j - 1]!
      const aboveAt = stampOf(above)
      if (above.role === 'user' || aboveAt === undefined || aboveAt <= at) break
      j--
    }
    if (j === i) continue
    items.splice(i, 1)
    items.splice(j, 0, prompt)
  }
  return items
}

function stampOf(item: TranscriptItem): number | undefined {
  if (!item.ts) return undefined
  const at = Date.parse(item.ts)
  return Number.isNaN(at) ? undefined : at
}
