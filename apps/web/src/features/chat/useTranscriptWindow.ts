import { isSwitchTraced, markSwitch } from '@podium/client-core/perf'
import { applyChatVerbosity, type ChatVerbosity } from '@podium/client-core/viewmodels'
import type { SessionId, SessionMeta, TranscriptItem } from '@podium/model/browser'
import type { TranscriptSearchState } from '@podium/client-core/viewmodels'
import type { Dispatch, RefObject, SetStateAction } from 'react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { Store } from '@/app/store'
import {
  type ChatBlock,
  type ChatRow,
  dedupeByCursor,
  freshOlderPage,
  itemKey,
  mergeByCursor,
  reconcileReset,
  sameItems,
} from './chat'
import {
  transcriptComputeClient,
  type WebTranscriptComputeResult,
} from './transcript-compute-client'

// Windowing: a marathon session can hold tens of thousands of items, and
// rendering every one mounts a matching count of (markdown-parsed) DOM
// subtrees — slow to lay out and heavy to keep. Cap the rendered tail and grow it
// in PAGE steps as the user scrolls up; the node count stays bounded no matter how
// long the transcript is. RENDER_WINDOW is the initial/grow-step ROW count (the
// render unit is a ChatRow — consecutive tool calls fold into one batch row).
export const RENDER_WINDOW = 300
// Items in the initial transcript window (the newest N off disk, via
// sessions.transcriptRead). ≤ the protocol's 2000 read cap.
//
// Sized for TIME-TO-FIRST-PAINT, not for recall [POD-1631]. Measured over 8 real
// transcripts (8-94MB), uncached, with POD-1627's extend fix in place: 1000 costs
// p50 69ms / p99 135ms; 200 costs p50 21ms / p99 60ms — inside the ~50ms
// interactive budget, and the knee (100 saves another 10ms at p50 but p99 turns
// back UP). It is also exactly REPLICA_TRANSCRIPT_ITEM_CAP, so the offline
// write-through at `putTranscriptWindow` below keeps the depth it always had: it
// has always sliced to the newest 200, which made the other 800 items of the old
// read pure waste. What the smaller window DOES cost is search recall, which runs
// over LOADED blocks — `ensureSearchDepth` below buys that depth back on demand.
const INITIAL_LIMIT = 200
// On-demand older-page size fetched off disk when the user scrolls past the items
// already held locally (anchored read, direction 'before').
const PAGE_LIMIT = 400
// How deep the loaded window is back-paged when the user opens search. Search
// matches only what is LOADED, so the initial window's paint-sized depth would
// silently narrow recall; deepening to the depth every open used to load eagerly
// keeps recall identical to before POD-1631 while only searchers pay for it.
const SEARCH_DEPTH = 1000
// The floor under a live foreground chat [POD-701]: how often it reconciles its
// window against disk when nothing on the session row has moved. Long enough
// that an idle pane is not polling in any meaningful sense (one newest-item
// tail probe, with a full reconcile only when that tail changed), short enough
// that a reader never sits in front of a silent feed wondering whether the
// agent is alive.
export const LIVE_HEARTBEAT_MS = 6_000

const EMPTY_TRANSCRIPT_SEARCH: TranscriptSearchState = {
  matches: [],
  activeMatch: undefined,
  activeRow: undefined,
  position: 0,
  total: 0,
  filtering: false,
}
const EMPTY_MARKDOWN_HTML: ReadonlyMap<string, string> = new Map()

export interface UseTranscriptWindowOptions {
  sessionId: SessionId
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
  /** How much of the transcript to render (POD-376). Applied HERE, at the one
   *  place rows are built, so the window, the search cursor and the minimap
   *  cannot disagree about which rows exist. `normal` (the default) filters
   *  nothing, so this is inert until someone changes it. */
  verbosity?: ChatVerbosity
  /** Search is part of the same worker/index request as block shaping. */
  query?: string
  cursor?: number
}

