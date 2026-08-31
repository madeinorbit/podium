import { isSwitchTraced, markSwitch } from '@podium/client-core/perf'
import {
  createTranscriptController,
  type TranscriptFreshness,
} from '@podium/client-core/transcript'
import { applyChatVerbosity, type ChatVerbosity } from '@podium/client-core/viewmodels'
import type { SessionId, SessionMeta, TranscriptItem } from '@podium/model/browser'
import type { TranscriptSearchState } from '@podium/client-core/viewmodels'
import type { Dispatch, SetStateAction } from 'react'
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import type { Store } from '@/app/store'
import { type ChatBlock, type ChatRow } from './chat'
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

export type { TranscriptFreshness } from '@podium/client-core/transcript'

export interface UseTranscriptWindowOptions {
  sessionId: SessionId
  hub: Store['hub']
  trpc: Store['trpc']
  replica: Store['replica']
  /** Mirrors ChatView's `active` prop — re-reads the window when this pane
   *  becomes the foreground view again (a backgrounded view can fall behind). */
  active: boolean
  session: SessionMeta | undefined
  /** A client-minted session can be painted before the authority knows its id.
   * Keep the optimistic feed visible without spending the one initial read on a
   * guaranteed not-found; the caller clears this when replica truth arrives. */
  deferInitialRead?: boolean
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
  /** Whether visible rows are being checked, rendered from a fresh read, or remain saved-only. */
  transcriptFreshness: TranscriptFreshness
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
}

/**
 * Owns the held transcript window for ChatView: an initial disk read (any
 * session status — the single source, not a live-only path) plus a live-delta
 * subscription from the read's tail cursor, scroll-up back-paging, and the
 * worker-backed transcript index that supplies the bounded trailing window.
 * Pure data/paging concerns; the scroll DOM itself
 * (onScroll, the sticky-user header, the minimap, the actual scrollTop
 * writes) stays in ChatView.
 */
