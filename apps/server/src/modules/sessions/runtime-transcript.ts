import type { TranscriptItem } from '@podium/model'
import type { RuntimeEvent } from '@podium/protocol/daemon'

/**
 * The runtime event log is the durable source for complete driver transcript
 * items. Terminal and server drivers share this projection, including when a
 * legacy provider-file observation is fenced or unavailable.
 */
export function runtimeTranscriptDeltaFromEvent(event: RuntimeEvent):
  { items: TranscriptItem[]; reset?: boolean; tail?: string } | undefined {
  if (event.t === 'transcript-reset') {
    return { items: [...event.items], reset: true, ...(event.tail !== undefined ? { tail: event.tail } : {}) }
  }
  if (event.t !== 'item' || event.item.kind !== 'complete') return undefined
  return { items: [event.item.item] }
}
