import type { TranscriptItem } from '@podium/model'
import { insertInCursorOrder } from './cursor-order'

/** Identity key for a transcript item: the opaque cursor when present (stable
 *  across re-reads), else the synthesized `id` (a few items have no cursor). */
function itemKey(item: TranscriptItem): string {
  return item.cursor ?? item.id
}

/**
 * Merge live-tail items into a held list, skipping any already present (by
 * cursor/id). A no-op delta returns `prev` unchanged.
 *
 * An unseen item lands at its CURSOR POSITION rather than on the end [POD-343]:
 * a delta frame is not always newer than the held window — the server replays
 * its whole per-session transcript cache when a resubscribing client's `since`
 * cursor is missing, which on a phone (whose socket drops constantly) is
 * routine. Appending those put a reply above the message that produced it. See
 * ./cursor-order; an ordinary live append is still a single comparison.
 */
export function mergeTranscriptItems(
  prev: TranscriptItem[],
  delta: TranscriptItem[],
): TranscriptItem[] {
  if (delta.length === 0) return prev
  const seen = new Set(prev.map(itemKey))
  const merged = [...prev]
  for (const item of delta) {
    const key = itemKey(item)
    if (seen.has(key)) continue
    seen.add(key)
    insertInCursorOrder(merged, item)
  }
  return merged
}

/** Prepend an OLDER page (scroll-back paging); dedupes against what's loaded. */
export function prependTranscriptItems(
  prev: TranscriptItem[],
  older: TranscriptItem[],
): TranscriptItem[] {
  if (older.length === 0) return prev
  const seen = new Set(prev.map(itemKey))
  const fresh = older.filter((item) => !seen.has(itemKey(item)))
  return fresh.length === 0 ? prev : [...fresh, ...prev]
}

/** The text to show for one transcript item, falling back through the tool
 *  fields (title/result/input/name) when there's no prose. */
export function transcriptDisplayText(item: TranscriptItem): string {
  const text = item.text.trim()
  if (text) return text
  return item.toolTitle ?? item.toolResult ?? item.toolInput ?? item.toolName ?? 'Event'
}
