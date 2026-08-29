import type { TranscriptItem } from '@podium/model'
import type { RuntimeEvent } from '@podium/protocol/daemon'

/**
 * The runtime event log is the durable source for synthetic headless markers.
 * Provider transcript files do not contain these user actions, so the server
 * must be able to recover the item without pretending it came from a file.
 */
export function runtimeInterruptMarkerFromEvent(event: RuntimeEvent): TranscriptItem | undefined {
  if (event.t !== 'item' || event.item.kind !== 'complete') return undefined
  return event.item.item.event === 'interrupt' ? event.item.item : undefined
}

export function runtimeInterruptItems(items: readonly TranscriptItem[]): TranscriptItem[] {
  return items.filter((item) => item.event === 'interrupt')
}
