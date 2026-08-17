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
  /** An arriving row is about to animate its OWN height for `ms`. Take the
   *  scroll for exactly that long so one writer follows it instead of three.
   *  See `claimScrollForArrival` below. */
  claimScrollForArrival: (ms: number) => void
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

/**
 * Two wheel-down notches against a frozen offset re-pin a reader the geometry
 * refuses to let arrive (see the intent listeners). The spacing is what keeps
 * a FAST reader out of it: two notches inside the same frame read the same
 * offset because the engine has not applied the first yet, not because it
 * refused it — async scrolling applies within a frame or two, so 100ms is
 * comfortably past honest lag while a held wheel against the clamp crosses it
 * in a beat.
 */
const STUCK_NOTCH_SPACING_MS = 100
/** An upward move that stays inside this band reads as the rubber band
 *  settling onto a stale maximum, not as the reader leaving — the measured
 *  staleness runs 115–161px (see `writeBottom`). */
const REVOKE_TRAVEL_PX = 160
/** How long after a wheel-down notch an upward move still belongs to that
 *  gesture (its own clamp or rubber-band retraction) rather than to fresh
 *  intent. */
const WHEEL_GESTURE_MS = 300

/**
 * Grant or revoke the ENGINE's end-of-feed anchor (POD-1160).
 *
 * Trunk WebKit ships scroll anchoring, and on this feed that engine reverts
 * whatever moves its chosen anchor — the pin's writes and the reader's wheel
 * alike. The stylesheet therefore excludes every row from anchor selection and
 * re-admits only the LAST child, only while this attribute is present (see
 * styles.css). With it, an anchoring WebKit holds the bottom natively; without
 * it, the engine has no anchor to defend and a reader who has scrolled up
 * cannot be dragged back.
 *
 * KNOW WHICH ENGINE THIS IS FOR (round 2): RELEASE Safari has no scroll
 * anchoring at all — `CSS.supports('overflow-anchor: none')` is false in the
 * operator's own browser — so there this attribute is inert both ways, and the
 * bug that browser actually has is a stale scroll maximum (see `writeBottom`).
 * The regime stays because the engine it manages is the one Playwright tests
 * run in today and the one release Safari becomes when anchoring ships.
 *
 * The attribute is written imperatively because it changes on the scroll
 * path, where a re-render per flip would be the most expensive possible way
 * to toggle one bit.
 */
function setAnchorEnd(el: HTMLElement, on: boolean): void {
  if (on === el.hasAttribute('data-anchor-end')) return
  if (on) el.setAttribute('data-anchor-end', '')
  else el.removeAttribute('data-anchor-end')
}

/** Frames still owed to a scroller, so overlapping callers extend one loop
 *  rather than each starting their own. */
const settling = new WeakMap<HTMLElement, number>()

/**
 * Write the bottom, and HEAL THE ENGINE'S MAXIMUM if the write comes up short
 * (POD-1160 round 2, the recording of 2026-08-17).
 *
 * Release Safari scrolls this feed asynchronously against a CACHED maximum,
 * and that cache is refreshed only by a layout pass that changes the
 * scroller's scrollable overflow. Content that mounts without forcing one —
 * the waiting tail row on a quiet transcript — leaves the cached maximum short
 * of the DOM's, and from then on EVERYTHING is clamped at the stale ceiling:
 * measured in the operator's own Safari, `scrollTop = scrollHeight` moved 0px
 * against a maximum 115px under the DOM's, and 96 real wheel-down notches got
 * the same wall. (Every earlier measurement that "disproved" a stale clamp —
 * including the one an older comment here reported — ran in Playwright's
 * trunk WebKit, which does not exhibit it. The operator's browser does.)
 *
 * A second write on a later frame gets zero pixels further, because time is
 * not what the cache is waiting for. One frame of genuinely changed geometry
 * is: a pixel of padding, a forced layout, and the padding back off. Verified
 * live in the operator's console — gap 115 → 0 on exactly this sequence —
 * and paid for only when a write has demonstrably fallen short, so the
 * streaming hot path (where writes land) never sees the extra layout.
 */
