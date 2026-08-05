import type { UsageBucketWire } from '@podium/model'
import { useCallback, useEffect, useRef, useState } from 'react'
import type { Trpc } from '@/app/trpc'

/**
 * The usage sheet's data feed: cache-first, revalidate behind it.
 *
 * The sheet unmounts when you close it, so every reopen used to refetch from
 * zero and sit on a "Loading usage…" line — a loading state shown for figures
 * the tab already had. The last answer survives here instead, so a reopen paints
 * real numbers on the first frame and the fetch that follows is a refresh, not a
 * load. The loader is reserved for a genuinely cold sheet.
 *
 * It lives in the module rather than in localStorage on purpose: the token
 * figures are the operator's own consumption, and persisting them would put
 * them in a store that outlives the session and has to be bound to a principal
 * (the kernel side-cache does exactly that, at a weight this doesn't earn). A
 * tab-lifetime cache covers the case that actually hurts — reopening the sheet —
 * and leaves nothing behind.
 */

const REFRESH_MS = 90_000

/**
 * A refresh in flight is only ADMITTED after this long. The query reads the
 * daemon's local buckets and usually answers in tens of milliseconds; a progress
 * hairline that appears and vanishes inside 60ms is a flicker, which reads as a
 * fault rather than as work. Below the threshold the sheet stays completely
 * still, which is what "no waiting" is supposed to look like.
 */
export const PENDING_REVEAL_MS = 400

/** Last answer this tab received, if any. Survives the sheet's unmount. */
let cached: { buckets: UsageBucketWire[]; fetchedAt: number } | null = null

/** Tests only — the module cache is deliberately process-wide otherwise. */
export function resetUsageCache(): void {
  cached = null
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
  const [answer, setAnswer] = useState<{
    buckets: UsageBucketWire[] | null
    fetchedAt: number | null
    failed: boolean
  }>(() => ({
    buckets: cached?.buckets ?? null,
    fetchedAt: cached?.fetchedAt ?? null,
    failed: false,
  }))
  const [waiting, setWaiting] = useState(false)
  const [attempt, setAttempt] = useState(0)
  const retry = useCallback(() => setAttempt((n) => n + 1), [])

  useEffect(() => {
    let cancelled = false
    // One timer per in-flight request, so a slow request finishing late can't
    // clear the reveal timer belonging to the one after it.
    const reveals = new Set<ReturnType<typeof setTimeout>>()

    const load = (): void => {
      const reveal = setTimeout(() => {
        reveals.delete(reveal)
        if (!cancelled) setWaiting(true)
      }, PENDING_REVEAL_MS)
      reveals.add(reveal)

      const settle = (): void => {
        clearTimeout(reveal)
        reveals.delete(reveal)
        if (!cancelled && reveals.size === 0) setWaiting(false)
      }

      trpc.usage.summary.query().then(
        (r) => {
          cached = { buckets: r.buckets, fetchedAt: Date.now() }
          settle()
          if (!cancelled) {
            setAnswer({ buckets: r.buckets, fetchedAt: cached.fetchedAt, failed: false })
          }
        },
        () => {
          settle()
          // The figures already on screen stay; only their currency changed.
          // Swallowing this (as the view used to) left a cold sheet loading
          // forever with nothing to act on.
          if (!cancelled) setAnswer((a) => ({ ...a, failed: true }))
        },
      )
    }

    load()
    const poll = setInterval(load, REFRESH_MS)
    return () => {
      cancelled = true
      for (const t of reveals) clearTimeout(t)
      clearInterval(poll)
    }
  }, [trpc, attempt])

  return { ...answer, waiting, retry }
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
