import { useRef } from 'react'
import type { ChatRow } from './chat'

/**
 * ARRIVAL (POD-423). A row that just landed reads as news for one beat, and is
 * then indistinguishable from a row that has been there an hour.
 *
 * The whole problem is telling "new" from "newly rendered", because almost
 * nothing on this surface is actually new. Opening a session mounts three
 * hundred rows at once; scrolling up pages four hundred more off disk; the
 * transcript re-renders on a 700ms poll and on every tick of a live timer. A
 * mount-time animation would fire for all of it, and a feed that flickers once
 * per poll is worse than a feed with no motion at all.
 *
 * So arrival is decided from row IDENTITY across renders, and only in the one
 * case that means what the reader thinks it means:
 *
 *   - the FIRST pass never arrives anything. The transcript you open is
 *     history, however new the DOM is.
 *   - a key that appears AFTER the last row we already had is an append: the
 *     agent said something. That arrives.
 *   - a key that appears BEFORE it is an older page paged in from disk. That is
 *     history too, and stays still.
 *   - no keys in common means a different session (or a window that moved
 *     wholesale), which is a new transcript, not new messages. Nothing arrives.
 *
 * Identity is the row's first item id, NOT its index: an older page shifts every
 * absolute index in the feed, and index-keyed identity would read that as three
 * hundred simultaneous arrivals.
 */

/** More than a handful landing between two renders is a backfill — a reconnect
 *  replaying its cache, a verbosity switch — not a burst of speech. Cascading
 *  animations down a screenful of rows is exactly the jitter this avoids, so
 *  past this the whole batch stays still. */
export const MAX_ARRIVALS = 4

/** Stable identity of a rendered row. A tools row always folds ≥1 block. */
export function rowIdentity(row: ChatRow): string {
  return row.kind === 'tools' ? row.blocks[0]!.item.id : row.block.item.id
}

/** Which of `next` are newly APPENDED relative to `prev` — see the rules above.
 *  `prev` is null on the first pass. */
export function computeArrivals(prev: readonly string[] | null, next: readonly string[]): string[] {
  if (prev === null || prev.length === 0 || next.length === 0) return []
  const known = new Set(prev)
  // The deepest row we already had on screen. Everything past it is the tail.
  let lastKnown = -1
  for (let i = next.length - 1; i >= 0; i--) {
    if (known.has(next[i]!)) {
      lastKnown = i
      break
    }
  }
  if (lastKnown === -1) return []
  const fresh: string[] = []
  for (let i = lastKnown + 1; i < next.length; i++) {
    if (!known.has(next[i]!)) fresh.push(next[i]!)
  }
  return fresh.length > MAX_ARRIVALS ? [] : fresh
}

/**
 * The set of currently-mounted rows that arrived rather than merely rendered.
 *
 * A key stays in the set for as long as its row is mounted, and is never
 * re-added once dropped. That is deliberate: the animation is a CSS one-shot
 * that plays when the element is INSERTED, so the marker only has to be present
 * on the render that mounts the row — but removing it a frame later (this feed
 * re-renders for many reasons) would cancel the animation mid-flight and snap
 * the row to its resting state. Holding the marker costs one string per row and
 * cannot replay: CSS runs an animation once per insertion, not once per render.
 */
export function useFeedArrivals(keys: readonly string[]): ReadonlySet<string> {
  const state = useRef<{
    signature: string
    keys: readonly string[]
    arrived: ReadonlySet<string>
  } | null>(null)
  // NUL-joined because a row id cannot contain one: no two different key
  // lists can collide on the same signature, which is what would make an
  // arrival go unnoticed. Written as an escape so the file stays plain text.
  const signature = keys.join('\u0000')
  const held = state.current
  // Recomputed only when the key list actually changes, which also makes this
  // idempotent under a repeated render pass (StrictMode, a discarded concurrent
  // render): the same input returns the same set rather than consuming it.
  if (held === null) {
    const empty = new Set<string>()
    state.current = { signature, keys, arrived: empty }
    return empty
  }
  if (held.signature === signature) return held.arrived
  const mounted = new Set(keys)
  const arrived = new Set<string>()
  // Prune to what is still on screen, so the set is bounded by the render
  // window rather than by the length of the session.
  for (const key of held.arrived) if (mounted.has(key)) arrived.add(key)
  for (const key of computeArrivals(held.keys, keys)) arrived.add(key)
  state.current = { signature, keys, arrived }
  return arrived
}