export interface UseTranscriptWindowResult {
  blocks: ChatBlock[]
  rows: ChatRow[]
  /** Search over the same worker-produced block/row graph. */
  search: TranscriptSearchState
  /** Unsafe HTML from the worker, keyed by source Markdown. The feed sanitizes
   * it on the browser thread immediately before DOM insertion. */
  markdownHtml: ReadonlyMap<string, string>
  /** False only while the first worker/index result for this read is pending. */
  computeReady: boolean
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
  /** True while the search deepen is still back-paging — the match count on screen
   *  is over a window that is still growing. */
  deepeningSearch: boolean
  /** False until the initial read resolves — gates the loader vs "No transcript yet". */
  initialLoaded: boolean
  /** Non-null when the window is the replica's offline copy (epoch ms cached at). */
  offlineAsOf: number | null
  /** Reveal more above the current window: widen it over rows already held
   *  locally, or fetch+prepend the next older page off disk. */
  loadOlder: () => void
  /** Deepen the LOADED (not rendered) window to search depth — call when the user
   *  opens search, since matching is scoped to what is loaded. Idempotent per session. */
  ensureSearchDepth: () => void
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
 * worker-backed transcript index that supplies the bounded trailing window.
 * Pure data/paging concerns; the scroll DOM itself
 * (onScroll, the sticky-user header, the minimap, the actual scrollTop
 * writes) stays in ChatView, which is handed the refs it needs to coordinate
 * with (`pinnedToBottom`, `didInitialScroll`, `prependAnchor`).
 */
export function useTranscriptWindow(opts: UseTranscriptWindowOptions): UseTranscriptWindowResult {
  const {
    sessionId,
    hub,
    trpc,
    replica,
    active,
    session,
    scrollerRef,
    verbosity = 'normal',
    query = '',
    cursor = 0,
  } = opts

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
  const [computed, setComputed] = useState<{
    items: TranscriptItem[]
    verbosity: ChatVerbosity
    query: string
    cursor: number
    result: WebTranscriptComputeResult
  } | null>(null)
  // True while `ensureSearchDepth` is still back-paging: the match count on screen
  // is over a window that is still growing, and the search bar says so.
  const [deepeningSearch, setDeepeningSearch] = useState(false)
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
  // `hasMoreOlder` mirrored for `ensureSearchDepth`'s loop, which must see each
  // page's answer before React commits it — same render-time ref-mirror pattern as
  // headCursorRef. Written by the paging paths as well as by this render.
  const hasMoreOlderRef = useRef(true)
  hasMoreOlderRef.current = hasMoreOlder
  // One-shot per session: the search deepen has already run (or is running), so a
  // second search on the same transcript doesn't re-page a window that's already deep.
  const deepenedRef = useRef(false)

  // Window health [POD-725]: true only while the held window is trustworthy for a
  // skip-the-re-read warm activation — it's NON-EMPTY and its live subscription has
  // stayed intact (no reset, no teardown, no read failure / offline copy) since the
  // last successful read. A backgrounded-but-subscribed panel keeps catching deltas,
  // so an intact window is already current; a broken one is potentially stale and
  // must be re-read. Invalidated on every reset delta, subscription teardown, empty
  // read, and the offline/replica fallback; restored by a successful non-empty read.
  const windowHealthy = useRef(false)
  // Held-window length mirrored into a ref so the activation effect can stamp the
  // cache-hit mark's item count without depending on `items` (which would re-run it
  // on every delta). Same render-time ref-mirror pattern as headCursorRef above.
  const windowLenRef = useRef(0)
  windowLenRef.current = items.length
  // The heartbeat only needs to answer "does disk have a tail we have not
  // seen?" Keep the held window in a ref so its one-item probe can compare
  // without binding the probe callback to every live delta.
  const heldItemsRef = useRef<TranscriptItem[]>([])
  heldItemsRef.current = items

  // Mirror the live sessionId so an in-flight read can bail if the session
  // switched out from under it (the held window now belongs to a different
  // session).
  const sessionIdRef = useRef(sessionId)
  sessionIdRef.current = sessionId

  // The session row's activity fingerprint [POD-701], mirrored at render time so
  // `readNewest` can stamp "the window is current as of this" without taking it
  // as a dependency (which would re-bind the callback on every agent tick and
  // tear down the read-then-subscribe effect with it). See the liveness
  // reconcile below for what reads them.
  const activitySignalRef = useRef('')
  const reconciledSignalRef = useRef<string | null>(null)
  // A slow daemon read must not turn the activity debounce and heartbeat into
  // overlapping 200-item responses. Scheduled calls for the same session share
  // one reconcile; lifecycle boundaries (initial load, reset, activation) force
  // their own read because each establishes a fresh subscription/window epoch.
  const reconcileInFlightRef = useRef<{
    sessionId: SessionId
    promise: Promise<{
      items: TranscriptItem[]
      head?: string
      tail?: string
      hasMore: boolean
    }>
  } | null>(null)
  const probeInFlightRef = useRef<{ sessionId: SessionId; promise: Promise<void> } | null>(null)

  // Read the newest window off disk and reconcile it into the held window — never a
  // blind replace. `reconcileReset` keeps any live-tailed in-flight record the disk
  // re-read dropped, and refuses to wipe a populated view on an empty/failed read,
  // so the newest messages can't flash in then vanish on a reattach re-seed (e.g.
  // after a server/daemon redeploy). Stable identity (keyed on session) so other
  // effects can call it to refresh the window without re-mounting the subscription.
  const readNewest = useCallback(
    (force = false) => {
      const sid = sessionId
      const current = reconcileInFlightRef.current
      if (!force && current?.sessionId === sid) return current.promise
      const promise = (async () => {
        // These marks intentionally enclose only the awaited tRPC read. The interval
        // therefore includes browser↔server transport and response decoding; JS/React
        // materialization is measured separately by `chat:rows-built` below.
        markSwitch(sid, 'transcript:read-start')
        const r = await trpc.sessions.transcriptRead.query({
          sessionId: sid,
          direction: 'before',
          limit: INITIAL_LIMIT,
        })
        markSwitch(sid, 'transcript:read-end', { items: r.items.length })
        if (sessionIdRef.current !== sid) return r // session switched mid-read — drop it
        // This read IS the window being brought current, whatever the session row
        // says right now — so the liveness reconcile has nothing left to chase.
        reconciledSignalRef.current = activitySignalRef.current
        // Keep the OLD array when the re-read changed nothing (POD-701): a refresh
        // that returns the same transcript must cost nothing, or the liveness
        // reconcile below would re-derive and re-render the whole feed on a timer.
        setItems((prev) => {
          const next = reconcileReset(prev, r.items, r.tail)
          return sameItems(prev, next) ? prev : next
        })
        // Identity-preserving when there is nothing to clear, for the same reason:
        // a fresh `[]` re-runs the `effectiveItems` memo on every refresh.
        setOlder((prev) => (prev.length === 0 ? prev : []))
        setHeadCursor(r.head)
        setHasMoreOlder(r.hasMore)
        setInitialLoaded(true)
        // A fresh read is server truth again — drop the offline-copy notice and
        // write the window through into the replica so an offline reopen can serve
        // it (bounded per spec §2.3; a no-op when persistence is unavailable).
        setOfflineAsOf(null)
        // A fresh, non-empty server read with the subscription intact is a healthy
        // window a later warm activation can reuse; an empty read is not (nothing to
        // paint from — the next activation must re-read).
        windowHealthy.current = r.items.length > 0
        // Optional-chained: some test harnesses mock a partial store without a replica.
        if (r.items.length > 0) replica?.putTranscriptWindow(sid, r.items)
        return r
      })()
      const entry = { sessionId: sid, promise }
      reconcileInFlightRef.current = entry
      const clear = (): void => {
        if (reconcileInFlightRef.current === entry) reconcileInFlightRef.current = null
      }
      void promise.then(clear, clear)
      return promise
    },
    [trpc, sessionId, replica],
  )

  // The fixed heartbeat used to deserialize the full 200-item window every six
  // seconds even when the WebSocket feed was healthy. A one-item newest-tail
  // read is enough to prove the held window current. Only a missing or changed
  // tail escalates to the full reconcile, preserving the dropped-feed recovery
  // while making the steady state one tiny response. Probes are single-flight;
  // a slow daemon cannot accumulate timer work behind the main thread.
  const probeNewest = useCallback((): Promise<void> => {
    const sid = sessionId
    if (reconcileInFlightRef.current?.sessionId === sid) return Promise.resolve()
    const current = probeInFlightRef.current
    if (current?.sessionId === sid) return current.promise
    const promise = (async () => {
      const r = await trpc.sessions.transcriptRead.query({
        sessionId: sid,
        direction: 'before',
        limit: 1,
      })
      if (sessionIdRef.current !== sid) return
      const remote = r.items.at(-1)
      if (remote === undefined) return
      const held = heldItemsRef.current.find((item) => itemKey(item) === itemKey(remote))
      if (held !== undefined && sameItems([held], [remote])) return
      await readNewest()
    })()
    const entry = { sessionId: sid, promise }
    probeInFlightRef.current = entry
    const clear = (): void => {
      if (probeInFlightRef.current === entry) probeInFlightRef.current = null
    }
    void promise.then(clear, clear)
    return promise
  }, [readNewest, sessionId, trpc])

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
    setComputed(null)
    setDeepeningSearch(false)
    setRenderCount(RENDER_WINDOW)
    loadingOlderRef.current = false
    hasMoreOlderRef.current = true
    // A different transcript starts shallow again — the next search re-deepens.
    deepenedRef.current = false
    pinnedToBottom.current = true
    didInitialScroll.current = false
    // Fresh session → no trustworthy window yet; the read below restores health.
    windowHealthy.current = false

    // CACHE-FIRST [POD-700]. Every successful read above already writes its window
    // through to the replica, and the catch path below already serves that copy
    // when the server is unreachable — but a REACHABLE server left this pane with
    // nothing to paint for the whole duration of the read, measured on the live
    // instance at p50 545ms and up to 8.7s on a cold panel open. Seeding the cached
    // window synchronously, before the await, makes reopening a session real
    // content on the FIRST frame and turns the read into a refresh that
    // `reconcileReset` folds in: an unmoved tail keeps the snapshot unchanged, a
    // moved one adopts it verbatim. For a hibernated session the cache is not even
    // approximate — the process is stopped, so nothing can have been appended.
    //
    // Three things this deliberately does NOT set, each of which would be a
    // different claim than "here is what we read last time":
    //   `initialLoaded` — the READ owns that answer. A conversation that is
    //     genuinely empty must still resolve to "No transcript yet", and a cache
    //     cannot settle a question it was never asked.
    //   `offlineAsOf`   — that notice means the server could not be reached. It is
    //     the offline path's signal and stays there; we are online and early.
    //   `windowHealthy` — a cached window has no live subscription behind it, so a
    //     later warm re-activation must still re-read rather than skip.
    const cachedSeed = replica?.transcriptWindow(sessionId)
    if (cachedSeed !== undefined && cachedSeed.items.length > 0) setItems(cachedSeed.items)

    ;(async () => {
      const r = await readNewest(true)
      if (cancelled) return
      unsub = hub.subscribeTranscript(sessionId, r.tail, (delta, meta) => {
        if (meta.reset) {
          // A re-seed (reattach after a redeploy, server cache rebuild, or a real
          // file roll). Re-pin and re-read the newest window; `readNewest` reconciles
          // rather than replaces, so a same-conversation re-seed can't drop the
          // in-flight tail, while a genuine roll still swaps to the new file.
          pinnedToBottom.current = true
          didInitialScroll.current = false
          // A reset breaks subscription continuity — the held cursors may no longer
          // be current, so the window is no longer skip-safe until the re-read heals it.
          windowHealthy.current = false
          void readNewest(true).catch(() => {}) // transient failure — keep the held window
          return
        }
        // A delivered delta proves the held window is current through this
        // activity signal. Re-check in the debounce callback below so a row
        // update and its transcript delta collapse to the live-feed fast path.
        reconciledSignalRef.current = activitySignalRef.current
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
      // A replica-served window is potentially stale (the server was unreachable),
      // so it must NOT be reused on a warm activation — force a real re-read next time.
      windowHealthy.current = false
      setInitialLoaded(true)
    })

    return () => {
      cancelled = true
      // The live subscription is gone; whatever it was feeding can no longer be
      // trusted as current until a fresh read + resubscribe restores it.
      windowHealthy.current = false
      unsub()
    }
  }, [hub, sessionId, readNewest, replica])

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
    // [POD-725] Warm-switch fast path: a pure re-activation (not a resume waking the
    // session, which can fork a new transcript file) whose held window is healthy —
    // non-empty and its live subscription unbroken since the last read — reuses the
    // held window instead of re-reading 1000 items off disk. `chat:cache-hit` records
    // the skip so a switch trace can tell the two paths apart (its absence of
    // transcript:read-start/read-end IS the signal that no read happened); the
    // paint mark chat:first-paint still fires from the paint effect below, which
    // keys off `active`; ChatView owns the later chat:interactable boundary.
    // Gated on isSwitchTraced so this remains inert outside a traced switch.
    if (becameActive && !wokeToLive && windowHealthy.current) {
      if (isSwitchTraced(sessionId))
        markSwitch(sessionId, 'chat:cache-hit', { items: windowLenRef.current })
      // WHAT A HEALTHY WINDOW ACTUALLY PROVES [POD-1132]. `windowHealthy` says
      // the last read succeeded and nothing has torn the subscription down since
      // — NOT that a single delta ever arrived on it. The stream is
      // `stream.live`, which the wire classifies as lossy on purpose ("Loss on
      // disconnect is fine … Never healed"), so "the subscription is intact" and
      // "the window is current" are different claims, and this path used to make
      // the second one on the evidence of the first. A pane that quietly stopped
      // receiving frames while it was hidden then REVEALED stale, and the stamp
      // below suppressed the one reconcile that would have caught it.
      //
      // The session row settles it for free. `reconciledSignalRef` is the row
      // fingerprint as of the last moment the window was known current; if the
      // row has not moved since, nothing has happened for the feed to have
      // missed and the skip is sound.
      const signal = activitySignalRef.current
      if (reconciledSignalRef.current === signal) return
      // The row HAS moved and no delta accounted for it, so the window is
      // behind. Keep POD-725's win anyway — do NOT fall through to the
      // 200-item read — and settle it with the one-item tail probe, which
      // escalates to a full reconcile only when disk is genuinely ahead.
      // Stamped first so the 400ms liveness reconcile does not ALSO chase this
      // same signal with the very read the probe exists to avoid; a probe that
      // finds a difference re-stamps correctly through `readNewest`.
      reconciledSignalRef.current = signal
      void probeNewest().catch(() => {}) // transient failure — the heartbeat retries
      return
    }
    if (wokeToLive || becameActive) void readNewest(true).catch(() => {}) // keep the held window
  }, [session?.status, active, initialLoaded, readNewest, probeNewest, sessionId])

  // -------------------------------------------------------------------------
  // THE FEED MUST NOT GO QUIET [POD-701]
  // -------------------------------------------------------------------------
  // Everything above assumes the live subscription delivers every item. When it
  // does not — a delta dropped on a reconnect, a tailer that re-seeded without
  // announcing a reset, a harness whose observer only emits on hook boundaries —
  // the chat sits there showing nothing while the SIDEBAR, driven by the same
  // session rows, visibly ticks over. The reader's only recourse was to leave
  // the view and come back, because unmounting the panel is what forces a fresh
  // read; that is a bug report we should never have needed.
  //
  // So the window reconciles against two signals it already receives for free:
  //
  //   the SESSION ROW  `lastActiveAt` / phase / busy advance on exactly the
  //                    activity a transcript is supposed to be recording. When
  //                    they move and the feed did not, the feed is behind.
  //   a HEARTBEAT      a slow floor under the foreground pane while the session
  //                    is live, for activity that moves nothing on the row.
  //
  // Both go through `readNewest`, which RECONCILES rather than replaces, and
  // whose `sameItems` guard makes a no-op refresh keep the previous array — so
  // a reconcile that finds nothing new costs one query and zero renders. Only
  // the ACTIVE pane pays anything; a backgrounded chat keeps its subscription
  // and re-reads on activation as before.
  //
  // ONE THING IT MUST NOT DO: run while the reader IS READING HISTORY.
  // `readNewest` drops `older` — correct on a switch or a file roll, ruinous
  // under someone's scroll, because it would throw away the pages they just
  // paged in and take their position with it.
  //
  // WHERE THE READER IS LOOKING, NOT WHAT HAPPENS TO BE LOADED [POD-1132]. That
  // stand-down used to key on `pagedBack` alone, and `older` is only ever
  // cleared BY a tail re-read — so the one condition that suppressed the
  // re-read was also the only thing the re-read could clear. Scrolling up once
  // therefore latched BOTH self-healing paths off for the rest of the mount,
  // and the pane ran on the lossy delta stream alone with no recovery. The
  // escape hatch the original reasoning named — "the next activation re-reads
  // as it always did" — stopped existing when POD-725 taught activation to skip
  // the read.
  //
  // A reader pinned to the live tail has nothing above them to protect: the
  // pages being dropped are off-screen, and the bottom pin survives the
  // shrink (ChatView's ResizeObserver re-pins). So the stand-down lasts exactly
  // as long as they are away from the tail. Read at CALL time, never mirrored at
  // render time: `pinnedToBottom` is a scroll-driven ref that moves without a
  // render, so a render-time copy would be stale precisely when it matters.
  const readNewestRef = useRef(readNewest)
  readNewestRef.current = readNewest
  const live = session?.status === 'live' || session?.status === 'starting'
  const pagedBack = older.length > 0
  const pagedBackRef = useRef(false)
  pagedBackRef.current = pagedBack
  const readingHistory = useCallback(
    () => pagedBackRef.current && !pinnedToBottom.current,
    // Both are refs owned by this hook — stable for the life of the mount.
    [],
  )
  // One string, so the effect re-runs on any of the four moving parts without
  // four dependencies that each re-run it on the others' changes.
  const activitySignal = `${session?.lastActiveAt ?? ''}|${session?.agentState?.phase ?? ''}|${session?.agentState?.since ?? ''}|${session?.busy ?? ''}`
  activitySignalRef.current = activitySignal
  useEffect(() => {
    if (!active || !initialLoaded) return
    if (readingHistory()) return
    // The signal as of the last moment the window was KNOWN current — stamped by
    // every completed read and by the warm-activation cache hit. Comparing
    // against it rather than against the previous render is what keeps POD-725's
    // skipped re-read skipped: a warm switch that reused a healthy window has
    // not fallen behind, so it must not turn into a read 400ms later.
    if (reconciledSignalRef.current === activitySignal) return
    // Trailing debounce: a working agent moves these fields several times a
    // second, and the point is to be current, not to re-read once per tick.
    const t = setTimeout(() => {
      // Re-asked here, not just above: the reader can scroll into history during
      // the 400ms, and this is the callback that would drop it under them.
      if (readingHistory()) return
      if (reconciledSignalRef.current === activitySignal) return
      void readNewestRef.current().catch(() => {})
    }, 400)
    return () => clearTimeout(t)
  }, [active, initialLoaded, activitySignal, readingHistory])
  useEffect(() => {
    if (!active || !initialLoaded || !live) return
    if (typeof document === 'undefined') return
    // The stand-down is checked per TICK rather than taken as a dependency, so
    // paging a page in and out does not tear the interval down and rebuild it.
    const beat = setInterval(() => {
      if (readingHistory()) return
      void probeNewest().catch(() => {})
    }, LIVE_HEARTBEAT_MS)
    // A tab that was hidden may have had its timers throttled to nothing and
    // its socket dropped; coming back is the moment to be sure.
    const onVisible = (): void => {
      if (document.visibilityState !== 'visible') return
      // Same protection as the timer: this one goes STRAIGHT to the full read,
      // so a reader who left the tab mid-scroll must not come back to a feed
      // that has thrown their history away.
      if (readingHistory()) return
      void readNewestRef.current(true).catch(() => {})
    }
    document.addEventListener('visibilitychange', onVisible)
    return () => {
      clearInterval(beat)
      document.removeEventListener('visibilitychange', onVisible)
    }
  }, [active, initialLoaded, live, probeNewest, readingHistory])

  // The full loaded list: older pages prepended to the held window. A small
  // cursor-dedupe at the seam guards a one-item paging/live overlap.
  const effectiveItems = useMemo(
    () => (older.length > 0 ? dedupeByCursor([...older, ...items]) : items),
    [older, items],
  )
  // Mirrored into a ref so the (stable-identity) paging callback can filter a page
  // against the CURRENT loaded window without re-binding on every delta — same
  // render-time ref-mirror pattern as headCursorRef above.
  const loadedRef = useRef<TranscriptItem[]>([])
  loadedRef.current = effectiveItems
  // The loaded item array is the request identity. A refresh that preserves
  // `sameItems` keeps this identity and therefore keeps the worker result too.
  // New data/query/cursor posts one serializable request; stale responses are
  // rejected by the effect cleanup and never replace a newer transcript.
  const computeInput = useMemo(
    () => ({ items: effectiveItems, verbosity, query, cursor }),
    [effectiveItems, verbosity, query, cursor],
  )
  const computeClient = transcriptComputeClient()
  useEffect(() => {
    let cancelled = false
    const input = computeInput
    if (!computeClient.usesWorker) {
      setComputed({ ...input, result: computeClient.computeOnMain(input) })
      return () => {
        cancelled = true
      }
    }
    void computeClient.compute(input).then(
      (result) => {
        if (cancelled) return
        setComputed({ ...input, result })
      },
      () => {
        // A construction/runtime failure should never blank the transcript.
        // Preserve the same data contract and fall back to the pure index; the
        // row renderer will use its existing main-thread Markdown path when no
        // worker HTML is available.
        if (cancelled) return
        setComputed({ ...input, result: computeClient.computeOnMain(input) })
      },
    )
    return () => {
      cancelled = true
    }
  }, [computeClient, computeInput, sessionId])

  const blocks = computed?.result.blocks ?? []
  const rows = computed?.result.rows ?? []
  const search = computed?.result.search ?? EMPTY_TRANSCRIPT_SEARCH
  const markdownHtml = computed?.result.markdownHtml ?? EMPTY_MARKDOWN_HTML
  // Keep the previous graph on screen while a fresher index/search result is in
  // flight. Readiness gates only the first result for this session; tying it to
  // query freshness makes a genuinely empty transcript flash back to “loading”
  // on every search keystroke even though its initial read is complete.
  const computeReady = computed !== null

  // Switch-latency trace marks [POD-701] — both no-ops unless a switch to this
  // session is being traced. `chat:rows-built` stamps the commit in which the
  // derived rows landed.
  useEffect(() => {
    markSwitch(sessionId, 'chat:rows-built', { rows: rows.length })
  }, [sessionId, rows])
  // `chat:first-paint`: the browser has painted the loaded rows — a double rAF
  // after the rows-built commit (the second rAF runs after the first frame with
  // the new content is on screen). Warm switches (rows already loaded) mark on
  // becoming active instead; the isSwitchTraced gate keeps this inert (no rAF
  // scheduling) outside a traced switch, and markSwitch records first-paint at
  // most once per trace.
  useEffect(() => {
    if (!active || !initialLoaded || !isSwitchTraced(sessionId)) return
    // Deliberately NOT cancelled on re-run: a hot stream can change `rows`
    // faster than two frames, and cancelling would starve the mark forever.
    // Extra fires are deduped by markSwitch (first-paint records once/trace).
    const painted = rows.length
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        markSwitch(sessionId, 'chat:first-paint', { paintedRows: painted })
      })
    })
  }, [active, initialLoaded, sessionId, rows])
  // Render only the trailing window of ROWS so the DOM node count stays bounded
  // for arbitrarily long transcripts. `renderStart` is the first windowed-in row;
  // the row index passed to each view stays absolute into `rows` (renderStart + ri)
  // so the minimap, scroll-to-match (activeRow), and [data-block] line up.
  const renderStart = Math.max(0, rows.length - renderCount)
  const visibleRows = renderStart > 0 ? rows.slice(renderStart) : rows
  // More rows exist above the current window: either already loaded locally
  // (just reveal them) or still on disk (autoload + prepend). Drives the top
  // sentinel + the scroll trigger.
  //
  // "On disk" requires the ANCHOR to reach them, and `headCursor` only arrives
  // with the read. Before POD-700 that was academic — the pager renders only over
  // loaded blocks, and no blocks could exist before the read resolved. A
  // cache-first window can, so without this the seeded pane offers "Earlier
  // transcript · click to retry" for a page `loadOlder` would refuse for want of
  // an anchor. Rows held locally are still revealable; only the disk half waits.
  const moreAbove = renderStart > 0 || (hasMoreOlder && headCursor !== undefined)

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
        // Only items we do NOT already hold can be earlier than the window. A page
        // that is entirely held is the reader's rolled-away-anchor fallback (the
        // NEWEST window, not an older page) — prepending it would push newer items
        // above older ones, so treat it as "nothing earlier reachable" [POD-341].
        const fresh = freshOlderPage(r.items, loadedRef.current)
        if (fresh.length > 0) {
          setOlder((prev) => [...fresh, ...prev])
          // Advance the back-paging anchor to the new oldest item. A page can come
          // back empty-of-new-head only if it was empty; guard with `?? anchor`.
          setHeadCursor(fresh[0]?.cursor ?? r.head ?? anchor)
          // Keep the freshly-prepended page rendered (don't let the window slice
          // it straight back off). `renderCount` is a ROW count and the page is in
          // raw items; items fold into ≤ items rows, so adding the item count is a
          // safe over-estimate (renderStart clamps at 0 / the row total).
          setRenderCount((c) => c + fresh.length)
        }
        // A page that came back entirely held means no genuinely earlier item is
        // reachable from this anchor — stop paging rather than re-fetch it forever.
        setHasMoreOlder(r.items.length > 0 && fresh.length === 0 ? false : r.hasMore)
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

  // Back-page the LOADED window out to SEARCH_DEPTH — called when the user opens
  // search. `transcriptSearchState` matches over loaded blocks only, so the
  // paint-sized initial window would quietly narrow recall (and the n/total beside
  // it) with no affordance saying so; this buys back the depth every open used to
  // pay for eagerly. Unlike `loadOlder` it deliberately does NOT touch
  // `renderCount` or `prependAnchor`: the pages join the searchable window without
  // mounting rows or moving the viewport, so a deepen behind a scrolled-to-bottom
  // view is invisible. Runs at most once per session and yields to scroll paging,
  // which owns the same anchor.
  const ensureSearchDepth = useCallback(() => {
    if (deepenedRef.current) return
    deepenedRef.current = true
    void (async () => {
      try {
        while (loadedRef.current.length < SEARCH_DEPTH && hasMoreOlderRef.current) {
          // The user is scroll-paging right now — it advances the same headCursor,
          // so stepping on it would double-fetch or skip a page. Its pages count
          // toward the depth anyway; stop and let it drive.
          if (loadingOlderRef.current) return
          const anchor = headCursorRef.current
          if (!anchor) return
          loadingOlderRef.current = true
          setDeepeningSearch(true)
          try {
            const r = await trpc.sessions.transcriptRead.query({
              sessionId,
              anchor,
              direction: 'before',
              limit: PAGE_LIMIT,
            })
            if (sessionIdRef.current !== sessionId) return // switched mid-page
            // Same rolled-away-anchor guard as `loadOlder`: a page we already hold
            // in full is the reader's newest-window fallback, not an older page.
            const fresh = freshOlderPage(r.items, loadedRef.current)
            if (fresh.length === 0) {
              setHasMoreOlder(false)
              hasMoreOlderRef.current = false
              return
            }
            setOlder((prev) => [...fresh, ...prev])
            setHeadCursor(fresh[0]?.cursor ?? r.head ?? anchor)
            headCursorRef.current = fresh[0]?.cursor ?? r.head ?? anchor
            setHasMoreOlder(r.hasMore)
            hasMoreOlderRef.current = r.hasMore
            // Advance the mirrors this loop reads BEFORE React commits the state
            // above — otherwise every iteration would re-read from the same anchor.
            loadedRef.current = dedupeByCursor([...fresh, ...loadedRef.current])
          } finally {
            loadingOlderRef.current = false
          }
        }
      } finally {
        setDeepeningSearch(false)
      }
    })().catch(() => {
      // Transient read failure: leave the window as deep as it got and re-arm, so
      // clearing and re-opening search retries.
      deepenedRef.current = false
      loadingOlderRef.current = false
      setDeepeningSearch(false)
    })
  }, [trpc, sessionId])

  return {
    blocks,
    rows,
    search,
    markdownHtml,
    computeReady,
    visibleRows,
    renderStart,
    moreAbove,
    hasMoreOlder,
    loadingOlder,
    deepeningSearch,
    initialLoaded,
    offlineAsOf,
    loadOlder,
    ensureSearchDepth,
    setRenderCount,
    pinnedToBottom,
    didInitialScroll,
    prependAnchor,
  }
}
