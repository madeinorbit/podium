import type { TranscriptItem } from '@podium/model'
import type { RuntimeHistoryPage, RuntimeHistoryRange } from '@podium/protocol/daemon'
import { DriverRefusalError } from './errors'

/** Paging for providers exposing a complete, ordered conversation. */
export function pageHistory(
  items: readonly TranscriptItem[],
  segmentId: string,
  range: Omit<RuntimeHistoryRange, 'direction'> & { direction?: RuntimeHistoryRange['direction'] },
): RuntimeHistoryPage {
  const { from, limit, direction = 'before' } = range
  const anchor = from?.components.item
  if (!Number.isInteger(limit) || limit < 1 || limit > 10000 ||
    (from && (from.segmentId !== segmentId || !Number.isInteger(anchor) || anchor! < 0 || anchor! >= items.length))) {
    throw new DriverRefusalError({ reason: 'invalid_value', detail: 'invalid history range or cursor' }, 'transcript.history')
  }
  const start = direction === 'after' ? (anchor === undefined ? 0 : anchor + 1) : Math.max(0, (anchor ?? items.length) - limit)
  const end = direction === 'after' ? Math.min(items.length, start + limit) : (anchor ?? items.length)
  const page = items.slice(start, end)
  const cursor = (item: number) => ({ segmentId, components: { item } })
  return {
    items: page,
    ...(page.length ? { head: cursor(start), tail: cursor(end - 1) } : {}),
    hasMore: direction === 'after' ? end < items.length : start > 0,
  }
}
