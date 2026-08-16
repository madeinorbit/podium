import type { RefObject } from 'react'
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'

/**
 * SCROLL ANCHORING AND THE STICKY PROMPT (POD-405, extracted from ChatView).
 *
 * The one part of the chat surface that is genuinely about the DOM: where the
 * scroller sits, when it may be moved, and how the operator-prompt rows hand off
 * to one another as the user scrolls. `useTranscriptWindow` owns the DATA
 * (reads, deltas, paging) and hands this hook the three refs the two must
 * coordinate through; this hook owns every write to `scrollTop` and every style
 * written onto a prompt row.
 *
 * BEHAVIOUR PARITY IS THE POINT OF THIS FILE. Every effect below is the one that
 * was inline in ChatView, moved with its ordering, its dependency list and its
 * biome suppressions intact. The ordering is load-bearing and is documented at
 * each effect: the prepend re-anchor is a LAYOUT effect so it corrects position
 * before paint, and the bottom-snap that follows is gated on `pinnedToBottom`
 * (false while the user has scrolled up), so the two can never fight.
 */

export interface UseTranscriptScrollOptions {
  scrollerRef: RefObject<HTMLDivElement | null>
  /** Mirrors ChatView's `active` prop — a hidden panel gets no scroll events, so
   *  becoming active re-honours the pin. */
  active: boolean
  /** Grows as the transcript grows; the trigger for every follow-the-tail effect. */
  blockCount: number
  /** First windowed-in row — changes when a prepend widens the window. */
  renderStart: number
  /** Sticky operator prompts are a preference, and are suppressed in the narrow
   *  dock (too short to give a pinned prompt anywhere to go). */
  stickyEnabled: boolean
  /** More rows exist above — scrolling near the top autoloads them. */
  moreAbove: boolean
  loadOlder: () => void
  /** From `useTranscriptWindow`: read AND written here. */
  pinnedToBottom: RefObject<boolean>
  didInitialScroll: RefObject<boolean>
  prependAnchor: RefObject<{ scrollHeight: number; scrollTop: number } | null>
  /** Changes whenever the mounted row set changes — the trigger for a fresh
   *  geometry pass over the sticky prompts. */
  rowsToRender: unknown
}

/** The brief the pinned shelf is currently carrying, or null when the brief the
 *  reader is under is still on screen. `key` changes only when a DIFFERENT brief
 *  takes the shelf, which is what keeps the scroll path free of re-renders. */
export interface PinnedBrief {
  key: string
  /** Sanitized markdown, lifted from the row's own rendered body. */
  html: string
  /** The brief's clock, as the row prints it. Empty when the row has no ts. */
  time: string
}

export interface UseTranscriptScrollResult {
  /** False once the user scrolls up — drives the "jump to bottom" affordance. */
  atBottom: boolean
  onScroll: () => void
  jumpToBottom: () => void
  /** Re-pin to the tail (used by the send path, which always follows its own send). */
  pinToBottom: () => void
  /** Scroll a `[data-block]` row into view — the search jump. */
  scrollToBlock: (index: number) => void
  syncStickyPromptPositions: () => void
  /** Drives the shelf drawn over the feed. Null → no shelf. */
  pinnedBrief: PinnedBrief | null
}

