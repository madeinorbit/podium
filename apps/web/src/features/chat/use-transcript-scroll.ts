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

/**
 * How long a bottom-snap keeps re-asserting itself, in frames.
 *
 * The transcript's own late-layout sources — a code block being measured, an
 * image arriving, a work line unfolding, the composer growing an offer card —
 * all settle within a few frames of the write that asked for the bottom. Ten
 * frames is about 160ms: long enough to outlast them, short enough that a user
 * who immediately scrolls up feels nothing, since the very first scroll of
 * theirs clears the pin and ends the loop.
 */
const SETTLE_FRAMES = 10

/** Frames still owed to a scroller, so overlapping callers extend one loop
 *  rather than each starting their own. */
const settling = new WeakMap<HTMLElement, number>()

/**
 * Hold the view at the bottom while the layout under it is still moving.
 *
 * Every caller here wants the same thing and used to write it the same way —
 * `el.scrollTop = el.scrollHeight`, once — which is correct only if nothing
 * below the fold changes size afterwards. This re-asserts across the settle
 * window and abandons immediately if the pin is dropped, so it can never fight
 * a user who has taken the scroll back.
 *
 * WHY EVERY BOTTOM-WRITE GOES THROUGH IT NOW, INCLUDING THE OBSERVERS. A single
 * synchronous write assumes the engine has already recomputed the scrollable
 * overflow region by the time it lands: `scrollTop` is CLAMPED to the current
 * maximum, so a write of the new height against a stale maximum silently lands
 * short, and the view sits above an end it believes it has reached. Chromium
 * recomputes on the `scrollHeight` read, which is why the same code is correct
 * there and short in WebKit — the operator sees this in Safari only.
 *
 * Re-asserting on the following frames is the engine-agnostic form of the same
 * intent: read the height again once layout has settled, and write again if the
 * two still disagree. It costs a handful of clamped no-op writes on the engines
 * that were already right.
 */
