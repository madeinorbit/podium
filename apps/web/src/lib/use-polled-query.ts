/**
 * THE ONE POLLING UTILITY (POD-1772).
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS IS FOR, AND WHAT IT IS NOT FOR
 * ---------------------------------------------------------------------------
 *
 * Entity-shaped data does NOT belong here. An issue, a session, a read cursor —
 * anything the server holds as a durable row — rides the feed into the replica,
 * where offline reads, the optimistic overlay and the outbox all apply to it. A
 * timer that re-asks the server for such a row bypasses every one of those
 * semantics, and that is the defect this issue set out to remove.
 *
 * What is left after that move is EPHEMERAL HOST TELEMETRY: a `/proc` walk, a
 * transcript harvest, a fleet version sweep. None of it is a row anywhere; it is
 * a measurement of a machine, taken now, meaningless offline, and never written
 * back. Those reads legitimately poll — but they used to poll through four
 * bespoke timers with four different opinions about caching, cancellation and
 * whether a hidden tab should keep asking. This is the single opinion.
 *
 * ---------------------------------------------------------------------------
 * THE FOUR PROPERTIES A BESPOKE TIMER KEPT GETTING WRONG
 * ---------------------------------------------------------------------------
 *
 * 1. VISIBILITY GATING. A background tab that keeps a 5 s `/proc` walk running
 *    is asking a machine to do work for a pane nobody can see. Polling stops on
 *    `visibilitychange` and takes one immediate reading when the tab comes back,
 *    so the first visible frame is fresh rather than up to one interval stale.
 *
 * 2. ONE CACHE PER KEY, ACROSS MOUNTS. These panels live in sheets and dialogs
 *    that unmount on close, so a reopen used to repaint a loading state over
 *    figures the tab already had. The last answer is held per key at module
 *    scope, deliberately NOT in storage: this is a machine's current state, and
 *    persisting it would outlive its own truth.
 *
 * 3. NO OVERLAPPING REQUESTS. A read slower than its own interval otherwise
 *    stacks up requests behind a busy daemon — the classic way a "refresh" turns
 *    into a load generator. A tick while a request is in flight is dropped.
 *
 * 4. FAILURE KEEPS THE LAST ANSWER. A failed refresh changes the CURRENCY of
 *    what is on screen, not its truth. `failed` says so; `data` stays.
 *
 * Property 2 has a second half, added for POD-1603: holding the last answer is
 * only half of not re-asking. A surface that opens on HOVER is re-mounted by the
 * cheapest gesture in the app, and a cache that repaints instantly and then
 * re-walks the daemon anyway has saved the flicker and none of the work. See
 * {@link PolledQueryOptions.freshForMs}.
 *
 * A cold read (no cached answer yet) reports `pending` only after
 * {@link PENDING_REVEAL_MS}: a progress hairline that appears and vanishes
 * inside 60 ms reads as a fault rather than as work.
 */

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react'

/**
 * A refresh in flight is only ADMITTED as `pending` after this long. Below the
 * threshold the surface stays completely still, which is what "no waiting" is
 * supposed to look like.
 */
export const PENDING_REVEAL_MS = 400

/** Last answer per key, shared across mounts for this tab's lifetime. */
const cache = new Map<string, { value: unknown; fetchedAt: number }>()

/** Tests only — the cache is deliberately process-wide otherwise. */
export function resetPolledQueryCache(key?: string): void {
  if (key === undefined) cache.clear()
  else cache.delete(key)
}

export interface PolledQuery<T> {
  /** Null only while this tab has never had an answer for this key. */
  data: T | null
  /** When `data` was received, for a staleness stamp. */
  fetchedAt: number | null
  /** A request is in flight AND has been slow enough to be worth showing. */
  pending: boolean
  /** The last attempt failed. With `data` set, what is on screen is old. */
  failed: boolean
  /** Why the last attempt failed, for surfaces that name the reason. */
  error: string | null
  /** Take a reading now, outside the schedule. */
  refresh: () => void
}

export interface PolledQueryOptions<T> {
  /**
   * Cache identity. Everything the read depends on must be IN it — a memory
   * breakdown keyed only by `'hosts.memory'` would paint one machine's figures
   * under another machine's heading for a whole interval after a chip click.
   */
  key: string
  /**
   * Repeat every this many ms. `0` (or less) means READ ONCE per key — the
   * shape a surface wants when the reading only becomes worth repeating under
   * some condition, so that "should this repeat?" stays an interval rather than
   * a second code path.
   */
  intervalMs: number
  /** The read itself. Kept in a ref, so an inline closure is fine. */
  read: () => Promise<T>
  /**
   * Fold a FRESH reading into the caller's own state, in the same continuation
   * that received it.
   *
   * WHY THIS IS NOT AN EFFECT ON `data`. A surface that derives React state from
   * a reading (the update dialog folds one into its fleet and action state) must
   * do it in the read's own turn, exactly as the bespoke timer it replaced did.
   * Routing it through `data` and a follow-up effect inserts an extra
   * state-update hop, and one hop is the difference between "the button is there
   * when the answer lands" and "the button is there one flush later".
   *
   * Only fresh reads call it — never the cached answer replayed at mount, which
   * a caller would otherwise re-apply on every remount.
   */
  onData?: (value: T) => void
  /**
   * Poll only while true. Use it for "this pane is the one on screen" — the tab
   * being visible at all is this hook's own business, never the caller's.
   * A disabled query still serves its cached answer.
   */
  enabled?: boolean
  /**
   * How long a cached answer stays worth trusting. While it is younger than
   * this, MOUNTING does not take a new reading — the surface opens on the held
   * figures and asks the machine for nothing.
   *
   * It gates the mount read only. The interval is the caller's stated cadence
   * for how often this reading should be re-taken and always fires; freshness is
   * about not re-taking a reading that is still true just because a panel was
   * opened again. Returning from a hidden tab counts as a mount, which is the
   * intended reading: the promise there is a FRESH first visible frame, and an
   * answer inside this window is exactly that.
   *
   * `0` (the default) keeps the original behaviour — every mount reads.
   */
  freshForMs?: number
}

