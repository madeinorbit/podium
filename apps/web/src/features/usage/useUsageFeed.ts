import type { UsageBucketWire } from '@podium/model'
import { useRef } from 'react'
import type { Trpc } from '@/app/trpc'
import {
  PENDING_REVEAL_MS,
  resetPolledQueryCache,
  usePolledQuery,
} from '@/lib/use-polled-query'

/**
 * The usage sheet's data feed: cache-first, revalidate behind it.
 *
 * The sheet unmounts when you close it, so every reopen used to refetch from
 * zero and sit on a "Loading usage…" line — a loading state shown for figures
 * the tab already had. The last answer survives instead, so a reopen paints real
 * numbers on the first frame and the fetch that follows is a refresh, not a
 * load. The loader is reserved for a genuinely cold sheet.
 *
 * THE CACHE, THE TIMER AND THE REVEAL THRESHOLD ARE NO LONGER THIS FILE'S
 * (POD-1772). They are {@link usePolledQuery}, shared with the other host
 * telemetry reads. What stays here is the sheet's own vocabulary — `buckets`,
 * `waiting`, `retry`.
 *
 * WHY THIS STAYS AN RPC POLL RATHER THAN MOVING ONTO THE FEED. `usage.summary`
 * is not a row: it is a transcript harvest performed on the daemon host at the
 * moment of asking (`MachinesRpc.usage`, which answers `{buckets: []}` on
 * timeout). There is no server-side entity to replicate, nothing to read
 * offline, and nothing an optimistic overlay could apply to. It is host
 * telemetry in the same family as the memory breakdown and the fleet version
 * sweep, and it polls through the same one utility they do.
 *
 * The cache is tab-lifetime, never localStorage: the token figures are the
 * operator's own consumption, and persisting them would put them in a store that
 * outlives the session and has to be bound to a principal.
 */

const REFRESH_MS = 90_000
const CACHE_KEY = 'usage.summary'

export { PENDING_REVEAL_MS }

/** Tests only — the module cache is deliberately process-wide otherwise. */
export function resetUsageCache(): void {
  resetPolledQueryCache(CACHE_KEY)
}

export interface UsageFeed {
  /** Null only when this tab has never had an answer: the one cold state. */
  buckets: UsageBucketWire[] | null
  /** When `buckets` was received, for the staleness stamp. */
  fetchedAt: number | null
  /** A request is in flight AND has been slow enough to be worth showing. */
  waiting: boolean
  /** The last attempt failed. With `buckets` set, what is on screen is old. */
  failed: boolean
  retry: () => void
}

export function useUsageFeed(trpc: Trpc): UsageFeed {
  const query = usePolledQuery<UsageBucketWire[]>({
    key: CACHE_KEY,
    intervalMs: REFRESH_MS,
    read: async () => (await trpc.usage.summary.query()).buckets,
  })
  return {
    buckets: query.data,
    fetchedAt: query.fetchedAt,
    waiting: query.pending,
    failed: query.failed,
    retry: query.refresh,
  }
}

/**
 * True for a sheet that opened with nothing and then received its first answer —
 * the only moment the arrival animation is licensed. A sheet that opened from
 * cache already had its numbers, and animating them in would be choreography
 * over content the operator can already read.
 */
export function useArrived(hasData: boolean): boolean {
  const startedCold = useRef(!hasData)
  return startedCold.current && hasData
}

/** `14:32` — the local clock time a reading was taken. */
export function formatClock(ms: number): string {
  const d = new Date(ms)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}