function writeBottom(el: HTMLElement): void {
  el.scrollTop = el.scrollHeight
  if (el.scrollHeight - el.scrollTop - el.clientHeight <= 4) return
  el.style.paddingBottom = '1px'
  void el.offsetHeight
  el.style.paddingBottom = ''
  el.scrollTop = el.scrollHeight
}

/** A wheel over a scrollable region inside the feed chains to the feed only
 *  once that region is spent — until then the feed's offset is frozen for the
 *  OPPOSITE reason to the clamp, and the notches must not count as pushing
 *  against the end. */
function innerScrollerHasTheWheel(target: EventTarget | null, el: HTMLElement): boolean {
  let node: Node | null = target instanceof Node ? target : null
  while (node && node !== el) {
    if (
      node instanceof HTMLElement &&
      node.scrollHeight > node.clientHeight + 1 &&
      node.scrollTop + node.clientHeight < node.scrollHeight - 1
    ) {
      const overflowY = getComputedStyle(node).overflowY
      if (overflowY === 'auto' || overflowY === 'scroll') return true
    }
    node = node.parentNode
  }
  return false
}

/**
 * Hold the view at the bottom while the layout under it is still moving.
 *
 * Every caller here wants the same thing and used to write it the same way —
 * `el.scrollTop = el.scrollHeight`, once — which is correct only if nothing
 * below the fold changes size afterwards. This re-asserts across the settle
 * window and abandons immediately if the pin is dropped, so it can never fight
 * a user who has taken the scroll back.
 *
 * IT IS NOT ITSELF A FIX FOR A STALE CLAMP — and the history of that sentence
 * is a caution. An earlier version here declared the stale-clamp theory tested
 * and false, because a second write on a later frame got zero pixels further.
 * Both halves were right and the conclusion was wrong: the clamp is real in
 * release Safari and a LATER FRAME is simply not what heals it (see
 * `writeBottom`, which this loop writes through — the test that "disproved"
 * the clamp ran in Playwright's trunk WebKit, which does not have it).
 *
 * What re-asserting genuinely buys is the case it was first written for: the
 * height the write aimed at is whatever had laid out so far, and a code block
 * being measured or an image arriving moves it a frame or three later. So it
 * stays where a DELIBERATE request for the bottom was made, and nowhere else.
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
    writeBottom(el)
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
   * THE ARRIVAL OWNS THE SCROLL WHILE IT RUNS (POD-1158).
   *
   * A row that animates its own height at the end of a bottom-pinned feed is a
   * moving target for every writer here at once. The ResizeObserver sees each
   * frame of the growth and writes the bottom; the MutationObserver writes it
   * again; and since POD-993 removed `overflow-anchor: none`, WebKit is doing
   * its own anchoring beside them. Three authorities, one number.
   *
   * The fix is not to avoid a moving height — it is to stop them arguing. For
   * the length of the animation this holds a deadline, the two observers
   * early-return on it, and a SINGLE rAF loop follows the growth. That is
   * strictly fewer writes and fewer forced layouts than a landing message costs
   * today: `syncStickyPromptPositions` reads a rect per operator prompt on
   * every one of those callbacks, and skipping it for 260ms is the larger
   * saving of the two.
   *
   * A deadline rather than a boolean, so overlapping arrivals extend one claim
   * instead of the first one's cleanup cancelling the second's. Zero means
   * nobody holds it — `performance.now()` is never zero.
   */
  const arrivalClaim = useRef(0)
  const arrivalHolds = useCallback(() => arrivalClaim.current > performance.now(), [])
  /** The reader has asked to leave the bottom with a wheel or a touch, and has
   *  not arrived back yet. See the intent listeners below. */
  const releasedByIntent = useRef(false)
  /** Last seen scroll offset — direction is what re-arms the engine's end
   *  anchor on the way down (see `onScroll`). */
  const lastScrollTop = useRef(0)
  /** When the reader last wheeled DOWN — an upward move inside this window is
   *  that gesture's own clamp or retraction, not fresh intent (see `onScroll`).
   *  Starts at -Infinity: zero would read as "a notch at page birth" and
   *  swallow every revoke in the first `WHEEL_GESTURE_MS` of the clock. */
  const lastWheelDownAt = useRef(Number.NEGATIVE_INFINITY)
  /** The frozen-offset count behind arrival-by-intent: the offset the last
   *  counted notch read, when it read it, and how many in a row agreed. */
  const stuckNotchTop = useRef<number | null>(null)
  const stuckNotchAt = useRef(0)
  const stuckNotches = useRef(0)
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
    //
    // TAKING THE SHELF AND GIVING IT BACK ARE NOT THE SAME LINE (round 8). One
    // threshold is a coin standing on its edge: a brief whose bottom is resting
    // within a pixel of it is pinned on one pass and released on the next, and
    // the shelf mounts, replays its entry animation and unmounts on repeat. The
    // feed supplies the jitter for free — a streaming answer re-snaps the bottom
    // on every mutation, and a sub-pixel scroll offset rounds either way. The
    // reader sees a shelf, and its control, flashing on and off for no reason
    // they can act on.
    //
    // So the brief already on the shelf keeps it until it is properly back in
    // the column. Twelve pixels of dead band is half a line: far more than any
    // rounding, and far less than a brief you could read.
    const edge = scroller.getBoundingClientRect().top
    const takes = edge + 6
    const releases = edge + 18
    let active: HTMLElement | undefined
    for (const prompt of prompts) {
      const limit = prompt === pinnedEl.current ? releases : takes
      if (prompt.getBoundingClientRect().bottom < limit) active = prompt
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
      // kept a rAF loop permanently renewed, writing the bottom every frame,
      // which the operator reported as the jump-back getting WORSE. Re-asserting
      // belongs to a DELIBERATE request for the bottom (a jump, the initial
      // load, a send), where the reader has just asked for it and nothing is
      // competing. The trap that made it worse is closed properly by the
      // pointer-intent listeners below, not by the write policy here.
      // An arriving row's unroll is following its own growth with one rAF loop
      // (see `claimScrollForArrival`). Standing down is what makes that ONE
      // writer rather than three, and skipping the sticky pass with it is the
      // larger saving: it reads a rect per operator prompt, every callback.
      if (arrivalHolds()) return
      if (pinnedToBottom.current) writeBottom(el)
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
      // kept a rAF loop permanently renewed, writing the bottom every frame,
      // which the operator reported as the jump-back getting WORSE. Re-asserting
      // belongs to a DELIBERATE request for the bottom (a jump, the initial
      // load, a send), where the reader has just asked for it and nothing is
      // competing. The trap that made it worse is closed properly by the
      // pointer-intent listeners below, not by the write policy here.
      // An arriving row's unroll is following its own growth with one rAF loop
      // (see `claimScrollForArrival`). Standing down is what makes that ONE
      // writer rather than three, and skipping the sticky pass with it is the
      // larger saving: it reads a rect per operator prompt, every callback.
      if (arrivalHolds()) return
      if (pinnedToBottom.current) writeBottom(el)
      syncStickyPromptPositions()
    })
    mo.observe(el, { childList: true })
    return () => {
      mo.disconnect()
      ro.disconnect()
    }
  }, [syncStickyPromptPositions, rowsToRender, arrivalHolds])

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

  /**
   * THE PIN LETS GO ON INTENT, NOT ON DISTANCE.
   *
   * `onScroll` below re-pins whenever the view is within 80px of the end, which
   * is the right rule for where the reader IS and the wrong one for what they
   * are DOING. Put a frequent bottom-writer beside it — a streaming answer
   * resizing rows many times a second — and escaping the bottom requires moving
   * more than 80px between two writes, in one go. A wheel notch does not do
   * that: WebKit animates wheel input in roughly 15–40px steps, so a reader can
   * push repeatedly against a feed that pulls back every frame and never get
   * away. That is the "it jumps back up" report, and the mechanism is a trap
   * rather than a race — no amount of tuning the write policy escapes it,
   * because the writes are correct for a reader the code believes is at the
   * bottom.
   *
   * A wheel or a touch is the reader saying otherwise, before any of it shows
   * up in a scroll offset. Passive listeners: this only ever reads the event.
   *
   * DROPPING THE PIN IS NOT ENOUGH ON ITS OWN, and measuring it is the only
   * reason I know that. WebKit scrolls a wheel notch as an ANIMATION, so the
   * scroll event that follows still reports a position inside the 80px band —
   * `onScroll` re-pins, the next frame writes the bottom, and the notch is
   * undone. Measured with a bottom-writer running and twelve ordinary upward
   * notches: Chromium escaped 1440px on the listener alone, WebKit moved 0px.
   *
   * So the release LATCHES. Once the reader has asked to leave, returning to the
   * end is what re-pins them — genuinely at it, not merely near it — and the
   * 80px band goes back to meaning only what it should have meant all along:
   * whether to offer the jump affordance.
   *
   * AND ARRIVAL MUST NOT DEPEND ON THE GEOMETRY AGREEING (round 2, the
   * recording of 2026-08-17). In release Safari the maximum the engine will
   * scroll to runs stale — 115px short of the DOM's, measured live (see
   * `writeBottom`) — and against that ceiling "genuinely at the end" is a
   * place the reader is REFUSED: 96 recorded wheel-down notches got zero
   * pixels, `gap <= 4` never fired, the pin could never re-engage, and the
   * feed froze with the jump affordance on. So the wheel answers what the
   * offset cannot: a reader pushing DOWN while the offset refuses to move is
   * arriving in the only sense that matters, and gets the pin, the anchor,
   * and a healed write of the bottom. Two spaced notches, not one — see
   * `STUCK_NOTCH_SPACING_MS` for why fast honest scrolling cannot trip it —
   * and none of it counts while an inner scroller is the one consuming the
   * wheel.
   */
  useEffect(() => {
    const el = scrollerRef.current
    if (!el) return
    const release = (): void => {
      pinnedToBottom.current = false
      releasedByIntent.current = true
      // The engine's anchor must let go WITH the pin: leaving it eligible is
      // exactly the measured trap where anchoring undoes every upward wheel
      // notch (0px of escape in WebKit).
      setAnchorEnd(el, false)
    }
    // Only UPWARD wheeling counts. Wheeling down at the bottom is not a request
    // to leave it, and treating it as one would drop the pin on a reader who
    // is trying to follow the stream.
    const onWheel = (e: WheelEvent): void => {
      if (e.deltaY < 0) {
        release()
        stuckNotches.current = 0
        stuckNotchTop.current = null
        return
      }
      if (e.deltaY === 0) return
      lastWheelDownAt.current = performance.now()
      if (pinnedToBottom.current) {
        stuckNotches.current = 0
        stuckNotchTop.current = null
        return
      }
      if (innerScrollerHasTheWheel(e.target, el)) {
        stuckNotches.current = 0
        stuckNotchTop.current = null
        return
      }
      const now = performance.now()
      const top = el.scrollTop
      if (stuckNotchTop.current !== null && Math.abs(top - stuckNotchTop.current) < 1) {
        // Same offset as the last counted notch. Count it only if enough time
        // has passed for the engine to have APPLIED that notch — inside the
        // window this is async lag, not the clamp, and it neither counts nor
        // resets what came before it.
        if (now - stuckNotchAt.current < STUCK_NOTCH_SPACING_MS) return
        stuckNotchAt.current = now
        stuckNotches.current += 1
        if (stuckNotches.current < 2) return
        // Arrival by intent: pin, arm, and write the bottom through the heal.
        stuckNotches.current = 0
        stuckNotchTop.current = null
        releasedByIntent.current = false
        pinnedToBottom.current = true
        setAnchorEnd(el, true)
        settleToBottom(el, pinnedToBottom)
        setAtBottom(true)
        syncStickyPromptPositions()
        return
      }
      // A moving offset — or the first notch of an approach. A fresh baseline
      // either way.
      stuckNotchTop.current = top
      stuckNotchAt.current = now
      stuckNotches.current = 1
    }
    el.addEventListener('wheel', onWheel, { passive: true })
    // Touch has no direction until the finger moves, and a drag that turns out
    // to go down re-pins through `onScroll` a frame later at no cost.
    el.addEventListener('touchstart', release, { passive: true })
    return () => {
      el.removeEventListener('wheel', onWheel)
      el.removeEventListener('touchstart', release)
    }
  }, [scrollerRef, pinnedToBottom, syncStickyPromptPositions])

  const onScroll = useCallback(() => {
    const el = scrollerRef.current
    if (!el) return
    const gap = el.scrollHeight - el.scrollTop - el.clientHeight
    const near = gap < 80
    // DOWNWARD MOVEMENT RE-ARMS THE ENGINE'S END ANCHOR, before arrival
    // (POD-1160). Two reasons it cannot wait for the bottom: an eligible
    // anchor below the viewport is inert, so granting early costs nothing —
    // and in an ANCHORING WebKit the grant is what refreshes the engine's
    // stale maximum scroll. (Release Safari has no anchoring, so there the
    // grant refreshes nothing — `writeBottom`'s heal and the wheel listeners'
    // arrival-by-intent carry that browser instead.) Direction from the
    // scroll offset itself so wheel, touch and scrollbar drags all count.
    const goingDown = el.scrollTop > lastScrollTop.current
    lastScrollTop.current = el.scrollTop
    if (goingDown) setAnchorEnd(el, true)
    // NEAR THE END AND FOLLOWING IT ARE TWO QUESTIONS. `near` decides whether to
    // offer the jump affordance, and has always been generous on purpose. The
    // PIN is whether to keep writing the bottom under the reader, and after they
    // have asked to leave, "nearly there" is not consent to be taken back — see
    // the intent listeners above. Only arriving at the end re-pins them, within
    // the pixel or so of fractional residue WebKit reports at a true bottom.
    pinnedToBottom.current = releasedByIntent.current ? gap <= 4 : near
    if (pinnedToBottom.current) releasedByIntent.current = false
    // ...and UPWARD movement that has genuinely left the bottom revokes it —
    // the scrollbar-drag case, which raises no wheel or touch intent. Never
    // while pinned: a clamp after content below unmounts also reads as an
    // upward move, and the pin is exactly what should survive that. And never
    // for ENGINE motion (round 2): a rubber band settling onto release
    // Safari's stale maximum is an upward move inside the stale-clamp band,
    // moments after the reader's own wheel-down — reading it as a drag
    // revoked the re-arm mid-gesture, every gesture, which is what kept the
    // arm from ever surviving to a layout pass. Only travel clearly past the
    // band, outside any wheel gesture, is a drag.
    if (
      !goingDown &&
      !pinnedToBottom.current &&
      gap > REVOKE_TRAVEL_PX &&
      performance.now() - lastWheelDownAt.current > WHEEL_GESTURE_MS
    ) {
      setAnchorEnd(el, false)
    }
    setAtBottom(near)
    syncStickyPromptPositions()
    // Near the TOP and more exists above → reveal/fetch older content.
    if (el.scrollTop < 200 && moreAbove) loadOlder()
  }, [scrollerRef, pinnedToBottom, syncStickyPromptPositions, moreAbove, loadOlder])

  /** Follow an arriving row's own growth for `ms`, as the only writer. Does
   *  nothing at all if the reader is not at the end — a row unrolling out of
   *  sight must never pull them back to it. */
  const claimScrollForArrival = useCallback(
    (ms: number) => {
      const el = scrollerRef.current
      if (!el || !pinnedToBottom.current) return
      const alreadyRunning = arrivalHolds()
      arrivalClaim.current = performance.now() + ms
      if (alreadyRunning) return
      const step = (): void => {
        if (!pinnedToBottom.current || !arrivalHolds()) {
          arrivalClaim.current = 0
          // The observers stood down while this ran, so the shelf's geometry is
          // one pass stale by the time the claim ends. Settle it once here
          // rather than on every frame, which is the whole point.
          syncStickyPromptPositions()
          return
        }
        writeBottom(el)
        requestAnimationFrame(step)
      }
      step()
    },
    [scrollerRef, pinnedToBottom, arrivalHolds, syncStickyPromptPositions],
  )

  const jumpToBottom = useCallback(() => {
    const el = scrollerRef.current
    if (!el) return
    pinnedToBottom.current = true
    releasedByIntent.current = false
    setAnchorEnd(el, true)
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
    releasedByIntent.current = false
    const el = scrollerRef.current
    if (el) setAnchorEnd(el, true)
    setAtBottom(true)
  }, [pinnedToBottom, scrollerRef])

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
    claimScrollForArrival,
  }
}