/** Subscribe to tab visibility as external state so React re-renders on it. */
function subscribeVisibility(onChange: () => void): () => void {
  if (typeof document === 'undefined') return () => {}
  document.addEventListener('visibilitychange', onChange)
  return () => document.removeEventListener('visibilitychange', onChange)
}
const readVisibility = (): boolean =>
  typeof document === 'undefined' || document.visibilityState === 'visible'

export function useTabVisible(): boolean {
  return useSyncExternalStore(subscribeVisibility, readVisibility, () => true)
}

export function usePolledQuery<T>({
  key,
  intervalMs,
  read,
  onData,
  enabled = true,
  freshForMs = 0,
}: PolledQueryOptions<T>): PolledQuery<T> {
  const cached = cache.get(key)
  const [answer, setAnswer] = useState<{
    key: string
    data: T | null
    fetchedAt: number | null
    failed: boolean
    error: string | null
  }>(() => ({
    key,
    data: (cached?.value as T | undefined) ?? null,
    fetchedAt: cached?.fetchedAt ?? null,
    failed: false,
    error: null,
  }))
  const [pending, setPending] = useState(false)
  const [attempt, setAttempt] = useState(0)
  // An explicit refresh means "I do not care how fresh you think you are", so it
  // has to reach the effect as more than a re-run — a key change and a tab
  // returning re-run it too, and both of those SHOULD respect freshness.
  const forced = useRef(false)
  const refresh = useCallback(() => {
    forced.current = true
    setAttempt((n) => n + 1)
  }, [])
  const visible = useTabVisible()

  // The read is re-created on every render by most callers; holding it in a ref
  // keeps the effect keyed on the CACHE KEY (which is what actually identifies
  // the request) instead of restarting the timer on every parent render.
  const readRef = useRef(read)
  readRef.current = read
  const onDataRef = useRef(onData)
  onDataRef.current = onData

  // A key change must repaint from that key's cache on the SAME frame, not one
  // effect later — the intervening frame would show the previous machine's
  // numbers under the new machine's heading.
  if (answer.key !== key) {
    const next = cache.get(key)
    setAnswer({
      key,
      data: (next?.value as T | undefined) ?? null,
      fetchedAt: next?.fetchedAt ?? null,
      failed: false,
      error: null,
    })
    setPending(false)
  }

  useEffect(() => {
    if (!enabled || !visible) return
    let cancelled = false
    let inFlight = false
    let reveal: ReturnType<typeof setTimeout> | undefined

    const load = (skipIfFresh: boolean): void => {
      // Property 3: a tick during a slow read is dropped, never queued.
      if (inFlight) return
      const held = cache.get(key)
      if (skipIfFresh && held !== undefined && Date.now() - held.fetchedAt < freshForMs) return
      inFlight = true
      // Only a COLD read is worth a progress affordance: a refresh behind
      // figures already on screen is not something to interrupt them for.
      if (cache.get(key) === undefined) {
        reveal = setTimeout(() => {
          reveal = undefined
          if (!cancelled) setPending(true)
        }, PENDING_REVEAL_MS)
      }
      const settle = (): void => {
        inFlight = false
        if (reveal !== undefined) {
          clearTimeout(reveal)
          reveal = undefined
        }
        if (!cancelled) setPending(false)
      }
      readRef.current().then(
        (value) => {
          const fetchedAt = Date.now()
          cache.set(key, { value, fetchedAt })
          settle()
          if (cancelled) return
          setAnswer({ key, data: value, fetchedAt, failed: false, error: null })
          onDataRef.current?.(value)
        },
        (cause: unknown) => {
          settle()
          const error = cause instanceof Error ? cause.message : String(cause)
          // Property 4: keep what is on screen; only its currency changed.
          if (!cancelled) {
            setAnswer((a) => (a.key === key ? { ...a, failed: true, error } : a))
          }
        },
      )
    }

    const wasForced = forced.current
    forced.current = false
    load(!wasForced)
    const timer = intervalMs > 0 ? setInterval(() => load(false), intervalMs) : undefined
    return () => {
      cancelled = true
      if (reveal !== undefined) clearTimeout(reveal)
      if (timer !== undefined) clearInterval(timer)
    }
  }, [key, intervalMs, enabled, visible, attempt, freshForMs])

  return {
    data: answer.data,
    fetchedAt: answer.fetchedAt,
    pending,
    failed: answer.failed,
    error: answer.error,
    refresh,
  }
}
