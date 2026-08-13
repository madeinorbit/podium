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
  const blocks = pairToolResults([...input.items])
  const rows = applyChatVerbosity(buildChatRows(blocks), input.verbosity) as ChatRow[]
  const search = transcriptSearchState({
    blocks,
    rows,
    query: input.query,
    cursor: input.cursor,
  })
  return { blocks, rows, search }
}
