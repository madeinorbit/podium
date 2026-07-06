import type { TranscriptItem } from '@podium/protocol'

function itemKey(item: TranscriptItem): string {
  return item.cursor ?? item.id
}

export function mergeTranscriptItems(prev: TranscriptItem[], delta: TranscriptItem[]): TranscriptItem[] {
  if (delta.length === 0) return prev
  const seen = new Set(prev.map(itemKey))
  const merged = [...prev]
  for (const item of delta) {
    const key = itemKey(item)
    if (seen.has(key)) continue
    seen.add(key)
    merged.push(item)
  }
  return merged
}

export function transcriptDisplayText(item: TranscriptItem): string {
  const text = item.text.trim()
  if (text) return text
  return item.toolTitle ?? item.toolResult ?? item.toolInput ?? item.toolName ?? 'Event'
}