function settleToBottom(el: HTMLElement, pinned: RefObject<boolean>): void {
  const running = (settling.get(el) ?? 0) > 0
  settling.set(el, SETTLE_FRAMES)
  // A loop already in flight has just had its budget renewed; starting a second
  // would double the writes per frame for the same effect.
  if (running) return
  const step = (): void => {
    if (!pinned.current) {
      settling.set(el, 0)
      return
    }
    el.scrollTop = el.scrollHeight
    const left = (settling.get(el) ?? 0) - 1
    settling.set(el, left)
    if (left > 0) requestAnimationFrame(step)
  }
  step()
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
      settleToBottom(el, pinnedToBottom)
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
  // tail). On the first populated render, wait for layout to settle, then pin to
  // the bottom. One-shot per session — incremental growth is handled above and
  // must still honour a user who scrolled up.
  //
  // TWO FRAMES WAS A GUESS AT HOW LONG THAT TAKES, and it is the shape of the
  // "entering a chat does not always go to the bottom" report: a transcript
  // whose last screen is prose lands correctly, and one ending in a long code
  // block or an image resolves its real height after the two frames are spent,
  // leaving the view a screen short of the tail. "Not always" is what a race
  // looks like from outside. Re-asserting across the settle window costs
  // nothing on the transcripts that were already landing right, and the pin is
  // still what gates it, so a reader who scrolls up during the load keeps their
  // place.
  // biome-ignore lint/correctness/useExhaustiveDependencies: one-shot keyed off the block count
  useEffect(() => {
    if (didInitialScroll.current || blockCount === 0) return
    didInitialScroll.current = true
    const el = scrollerRef.current
    if (!el) return
    requestAnimationFrame(() => {
      requestAnimationFrame(() => settleToBottom(el, pinnedToBottom))
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
      // A SINGLE WRITE HERE, deliberately. These callbacks fire constantly while
      // an answer streams, and routing them through the settle loop (round 7)
      // kept a rAF loop permanently renewed, writing the bottom every frame. The
      // loop only yields when `pinnedToBottom` goes false, and that is set from
      // the SCROLL event — which WebKit defers during momentum scrolling. So a
      // reader scrolling up was fought for as long as the stream kept the
      // observers busy, and the operator reported the jump-back had got WORSE
      // immediately after that change. Re-asserting belongs to a DELIBERATE
      // request for the bottom (a jump, the initial load, a send), where the
      // reader has just asked for it and nothing is competing.
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
    // ...INCLUDING THE CHILDREN THAT ARRIVE BETWEEN ROW COMMITS (POD-993 round
    // 6, the "waiting on your decision" report). The set observed above is the
    // children AS OF a rowsToRender commit — but not everything in the scroller
    // is a row. The TAIL is mounted, unmounted and remounted (`key={kind}`) on
    // ACTIVITY commits, which change no row and therefore never re-run this
    // effect; the pending bubbles, the queued cards and the headless overlay
    // mount on their own state the same way. Each such element is a node this
    // observer has never been asked to watch.
    //
    // That asymmetry is the whole bug, and it is one-directional in effect: when
    // an observed tail UNMOUNTS, its final resize callback still fires (the
    // detached box reports 0×0) and the pin re-snaps — but the element mounted
    // in a LATER commit grows the document below the fold with no callback, no
    // scroll event and no blockCount change, so nothing re-asserts the pin and
    // the view is left parked exactly one tail short of the end. Measured on a
    // waiting-on-decision transcript: one unmount→remount cycle pins the feed
    // 50px above the true bottom, permanently, with the gap under the 80px
    // "near" threshold — so the system agrees this is the bottom, the jump
    // affordance never offers, and a reader who scrolls down to the real end by
    // hand is yanked back up by the next cycle. That is the reported triad:
    // opens short, "jump to bottom" returns to the same short position, and the
    // real end escapes upward seconds after you find it.
    //
    // A childList observer closes the gap at its source: every element joining
    // the scroller joins the resize observation the moment it mounts, and the
    // mount itself re-honours the pin (mutation callbacks run before paint, so
    // the reader never sees the intermediate frame). Departures are handled in
    // the same pass — this callback re-snaps either way, so dropping the
    // observation costs nothing and stops a feed that flaps its tail for an hour
    // from accumulating an observation per flap.
    const mo = new MutationObserver((mutations) => {
      for (const mutation of mutations) {
        for (const node of mutation.addedNodes) {
          if (node instanceof Element) ro.observe(node)
        }
        for (const node of mutation.removedNodes) {
          if (node instanceof Element) ro.unobserve(node)
        }
      }
      // A SINGLE WRITE HERE, deliberately. These callbacks fire constantly while
      // an answer streams, and routing them through the settle loop (round 7)
      // kept a rAF loop permanently renewed, writing the bottom every frame. The
      // loop only yields when `pinnedToBottom` goes false, and that is set from
      // the SCROLL event — which WebKit defers during momentum scrolling. So a
      // reader scrolling up was fought for as long as the stream kept the
      // observers busy, and the operator reported the jump-back had got WORSE
      // immediately after that change. Re-asserting belongs to a DELIBERATE
      // request for the bottom (a jump, the initial load, a send), where the
      // reader has just asked for it and nothing is competing.
      if (pinnedToBottom.current) el.scrollTop = el.scrollHeight
      syncStickyPromptPositions()
    })
    mo.observe(el, { childList: true })
    return () => {
      mo.disconnect()
      ro.disconnect()
    }
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
      settleToBottom(el, pinnedToBottom)
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
    // ONE WRITE IS NOT ENOUGH, because "the bottom" is a number that is still
    // moving when the click lands. `scrollHeight` is whatever has laid out SO
    // FAR: a code block still measuring, an image without intrinsic size, a
    // work line unfolding, or the composer growing an offer card underneath —
    // each of which settles a frame or three later, and each of which leaves a
    // single synchronous write short of an end that has since moved.
    //
    // Reported as "jump to bottom goes not all the way down". Not reproduced
    // here — measured at 0px from the bottom on this transcript, including
    // through a 170px offer card appearing — so this is written as hardening
    // for a race rather than as a fix for an understood defect: re-assert while
    // the layout settles, and stop the moment the user takes the scroll back.
    settleToBottom(el, pinnedToBottom)
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