export function useTranscriptScroll(opts: UseTranscriptScrollOptions): UseTranscriptScrollResult {
  const {
    scrollerRef,
    active,
    blockCount,
    renderStart,
    stickyEnabled,
    moreAbove,
    loadOlder,
    pinnedToBottom,
    didInitialScroll,
    prependAnchor,
    rowsToRender,
  } = opts

  const [atBottom, setAtBottom] = useState(true)
  const [pinnedBrief, setPinnedBrief] = useState<PinnedBrief | null>(null)
  /**
   * The ELEMENT currently on the shelf, not its index.
   *
   * `data-block` is an absolute index into a list that grows at BOTH ends: page
   * older rows in and every index shifts, so the brief that has just left the
   * top can report the index the shelf already holds and the early-return below
   * would keep the previous brief's words on screen. A kept-mounted pane
   * switching sessions is the same bug with a worse outcome — one session's
   * brief pinned over another session's transcript.
   *
   * The DOM node is the identity that actually survives a prepend and cannot
   * survive a session change, which is exactly the distinction this needs.
   */
  const pinnedEl = useRef<HTMLElement | null>(null)

  /**
   * THE PINNED BRIEF LEFT THE COLUMN (POD-993 round 2).
   *
   * This used to keep the real prompt row in the transcript with `position:
   * sticky`, and hand consecutive prompts past one another by writing a
   * `translateY` onto the outgoing row on every scroll frame — plus a
   * `visibility: hidden` on the ones already gone. It worked, and it meant the
   * shelf was part of the flow: pinning changed the height of the column the
   * reader was reading, and a row could be mid-transform when a re-render
   * replaced it.
   *
   * Now the rows never move. This pass only ANSWERS A QUESTION — which brief has
   * scrolled off the top edge — and the answer drives a shelf drawn over the feed
   * (see `PinnedBrief` in ChatView), which can appear and leave without touching
   * a single row.
   *
   * It stays cheap on the scroll path by only ever reading geometry, and by
   * setting state exclusively when a DIFFERENT brief takes the shelf: scrolling
   * through one long answer re-renders nothing. The shelf's content is lifted
   * from the row's own already-sanitized body rather than re-rendered from the
   * source, so what is pinned is by construction what is in the column.
   */
  const syncStickyPromptPositions = useCallback(() => {
    const scroller = scrollerRef.current
    if (!scroller) return
    if (!stickyEnabled) {
      if (pinnedEl.current !== null) {
        pinnedEl.current = null
        setPinnedBrief(null)
      }
      return
    }
    const prompts = Array.from(
      scroller.querySelectorAll<HTMLElement>('[data-operator-prompt="true"][data-pinnable="true"]'),
    )
    // The brief is pinned once it has fully left the top of the viewport — its
    // BOTTOM edge, not its top, so a brief you can still read is never doubled
    // by a shelf saying the same words.
    const top = scroller.getBoundingClientRect().top + 6
    let active: HTMLElement | undefined
    for (const prompt of prompts) {
      if (prompt.getBoundingClientRect().bottom < top) active = prompt
      else break
    }

    // NORMALISE BEFORE COMPARING. `querySelector` misses give `undefined` and
    // the ref holds `null`, and `undefined === null` is false — so comparing the
    // raw values made the no-brief case (the common one: nothing has scrolled
    // off the top yet) fall through the early return and call setState on EVERY
    // pass. This runs from a layout effect, a ResizeObserver and every scroll
    // frame, so that was a render loop: React #185, a blank app, and the one
    // state where the shelf has nothing to do is the state that broke it.
    const next = active ?? null
    if (next === pinnedEl.current) return
    pinnedEl.current = next
    if (!next) {
      setPinnedBrief(null)
      return
    }
    setPinnedBrief({
      // A key for React and for the shelf's own open/closed state. The index is
      // fine for THAT — it only has to change when the brief does, and it is
      // combined with the identity check above, which is what makes it safe.
      key: next.dataset.block ?? '',
      html: next.querySelector<HTMLElement>('.transcript-you-body')?.innerHTML ?? '',
      time: next.querySelector<HTMLElement>('.chat-clk')?.textContent ?? '',
    })
  }, [scrollerRef, stickyEnabled])

  // Reconcile after row-window changes before paint, including when the
  // continuation prompt is mounted for a virtualized long answer.
  // biome-ignore lint/correctness/useExhaustiveDependencies: row-window and active-panel changes require a fresh DOM geometry pass
  useLayoutEffect(() => {
    syncStickyPromptPositions()
  }, [active, rowsToRender, syncStickyPromptPositions])

  // Follow the live tail unless the user scrolled up to read. Re-runs as blocks
  // arrive (snapshot lands after mount, then live appends) — an empty dep array
  // fired once before any transcript existed and never followed the stream.
  // biome-ignore lint/correctness/useExhaustiveDependencies: scroll when the block list grows
  useEffect(() => {
    const el = scrollerRef.current
    if (el && pinnedToBottom.current) {
      el.scrollTop = el.scrollHeight
      syncStickyPromptPositions()
    }
  }, [blockCount, syncStickyPromptPositions])

  // Scroll-anchor for prepends: after older blocks are inserted at the top (window
  // widened or a disk page prepended), the content the user was reading shifts down
  // by the inserted height. Re-pin scrollTop by that delta BEFORE paint so the view
  // doesn't jump. Keyed on the values that change the top of the list; a no-op
  // unless a prepend captured an anchor. Runs before the bottom-snap effect below,
  // and that effect is gated on pinnedToBottom (false while scrolled up), so the two
  // never fight.
  // biome-ignore lint/correctness/useExhaustiveDependencies: re-anchor when the top of the list changes
  useLayoutEffect(() => {
    const anchor = prependAnchor.current
    if (!anchor) return
    prependAnchor.current = null
    const el = scrollerRef.current
    if (!el) return
    const delta = el.scrollHeight - anchor.scrollHeight
    if (delta !== 0) el.scrollTop = anchor.scrollTop + delta
  }, [blockCount, renderStart])

  // Initial-load snap: the growth effect above can fire before markdown/code
  // blocks have laid out (it measures a shorter scrollHeight and lands above the
  // tail). On the first populated render, defer two frames so layout settles,
  // then pin to the bottom. One-shot per session — incremental growth is handled
  // above and must still honour a user who scrolled up.
  // biome-ignore lint/correctness/useExhaustiveDependencies: one-shot keyed off the block count
  useEffect(() => {
    if (didInitialScroll.current || blockCount === 0) return
    didInitialScroll.current = true
    const el = scrollerRef.current
    if (!el) return
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        if (pinnedToBottom.current) el.scrollTop = el.scrollHeight
      })
    })
  }, [blockCount])

  // ResizeObserver: while pinned, re-snap to bottom whenever the stream grows
  // taller (async markdown / code-block layout that settles after the DOM paint).
  // Gated on pinnedToBottom so it never yanks the view while the user has scrolled
  // up to read or page older content.
  // biome-ignore lint/correctness/useExhaustiveDependencies: pinnedToBottom is a stable ref from useTranscriptWindow, not app state
  useEffect(() => {
    const el = scrollerRef.current
    if (!el) return
    const ro = new ResizeObserver(() => {
      if (pinnedToBottom.current) el.scrollTop = el.scrollHeight
      syncStickyPromptPositions()
    })
    ro.observe(el)
    // ...AND EVERY ROW IN IT (POD-993 round 3). Observing only the scroller
    // catches a resized WINDOW and nothing else: the scroller is `flex-1`, so
    // its own box does not change when the content inside it grows. That is the
    // whole of the "it jumps away from the bottom while the agent is typing"
    // report — a streaming answer grows an EXISTING row, `blockCount` never
    // changes, the effect above never fires, and the only thing holding the view
    // down was the browser's native scroll anchoring, which lets go the moment
    // the growth is below the anchor it chose.
    //
    // Observing the rows themselves catches all of it: streamed tokens, a code
    // block laying out late, an image loading, a work line unfolding. Cheap
    // because ResizeObserver reports in one batched callback however many
    // elements moved, and the callback does nothing at all unless pinned.
    const rows = el.children
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i]
      if (row instanceof Element) ro.observe(row)
    }
    return () => ro.disconnect()
  }, [syncStickyPromptPositions, rowsToRender])

  // Snap to bottom on pane switch-in: the keep-mounted panel deck hides inactive
  // panels with `display:none`, so scroll events stop firing. When this pane
  // becomes active again, honour the pin by jumping straight to the bottom (and
  // only then — a user who scrolled up keeps their position).
  // biome-ignore lint/correctness/useExhaustiveDependencies: fire only on active transition
  useEffect(() => {
    if (!active) return
    const el = scrollerRef.current
    if (el && pinnedToBottom.current) {
      el.scrollTop = el.scrollHeight
      syncStickyPromptPositions()
    }
  }, [active, syncStickyPromptPositions])

  const onScroll = useCallback(() => {
    const el = scrollerRef.current
    if (!el) return
    const near = el.scrollHeight - el.scrollTop - el.clientHeight < 80
    pinnedToBottom.current = near
    setAtBottom(near)
    syncStickyPromptPositions()
    // Near the TOP and more exists above → reveal/fetch older content.
    if (el.scrollTop < 200 && moreAbove) loadOlder()
  }, [scrollerRef, pinnedToBottom, syncStickyPromptPositions, moreAbove, loadOlder])

  const jumpToBottom = useCallback(() => {
    const el = scrollerRef.current
    if (!el) return
    pinnedToBottom.current = true
    el.scrollTop = el.scrollHeight
    setAtBottom(true)
    syncStickyPromptPositions()
  }, [scrollerRef, pinnedToBottom, syncStickyPromptPositions])

  // A send always follows its own message: re-pin without touching the DOM, and
  // let the growth effect above do the scrolling once the bubble mounts.
  const pinToBottom = useCallback(() => {
    pinnedToBottom.current = true
    setAtBottom(true)
  }, [pinnedToBottom])

  const scrollToBlock = useCallback(
    (index: number) => {
      scrollerRef.current
        ?.querySelector(`[data-block="${index}"]`)
        ?.scrollIntoView({ block: 'center' })
    },
    [scrollerRef],
  )

  return {
    atBottom,
    onScroll,
    jumpToBottom,
    pinToBottom,
    scrollToBlock,
    syncStickyPromptPositions,
    pinnedBrief,
  }
}
