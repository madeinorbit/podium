import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import type { Store } from '@/app/store'

/** The cross-project event vocabulary the chat feed shows (spec §6.8 — curated
 *  to state changes a human would skim; breadcrumb noise stays out). */
export const FEED_KINDS = [
  'issue.created',
  'issue.started',
  'issue.stage_changed',
  'issue.closed',
  'issue.reopened',
  'issue.needs_human',
  'issue.needs_human_cleared',
  'issue.session_attached',
] as const

export interface FeedEvent {
  id: number
  ts: string
  kind: string
  subject: string
  repoPath: string | null
  payload: unknown
}

const PAGE = 1000
const KEEP = 40
const POLL_MS = 15_000

/** Tail survives remounts (collapse/expand, thread swaps) — the from-zero seek
 *  of the durable log runs once per app load. */
let cachedTail: FeedEvent[] | null = null
let cachedMaxId = 0

async function fetchSince(
  trpc: Store['trpc'],
  since: number,
): Promise<{ rows: FeedEvent[]; maxId: number }> {
  const rows: FeedEvent[] = []
  let cursor = since
  for (;;) {
    const page = (await trpc.issues.events.query({
      since: cursor,
      kinds: [...FEED_KINDS],
      limit: PAGE,
    })) as FeedEvent[]
    rows.push(...page)
    if (page.length < PAGE) break
    cursor = page[page.length - 1]?.id ?? cursor
  }
  const maxId = rows.length > 0 ? (rows[rows.length - 1]?.id ?? since) : since
  return { rows, maxId }
}

/**
 * The chat's cross-project event feed + its YOU-WERE-HERE read cursor
 * (engraved-column.md §2.5): a capped tail of the durable issue-event log.
 *
 * The divider position freezes where the cursor stood when the feed last
 * became visible; the cursor itself advances whenever the feed is on screen, so
 * the collapsed-✦ unread dot (`unread`) and the next session's divider both mean
 * "newer than the last time you had the chat open".
 *
 * THE CURSOR IS PER-USER, NOT PER-DEVICE (POD-1380). It arrives from
 * `store.readPosition` — a replicated row keyed by the authenticated principal —
 * so a stream read on a laptop is read on a phone. It used to be a device-local
 * ui-state key, which was invisible with one device and wrong with two.
 */
export function useIssueEvents(
  trpc: Store['trpc'],
  readPosition: Store['readPosition'],
  visible: boolean,
  /** Only ONE instance should poll at a time: the open column's view, or the
   *  folded bar while the column is folded. Non-polling instances still read
   *  the cached tail (for the unread badge). */
  poll = true,
): { events: FeedEvent[]; unread: boolean; dividerId: number; dividerTs: string | null } {
  const [events, setEvents] = useState<FeedEvent[]>(cachedTail ?? [])
  const [maxId, setMaxId] = useState(cachedMaxId)
  // The cursor is external state: this device's advance is one writer, and the
  // person's OTHER device is another (its row arrives on the scoped feed).
  const cursor = useSyncExternalStore(
    (onChange) => readPosition.subscribe(onChange),
    () => readPosition.get('issueEvents'),
  )
  // Freeze the divider where the cursor stood when the feed became visible.
  const [divider, setDivider] = useState(cursor)
  const wasVisible = useRef(false)

  useEffect(() => {
    if (!poll) return
    let dead = false
    const pull = async (): Promise<void> => {
      try {
        const since = cachedTail ? cachedMaxId : 0
        const { rows, maxId: top } = await fetchSince(trpc, since)
        if (dead || rows.length === 0) return
        cachedTail = [...(cachedTail ?? []), ...rows].slice(-KEEP)
        cachedMaxId = Math.max(cachedMaxId, top)
        setEvents(cachedTail)
        setMaxId(cachedMaxId)
      } catch {
        // transient — the next poll retries
      }
    }
    void pull()
    const t = setInterval(() => void pull(), POLL_MS)
    return () => {
      dead = true
      clearInterval(t)
    }
  }, [trpc, poll])

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
