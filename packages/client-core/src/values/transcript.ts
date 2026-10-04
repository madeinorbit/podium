import type { TranscriptItem } from '@podium/model'

/** The text to show for one transcript item, falling back through the tool
 *  fields (title/result/input/name) when there's no prose. */
export function transcriptDisplayText(item: TranscriptItem): string {
  const text = item.text.trim()
  if (text) return text
  return item.toolTitle ?? item.toolResult ?? item.toolInput ?? item.toolName ?? 'Event'
}
