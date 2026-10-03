import { FEED_EVENT_KINDS } from '@podium/model'
import { useEffect, useRef, useState } from 'react'
import type { Store } from '@/app/store'
import { useWorklistPoolProjection } from '@/app/store-worklist-pool'
import { superagentCursor, superagentFeed } from '@podium/client-graph/superagent'

/** Re-exported for the surfaces that name the vocabulary. It is `@podium/model`'s
 *  list now (POD-1772): the server publishes exactly these kinds onto the feed,
 *  so a kind cannot be rendered here but unpublished there. */
export { FEED_EVENT_KINDS as FEED_KINDS }

export interface FeedEvent {
  /** The durable issue-event log id — what the read cursor names and what the
   *  feed orders by. */
  id: number
  ts: string
  kind: string
  subject: string
  repoPath: string | null
  payload: unknown
}

function usePoolFeed(_readPosition: Store['readPosition']) {
  const feed = useWorklistPoolProjection(superagentFeed, { events: [], loading: true })
  const position = useWorklistPoolProjection(superagentCursor, { cursor: { lastEventId: 0, seenAt: null }, loading: true })
  return { events: feed.events, cursor: position.cursor, loading: feed.loading || position.loading }
}

/**
 * The chat's cross-project event feed + its YOU-WERE-HERE read cursor
 * (engraved-column.md §2.5): a capped tail of the durable issue-event log.
 *
 * THE ROWS ARE REPLICATED NOW (POD-1772). This hook used to hold a module-level
 * cache and a 15 s `setInterval` over `issues.events` — its own little sync
 * engine, beside the real one. Everything that cost is visible in what it could
 * not do: an offline reload showed an empty column, the optimistic overlay could
 * not touch the rows, and a freshly-granted issue's history arrived a poll late.
 * The events ride the metadata feed as entity kind `issueEvent`, so this file is
 * now a projection — sort, cap, and the cursor arithmetic — over what the
 * replica already holds.
 *
 * The divider position freezes where the cursor stood when the feed last became
 * visible; the cursor itself advances whenever the feed is on screen, so the
 * divider means "newer than the last time you had the pane open".
 *
 * THE CURSOR IS PER-USER, NOT PER-DEVICE (POD-1380). It arrives from
 * `store.readPosition` — a replicated row keyed by the authenticated principal —
 * so a stream read on a laptop is read on a phone.
 */
export function useIssueEvents(
  readPosition: Store['readPosition'],
  visible: boolean,
): { events: FeedEvent[]; unread: boolean; dividerId: number; dividerTs: string | null } {

  const { events, cursor, loading } = usePoolFeed(readPosition)
  const maxId = events.length > 0 ? (events[events.length - 1]?.id ?? 0) : 0

  // The cursor is external state: this device's advance is one writer, and the
  // person's OTHER device is another (its row arrives on the scoped feed).
  // Freeze the divider where the cursor stood when the feed became visible.
  const [divider, setDivider] = useState(cursor)
  const wasVisible = useRef(false)

  // biome-ignore lint/correctness/useExhaustiveDependencies: cursor/divider are advanced, not observed
  useEffect(() => {
    // Declared read-position context: one imperative read at the visibility
    // edge preserves the freeze BEFORE async pool attachment (0 vs a later
    // hydrated 9). Continuous cursor and event row reads use the pool.
    if (visible && !wasVisible.current) setDivider(readPosition.get('issueEvents'))
    wasVisible.current = visible
    if (visible && !loading && maxId > cursor.lastEventId) {
      // Monotonic on both sides: the port refuses a proposal at or behind the
      // position it holds, and the server clamps to max.
      readPosition.advance('issueEvents', { lastEventId: maxId, seenAt: new Date().toISOString() })
    }
  }, [visible, maxId, readPosition, loading, cursor])

  return {
    events,
    unread: maxId > cursor.lastEventId,
    dividerId: divider.lastEventId,
    dividerTs: divider.seenAt,
  }
}
