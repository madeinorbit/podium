import type { SessionMeta, TranscriptItem } from '@podium/protocol'
import type { Dispatch, RefObject, SetStateAction } from 'react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { Store } from '@/app/store'
import {
  buildChatRows,
  type ChatBlock,
  type ChatRow,
  dedupeByCursor,
  mergeByCursor,
  pairToolResults,
  reconcileReset,
} from './chat'

// Windowing: a marathon session can hold tens of thousands of items, and
// rendering every one mounts a matching count of (markdown-parsed) DOM
// subtrees — slow to lay out and heavy to keep. Cap the rendered tail and grow it
// in PAGE steps as the user scrolls up; the node count stays bounded no matter how
// long the transcript is. RENDER_WINDOW is the initial/grow-step ROW count (the
// render unit is a ChatRow — consecutive tool calls fold into one batch row).
export const RENDER_WINDOW = 300
// Items in the initial transcript window (the newest N off disk, via
// sessions.transcriptRead). ≤ the protocol's 2000 read cap.
const INITIAL_LIMIT = 1000
// On-demand older-page size fetched off disk when the user scrolls past the items
// already held locally (anchored read, direction 'before').
const PAGE_LIMIT = 400

export interface UseTranscriptWindowOptions {
  sessionId: string
  hub: Store['hub']
  trpc: Store['trpc']
  replica: Store['replica']
  /** Mirrors ChatView's `active` prop — re-reads the window when this pane
   *  becomes the foreground view again (a backgrounded view can fall behind). */
  active: boolean
  session: SessionMeta | undefined
  /** The scroller housing the rendered rows — read (never written) to anchor
   *  scroll position across a prepend; ChatView owns the actual scrolling. */
  scrollerRef: RefObject<HTMLDivElement | null>
}

export interface UseTranscriptWindowResult {
  blocks: ChatBlock[]
  rows: ChatRow[]
  /** Only the trailing window of `rows` — the DOM node count stays bounded for
   *  arbitrarily long transcripts. */
  visibleRows: ChatRow[]
  /** First windowed-in row's absolute index into `rows` (0 when everything
   *  loaded fits in the window). */
  renderStart: number
  /** More rows exist above the current window — already loaded locally (just
   *  windowed out) or still on disk (autoload + prepend). */
  moreAbove: boolean
  hasMoreOlder: boolean
  loadingOlder: boolean
  /** False until the initial read resolves — gates the loader vs "No transcript yet". */
  initialLoaded: boolean
  /** Non-null when the window is the replica's offline copy (epoch ms cached at). */
  offlineAsOf: number | null
  /** Reveal more above the current window: widen it over rows already held
   *  locally, or fetch+prepend the next older page off disk. */
  loadOlder: () => void
  /** Reset or widen the rendered window — e.g. RENDER_WINDOW on session switch,
   *  or to reveal a search match sitting above it. */
  setRenderCount: Dispatch<SetStateAction<number>>
  /** True while pinned to the live tail; scroll effects read AND write this —
   *  it's a plain mutable ref, not hook-internal state. */
  pinnedToBottom: RefObject<boolean>
  /** One-shot guard for the initial snap-to-bottom on first populated render;
   *  also flipped false on every reset (a fresh snapshot re-arms the snap). */
  didInitialScroll: RefObject<boolean>
  /** Set by `loadOlder` just before a prepend lands (its scrollHeight/scrollTop
   *  anchor); ChatView's layout effect reads+clears it to correct scrollTop
   *  once the inserted rows have laid out. */
  prependAnchor: RefObject<{ scrollHeight: number; scrollTop: number } | null>
}

/**
 * Owns the held transcript window for ChatView: an initial disk read (any
 * session status — the single source, not a live-only path) plus a live-delta
 * subscription from the read's tail cursor, scroll-up back-paging, and the
 * derived render pipeline (pairToolResults → buildChatRows → the bounded
 * trailing window). Pure data/paging concerns; the scroll DOM itself
 * (onScroll, the sticky-user header, the minimap, the actual scrollTop
 * writes) stays in ChatView, which is handed the refs it needs to coordinate
 * with (`pinnedToBottom`, `didInitialScroll`, `prependAnchor`).
 */