export function useTranscriptWindow(opts: UseTranscriptWindowOptions): UseTranscriptWindowResult {
  const {
    sessionId,
    hub,
    trpc,
    replica,
    active,
    session,
    deferInitialRead = false,
    verbosity = 'normal',
    query = '',
    cursor = 0,
  } = opts

  const transcriptController = useMemo(
    () =>
      createTranscriptController({
        sessionId,
        initialLimit: INITIAL_LIMIT,
        pageLimit: PAGE_LIMIT,
        source: {
          async read(request) {
            const tracedNewest = request.anchor === undefined && request.limit === INITIAL_LIMIT
            if (tracedNewest) markSwitch(sessionId, 'transcript:read-start')
            const page = await trpc.sessions.transcriptRead.query(request)
            if (tracedNewest)
              markSwitch(sessionId, 'transcript:read-end', { items: page.items.length })
            return page
          },
          subscribe: (sid, since, listener) => hub.subscribeTranscript(sid, since, listener),
        },
        cache: replica
          ? {
              read: (sid) => replica.transcriptWindow(sid),
              write: (sid, values) => replica.putTranscriptWindow(sid, [...values]),
            }
          : undefined,
        ...(typeof hub.connectionHealth === 'function' &&
        typeof hub.onConnectionHealth === 'function'
          ? {
              connection: {
                connected: () => hub.connectionHealth().status !== 'down',
                subscribe: (listener: (connected: boolean) => void) =>
                  hub.onConnectionHealth((health) => listener(health.status !== 'down')),
              },
            }
          : {}),
      }),
    [hub, replica, sessionId, trpc],
  )
  const transcript = useSyncExternalStore(
    transcriptController.subscribe,
    transcriptController.getSnapshot,
  )
  const {
    items,
    head: headCursor,
    hasMoreOlder,
    loadingOlder,
    initialLoaded,
    subscriptionHealthy,
    freshness: transcriptFreshness,
    offlineAsOf,
  } = transcript
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

  const [pagedBack, setPagedBack] = useState(false)
  const deepenedRef = useRef(false)
  const windowHealthy = useRef(false)
  const activitySignalRef = useRef('')
  const reconciledSignalRef = useRef<string | null>(null)
  const refreshInFlightRef = useRef<Promise<boolean> | null>(null)
  const probeInFlightRef = useRef<Promise<boolean> | null>(null)

  const readNewest = useCallback(
    (options: { force?: boolean; disclose?: boolean } = {}): Promise<boolean> => {
      if (!options.force && refreshInFlightRef.current) return refreshInFlightRef.current
      const promise = transcriptController
        .refresh({ disclose: options.disclose })
        .then((accepted) => {
          if (accepted) {
            reconciledSignalRef.current = activitySignalRef.current
            setPagedBack(false)
          }
          return accepted
        })
      refreshInFlightRef.current = promise
      const clear = (): void => {
        if (refreshInFlightRef.current === promise) refreshInFlightRef.current = null
      }
      void promise.then(clear, clear)
      return promise
    },
    [transcriptController],
  )

  const probeNewest = useCallback((disclose = false): Promise<boolean> => {
    if (refreshInFlightRef.current) return refreshInFlightRef.current
    if (probeInFlightRef.current) return probeInFlightRef.current
    const promise = transcriptController.probe({ disclose }).then((accepted) => {
      if (accepted) reconciledSignalRef.current = activitySignalRef.current
      return accepted
    })
    probeInFlightRef.current = promise
    const clear = (): void => {
      if (probeInFlightRef.current === promise) probeInFlightRef.current = null
    }
    void promise.then(clear, clear)
    return promise
  }, [transcriptController])

  // The controller owns cache hydration, read-then-subscribe, reset recovery,
  // reconnect refresh, paging, and stale-result rejection. This hook adds only
  // browser presentation work: worker shaping, visibility and activity probes.
  useEffect(() => {
    setComputed(null)
    setDeepeningSearch(false)
    setRenderCount(RENDER_WINDOW)
    setPagedBack(false)
    deepenedRef.current = false
    windowHealthy.current = false
    if (deferInitialRead) return
    void transcriptController.start().then(() => {
      reconciledSignalRef.current = activitySignalRef.current
    })
    return () => {
      windowHealthy.current = false
      transcriptController.stop()
    }
  }, [deferInitialRead, transcriptController])

  useEffect(() => {
    windowHealthy.current = subscriptionHealthy
  }, [subscriptionHealthy])

  useEffect(() => {
    if (!initialLoaded || items.length === 0) return
    reconciledSignalRef.current = activitySignalRef.current
  }, [initialLoaded, items])

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
        markSwitch(sessionId, 'chat:cache-hit', { items: items.length })
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
      void probeNewest(true).catch(() => {
        // A STAMP IS A CLAIM, AND A FAILED PROBE PROVED NOTHING. Leaving it
        // standing would re-create this very bug on the failure path: the next
        // reveal would compare equal and skip outright, while both fallbacks
        // can be unavailable — the heartbeat needs a LIVE session, and the
        // 400ms reconcile needs the row to move again, neither of which holds
        // for a session that has just finished. Withdrawing the claim (null =
        // "we do not know when this window was last current") re-arms both, and
        // the identity check keeps a delta that landed meanwhile authoritative.
        if (reconciledSignalRef.current === signal) reconciledSignalRef.current = null
      })
      return
    }
    if (wokeToLive || becameActive) void readNewest({ force: true, disclose: true }).catch(() => {})
  }, [session?.status, active, initialLoaded, readNewest, probeNewest, sessionId, items.length])

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
  // ONE THING IT MUST NOT DO: run while the reader has paged HISTORY in.
  // `readNewest` drops `older` — correct on a switch or a file roll, ruinous on
  // a timer, because it would throw away the pages someone just scrolled up to
  // read and take their scroll position with it. Someone reading history is by
  // definition not watching the tail, so the reconcile simply waits.
  //
  // THE ESCAPE HATCH, RESTORED [POD-1132]. That stand-down was always meant to
  // be a pause — "the next activation re-reads as it always did" — and POD-725
  // then taught activation to skip the read, which turned the pause into a
  // LATCH: `older` is only ever cleared BY a tail re-read, so the one condition
  // suppressing the re-read was also the only thing the re-read could clear, and
  // one scroll-up left the pane running on the lossy delta stream for the rest
  // of its mount. The repair belongs at the ACTIVATION, not here: the reveal
  // path above no longer skips blindly, so a paged-back pane that has genuinely
  // fallen behind is caught by its probe and healed, while one that has not
  // keeps the reader's pages — which is the whole point of standing down.
  //
  // Widening this predicate instead (to "paged back AND scrolled away from the
  // tail") was the wrong lever: `loadOlder` is reachable while still pinned to
  // the bottom — the "Earlier transcript" button, and a short transcript where
  // ChatView's scroll-up trigger and its near-bottom threshold overlap — so it
  // would have dropped pages the reader had just asked for.
  const readNewestRef = useRef(readNewest)
  readNewestRef.current = readNewest
  const live = session?.status === 'live' || session?.status === 'starting'
  // Mirrored so the timers below can ask per TICK instead of taking it as a
  // dependency — paging a page in must not tear the heartbeat down and rebuild
  // it. Safe as a render-time mirror: `older` only ever moves through setState.
  const pagedBackRef = useRef(false)
  pagedBackRef.current = pagedBack
  // One string, so the effect re-runs on any of the four moving parts without
  // four dependencies that each re-run it on the others' changes.
  const activitySignal = `${session?.lastActiveAt ?? ''}|${session?.agentState?.phase ?? ''}|${session?.agentState?.since ?? ''}|${session?.busy ?? ''}`
  activitySignalRef.current = activitySignal
  useEffect(() => {
    if (!active || !initialLoaded || pagedBack) return
    // The signal as of the last moment the window was KNOWN current — stamped by
    // every completed read and by the warm-activation cache hit. Comparing
    // against it rather than against the previous render is what keeps POD-725's
    // skipped re-read skipped: a warm switch that reused a healthy window has
    // not fallen behind, so it must not turn into a read 400ms later.
    if (reconciledSignalRef.current === activitySignal) return
    // Trailing debounce: a working agent moves these fields several times a
    // second, and the point is to be current, not to re-read once per tick.
    const t = setTimeout(() => {
      // Re-asked here, not just above: a page can land during the 400ms, and
      // this is the callback that would drop it under the reader.
      if (pagedBackRef.current) return
      if (reconciledSignalRef.current === activitySignal) return
      void readNewestRef.current({ disclose: true }).catch(() => {})
    }, 400)
    return () => clearTimeout(t)
  }, [active, initialLoaded, pagedBack, activitySignal])
  useEffect(() => {
    if (!active || !initialLoaded || !live) return
    if (typeof document === 'undefined') return
    // The stand-down is checked per TICK rather than taken as a dependency, so
    // paging a page in and out does not tear the interval down and rebuild it.
    const beat = setInterval(() => {
      if (document.visibilityState === 'hidden') return
      if (pagedBackRef.current) return
      void probeNewest().catch(() => {})
    }, LIVE_HEARTBEAT_MS)
    // A tab that was hidden may have had its timers throttled to nothing and
    // its socket dropped; coming back is the moment to be sure.
    const onVisible = (): void => {
      if (document.visibilityState !== 'visible') return
      // Guarded like the timer, and load-bearing now that `pagedBack` no longer
      // gates the whole effect: this one goes STRAIGHT to the full read, so a
      // reader who left the tab mid-scroll must not come back to a feed that has
      // thrown their history away.
      if (pagedBackRef.current) return
      void readNewestRef.current({ force: true, disclose: true }).catch(() => {})
    }
    document.addEventListener('visibilitychange', onVisible)
    return () => {
      clearInterval(beat)
      document.removeEventListener('visibilitychange', onVisible)
    }
  }, [active, initialLoaded, live, probeNewest])

  // The controller owns the complete loaded window, including older pages.
  const effectiveItems = items
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

  // Do not clear the cache qualifier merely because the network read resolved.
  // The previous worker graph stays on screen while it computes the new items,
  // and clearing here early would recreate the same unexplained stale→fresh jump
  // for that shorter, but still visible, part of the boundary.
  useEffect(() => {
    if (transcriptFreshness !== 'rendering' || !initialLoaded) return
    if (computed?.items !== effectiveItems) return
    transcriptController.markRendered()
  }, [computed, effectiveItems, initialLoaded, transcriptController, transcriptFreshness])

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
  // and prepend it. The scroll hook captures a retained visible row before it
  // calls this function and restores that exact row after the prepend lands.
  const loadOlder = useCallback(() => {
    if (renderStart > 0) {
      setRenderCount((c) => c + RENDER_WINDOW)
      return
    }
    if (!hasMoreOlder || loadingOlder || headCursor === undefined) return
    const before = transcriptController.getSnapshot().items.length
    void transcriptController.loadOlder().then((accepted) => {
      if (!accepted) return
      const added = transcriptController.getSnapshot().items.length - before
      setPagedBack(true)
      setRenderCount((count) => count + Math.max(added, 1))
    })
  }, [headCursor, hasMoreOlder, loadingOlder, renderStart, transcriptController])

  // Back-page the LOADED window out to SEARCH_DEPTH — called when the user opens
  // search. `transcriptSearchState` matches over loaded blocks only, so the
  // paint-sized initial window would quietly narrow recall (and the n/total beside
  // it) with no affordance saying so; this buys back the depth every open used to
  // pay for eagerly. Unlike `loadOlder` it deliberately does NOT touch
  // `renderCount`: the pages join the searchable window without
  // mounting rows or moving the viewport, so a deepen behind a scrolled-to-bottom
  // view is invisible. Runs at most once per session and yields to scroll paging,
  // which owns the same anchor.
  const ensureSearchDepth = useCallback(() => {
    if (deepenedRef.current) return
    deepenedRef.current = true
    void (async () => {
      try {
        while (true) {
          const current = transcriptController.getSnapshot()
          if (
            current.items.length >= SEARCH_DEPTH ||
            !current.hasMoreOlder ||
            current.loadingOlder ||
            current.head === undefined
          ) {
            return
          }
          setDeepeningSearch(true)
          const accepted = await transcriptController.loadOlder()
          if (!accepted) return
          setPagedBack(true)
        }
      } finally {
        setDeepeningSearch(false)
      }
    })().catch(() => {
      // Transient read failure: leave the window as deep as it got and re-arm, so
      // clearing and re-opening search retries.
      deepenedRef.current = false
      setDeepeningSearch(false)
    })
  }, [transcriptController])

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
    transcriptFreshness,
    offlineAsOf,
    loadOlder,
    ensureSearchDepth,
    setRenderCount,
  }
}
