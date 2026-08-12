import { FEED_EVENT_KINDS, type IssueEventWire } from '@podium/model'
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import type { Store } from '@/app/store'
import { useStoreSelector } from '@/app/store'

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

/** The tail the divider arithmetic runs over. The server's window is larger; this
 *  is what a human would scroll. */
const KEEP = 40

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
  const rows = useStoreSelector((s) => s.issueEvents)
  const events = useMemo(() => projectFeed(rows), [rows])
  const maxId = events.length > 0 ? (events[events.length - 1]?.id ?? 0) : 0

  // The cursor is external state: this device's advance is one writer, and the
  // person's OTHER device is another (its row arrives on the scoped feed).
  const cursor = useSyncExternalStore(
    (onChange) => readPosition.subscribe(onChange),
    () => readPosition.get('issueEvents'),
  )
  // Freeze the divider where the cursor stood when the feed became visible.
  const [divider, setDivider] = useState(cursor)
  const wasVisible = useRef(false)

  // biome-ignore lint/correctness/useExhaustiveDependencies: cursor/divider are advanced, not observed
  useEffect(() => {
    if (visible && !wasVisible.current) setDivider(readPosition.get('issueEvents'))
    wasVisible.current = visible
    if (visible && maxId > cursor.lastEventId) {
      // Monotonic on both sides: the port refuses a proposal at or behind the
      // position it holds, and the server clamps to max.
      readPosition.advance('issueEvents', { lastEventId: maxId, seenAt: new Date().toISOString() })
    }
  }, [visible, maxId, readPosition])

  return {
    events,
    unread: maxId > cursor.lastEventId,
    dividerId: divider.lastEventId,
    dividerTs: divider.seenAt,
  }
}

/**
 * Replicated rows → the rendered tail: oldest first, capped.
 *
 * SORTED BY `eventId`, NOT BY THE ROW KEY. The replica keys these on the
 * composite change id (`"1772\nPOD-13"`), and a collection ordered by that
 * string puts event 100 before event 99 — a feed in an order the log never had.
 * The durable numeric id is the only ordering here.
 */
function projectFeed(rows: readonly IssueEventWire[]): FeedEvent[] {
  return [...rows]
    .sort((a, b) => a.eventId - b.eventId)
    .slice(-KEEP)
    .map((row) => ({
      id: row.eventId,
      ts: row.ts,
      kind: row.kind,
      subject: row.subject,
      repoPath: row.repoPath,
      payload: row.payload,
    }))
}