export function useTranscriptWindow(opts: UseTranscriptWindowOptions): UseTranscriptWindowResult {
  const { sessionId, hub, trpc, replica, active, session, scrollerRef } = opts

  const [items, setItems] = useState<TranscriptItem[]>([])
  // Cursor of the OLDEST loaded item (the read's `head`) — the anchor for
  // scroll-up back-paging. Undefined until the first read resolves or after an
  // empty read.
  const [headCursor, setHeadCursor] = useState<string | undefined>(undefined)
  const [initialLoaded, setInitialLoaded] = useState(false)
  // Non-null when the rendered window is the replica's OFFLINE COPY (the read
  // failed / server unreachable): epoch ms of when that copy was cached, shown
  // as a subtle "offline copy — as of <time>" notice. Cleared by any successful
  // read (docs/spec/thin-client-replica.md §2.3).
  const [offlineAsOf, setOfflineAsOf] = useState<number | null>(null)
  // Older items paged in from disk on scroll-to-top (anchored reads), newest-last.
  // Always a contiguous chunk that sits immediately BEFORE the held `items`, so
  // [...older, ...items] is a clean prefix→suffix of the full on-disk transcript.
  const [older, setOlder] = useState<TranscriptItem[]>([])
  // True while we still believe earlier items exist on disk beyond what's loaded.
  const [hasMoreOlder, setHasMoreOlder] = useState(true)
  const [loadingOlder, setLoadingOlder] = useState(false)
  // How many trailing blocks to render (bounded DOM). Grows in RENDER_WINDOW
  // steps as the user scrolls up; reset per session by the caller.
  const [renderCount, setRenderCount] = useState(RENDER_WINDOW)

  // Head cursor mirrored into a ref so the (stable-identity) paging callback
  // reads the latest anchor without re-binding on every change.
  const headCursorRef = useRef<string | undefined>(undefined)
  headCursorRef.current = headCursor
  const pinnedToBottom = useRef(true)
  const didInitialScroll = useRef(false)
  const prependAnchor = useRef<{ scrollHeight: number; scrollTop: number } | null>(null)
  // Guards re-entrant older-page loads (a single scroll fires onScroll repeatedly).
  const loadingOlderRef = useRef(false)

  // Mirror the live sessionId so an in-flight read can bail if the session
  // switched out from under it (the held window now belongs to a different
  // session).
  const sessionIdRef = useRef(sessionId)
  sessionIdRef.current = sessionId

  // Read the newest window off disk and reconcile it into the held window — never a
  // blind replace. `reconcileReset` keeps any live-tailed in-flight record the disk
  // re-read dropped, and refuses to wipe a populated view on an empty/failed read,
  // so the newest messages can't flash in then vanish on a reattach re-seed (e.g.
  // after a server/daemon redeploy). Stable identity (keyed on session) so other
  // effects can call it to refresh the window without re-mounting the subscription.
  const readNewest = useCallback(async () => {
    const sid = sessionId
    const r = await trpc.sessions.transcriptRead.query({
      sessionId: sid,
      direction: 'before',
      limit: INITIAL_LIMIT,
    })
    if (sessionIdRef.current !== sid) return r // session switched mid-read — drop it
    setItems((prev) => reconcileReset(prev, r.items, r.tail))
    setOlder([])
    setHeadCursor(r.head)
    setHasMoreOlder(r.hasMore)
    setInitialLoaded(true)
    // A fresh read is server truth again — drop the offline-copy notice and
    // write the window through into the replica so an offline reopen can serve
    // it (bounded per spec §2.3; a no-op when persistence is unavailable).
    setOfflineAsOf(null)
    // Optional-chained: some test harnesses mock a partial store without a replica.
    if (r.items.length > 0) replica?.putTranscriptWindow(sid, r.items)
    return r
  }, [trpc, sessionId, replica])

  // Read-then-subscribe: the single source of the transcript window for ANY
  // status. (1) Read the newest window off disk via tRPC — this alone populates a
  // LIVE session even if the hub never yields a live delta (the loading-bug fix).
  // (2) Subscribe to live deltas FROM the read's tail cursor, merging each delta
  // in by cursor (dedup vs the read window). A `reset` delta (file roll / reattach
  // re-seed) re-reads the newest window. Keyed on the session so it tears down and
  // re-runs on switch.
  useEffect(() => {
    let cancelled = false
    let unsub = () => {}
    // Fresh per-session state — clear before the async read so a stale window from
    // the previous session never flashes.
    setItems([])
    setOlder([])
    setHasMoreOlder(true)
    setHeadCursor(undefined)
    setInitialLoaded(false)
    setOfflineAsOf(null)
    setLoadingOlder(false)
    setRenderCount(RENDER_WINDOW)
    loadingOlderRef.current = false
    pinnedToBottom.current = true
    didInitialScroll.current = false

    ;(async () => {
      const r = await readNewest()
      if (cancelled) return
      unsub = hub.subscribeTranscript(sessionId, r.tail, (delta, meta) => {
        if (meta.reset) {
          // A re-seed (reattach after a redeploy, server cache rebuild, or a real
          // file roll). Re-pin and re-read the newest window; `readNewest` reconciles
          // rather than replaces, so a same-conversation re-seed can't drop the
          // in-flight tail, while a genuine roll still swaps to the new file.
          pinnedToBottom.current = true
          didInitialScroll.current = false
          void readNewest().catch(() => {}) // transient failure — keep the held window
          return
        }
        setItems((prev) => mergeByCursor(prev, delta))
      })
    })().catch(() => {
      // The read failed (server/daemon unreachable — e.g. the PWA opened
      // offline, or the hub is disconnected and tRPC is down with it). Serve
      // the replica's cached window with the offline-copy notice instead of a
      // blank shell; without a cache, settle to the empty/"No transcript yet"
      // state as before. Online behavior is untouched — this is the catch path.
      if (cancelled) return
      const cached = replica?.transcriptWindow(sessionId)
      if (cached !== undefined && cached.items.length > 0) {
        setItems(cached.items)
        // No back-paging against a dead server; the cache IS the window.
        setHasMoreOlder(false)
        setOfflineAsOf(cached.savedAt)
      }
      setInitialLoaded(true)
    })

    return () => {
      cancelled = true
      unsub()
    }
  }, [hub, sessionId, trpc, readNewest, replica])

  // Re-read the newest window at the two moments the held window can silently go
  // stale, both of which the sticky read-then-subscribe above can miss:
  //   (a) the session waking from a parked state into live — a resume may fork to a
  //       fresh transcript file the existing subscription wasn't watching, so
  //       without a re-read the chat shows empty right after a resume; and
  //   (b) this chat becoming the active/foreground view again — a backgrounded view
  //       can fall behind if a delta was missed.
  // `readNewest` reconciles (never blind-replaces), so an extra refresh can only
  // add or correct rows, never wipe the window.
  const prevLive = useRef(session?.status === 'live' || session?.status === 'starting')
  const prevActive = useRef(active)
  useEffect(() => {
    const nowLive = session?.status === 'live' || session?.status === 'starting'
    const wokeToLive = nowLive && !prevLive.current
    const becameActive = active && !prevActive.current
    prevLive.current = nowLive
    prevActive.current = active
    if (!initialLoaded) return // the read-then-subscribe effect owns the first load
    if (wokeToLive || becameActive) void readNewest().catch(() => {}) // keep the held window
  }, [session?.status, active, initialLoaded, readNewest])

  // The full loaded list: older pages prepended to the held window. A small
  // cursor-dedupe at the seam guards a one-item paging/live overlap.
  const effectiveItems = useMemo(
    () => (older.length > 0 ? dedupeByCursor([...older, ...items]) : items),
    [older, items],
  )
  const blocks = useMemo(() => pairToolResults(effectiveItems), [effectiveItems])
  // Render unit: consecutive tool calls fold into one collapsed batch row; the
  // minimap, scroll-to-match, and [data-block] indices are all keyed by ROW.
  const rows = useMemo(() => buildChatRows(blocks), [blocks])
  // Render only the trailing window of ROWS so the DOM node count stays bounded
  // for arbitrarily long transcripts. `renderStart` is the first windowed-in row;
  // the row index passed to each view stays absolute into `rows` (renderStart + ri)
  // so the minimap, scroll-to-match (activeRow), and [data-block] line up.
  const renderStart = Math.max(0, rows.length - renderCount)
  const visibleRows = renderStart > 0 ? rows.slice(renderStart) : rows
  // More rows exist above the current window: either already loaded locally
  // (just reveal them) or still on disk (autoload + prepend). Drives the top
  // sentinel + the scroll trigger.
  const moreAbove = renderStart > 0 || hasMoreOlder

  // Reveal more above the current window: first grow the render window over rows
  // we already hold locally; once those run out, fetch the next older page off disk
  // and prepend it. Captures the scroll geometry first so the anchoring layout
  // effect (in ChatView) can keep the view from jumping when the inserted height lands.
  const loadOlder = useCallback(() => {
    if (loadingOlderRef.current) return
    const el = scrollerRef.current
    // More rows already loaded but windowed out → just widen the window.
    if (renderStart > 0) {
      if (el) prependAnchor.current = { scrollHeight: el.scrollHeight, scrollTop: el.scrollTop }
      setRenderCount((c) => c + RENDER_WINDOW)
      return
    }
    // Nothing left to reveal locally and nothing more on disk → done.
    if (!hasMoreOlder) return
    // No anchor to page before (read hasn't resolved yet / empty) → nothing to do.
    const anchor = headCursorRef.current
    if (!anchor) return
    loadingOlderRef.current = true
    setLoadingOlder(true)
    if (el) prependAnchor.current = { scrollHeight: el.scrollHeight, scrollTop: el.scrollTop }
    // Cursor-anchored back-page: read the window immediately BEFORE the oldest
    // loaded item (`headCursor`). No `fromEnd` index math — the cursor anchors the
    // slice exactly, so there's no gap/overlap as the held window grows.
    trpc.sessions.transcriptRead
      .query({ sessionId, anchor, direction: 'before', limit: PAGE_LIMIT })
      .then((r) => {
        if (r.items.length > 0) {
          setOlder((prev) => [...r.items, ...prev])
          // Advance the back-paging anchor to the new oldest item. A page can come
          // back empty-of-new-head only if it was empty; guard with `?? anchor`.
          setHeadCursor(r.head ?? anchor)
          // Keep the freshly-prepended page rendered (don't let the window slice
          // it straight back off). `renderCount` is a ROW count and the page is in
          // raw items; items fold into ≤ items rows, so adding the item count is a
          // safe over-estimate (renderStart clamps at 0 / the row total).
          setRenderCount((c) => c + r.items.length)
        }
        setHasMoreOlder(r.hasMore)
      })
      .catch(() => {
        // Leave hasMoreOlder as-is so a transient failure can be retried by
        // scrolling again; just clear the anchor so we don't mis-restore.
        prependAnchor.current = null
      })
      .finally(() => {
        loadingOlderRef.current = false
        setLoadingOlder(false)
      })
  }, [renderStart, hasMoreOlder, trpc, sessionId, scrollerRef])

  return {
    blocks,
    rows,
    visibleRows,
    renderStart,
    moreAbove,
    hasMoreOlder,
    loadingOlder,
    initialLoaded,
    offlineAsOf,
    loadOlder,
    setRenderCount,
    pinnedToBottom,
    didInitialScroll,
    prependAnchor,
  }
}
