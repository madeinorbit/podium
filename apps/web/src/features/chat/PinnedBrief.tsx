/**
 * THE PINNED BRIEF (POD-993 round 2) — the shelf drawn OVER the feed, holding
 * the question a long answer has pushed off the top of the screen.
 *
 * It overlays the column rather than sticking inside it because it must be able
 * to appear and leave WITHOUT MOVING A ROW. See `.brief-shelf-layer` in
 * styles.css for the full argument and the geometry.
 */
import type { JSX, MouseEvent as ReactMouseEvent, RefObject, WheelEvent } from 'react'
import { useLayoutEffect, useRef, useState } from 'react'
import type { PinnedBrief as PinnedBriefState } from './use-transcript-scroll'

/** However long the brief, the shelf stops here and scrolls — it is drawn OVER
 *  the feed, and a shelf that can cover the whole column is a modal nobody
 *  asked for. */
const OPEN_MAX = 320
/** Only if the stylesheet has not been reached yet, or `lh` is not understood.
 *  The live number is `--brief-lines` on `.brief-shelf-text`. */
const LINES_FALLBACK = 3

/**
 * THE TWO NUMBERS, READ WHERE NEITHER CAN DEPEND ON THE ANSWER.
 *
 * `content` is how tall the brief is; `clamp` is how tall the shelf lets it be.
 * "Is anything hidden" is the comparison, and the ONE property this needs is
 * that neither number moves when the answer changes:
 *
 *  - `scrollHeight` is the CONTENT. A `max-height` caps a box, it does not pad
 *    one, so this reads the same whether the shelf is open or shut — and, more
 *    to the point, it reads the same DURING the open/close transition, when the
 *    box height is a number the easing curve happens to be passing through.
 *  - the clamp is computed from the element's own line box rather than read off
 *    its height, so it does not become "the content" the moment the brief is
 *    short enough to fit.
 *
 * That is the whole guard against the flicker. Everything the answer touches —
 * the fade, and whether the control is offered — changes `visibility` and a
 * mask, and the control's box is reserved either way, so nothing it does can
 * relay out the text and ask the question again with a different answer.
 */
function measureBrief(el: HTMLElement): { content: number; clamp: number } {
  const style = getComputedStyle(el)
  const lineHeight = Number.parseFloat(style.lineHeight)
  const lines = Number.parseFloat(style.getPropertyValue('--brief-lines')) || LINES_FALLBACK
  return {
    content: el.scrollHeight,
    // `line-height: normal` (or no stylesheet at all) leaves nothing to multiply
    // — fall back to the box, which is the clamp whenever the brief overflows it.
    clamp: Number.isFinite(lineHeight) ? lineHeight * lines : el.clientHeight,
  }
}

export function PinnedBrief({
  brief,
  scrollerRef,
  onBodyClick,
}: {
  brief: PinnedBriefState | null
  /** The feed under the shelf — see `onWheel` below for why it is needed. */
  scrollerRef: RefObject<HTMLDivElement | null>
  /** The row's own delegated chat-md handling, so the refs, file links and code
   *  copy buttons cloned into the shelf are as live here as in the column. The
   *  shelf is not a descendant of the row, so it cannot inherit the delegation
   *  and would otherwise be a wall of dead chips. */
  onBodyClick: (e: ReactMouseEvent) => void
}): JSX.Element | null {
  // Opening is a gesture that belongs to the MOMENT, not to the message: any
  // change of which brief the shelf is carrying closes it again, including
  // scrolling back to one that was open earlier. Adjusting during render rather
  // than in an effect, which is React's own answer to derived state — there is
  // never a frame in which the new brief is drawn at the old brief's height.
  const [pin, setPin] = useState<{ key: string | null; open: boolean }>({ key: null, open: false })
  const key = brief?.key ?? null
  if (pin.key !== key) setPin({ key, open: false })
  const open = pin.key === key && pin.open

  /**
   * IS IT ACTUALLY CUT? The shelf clamps at three lines, and most briefs are
   * shorter than that — so offering "Show full" on every one of them, and fading
   * a last line that has nothing under it, is chrome for a problem the reader
   * does not have. Measured rather than guessed, because the answer depends on
   * the pane width: the same sentence is two lines wide and five lines narrow.
   */
  const textRef = useRef<HTMLDivElement | null>(null)
  const [size, setSize] = useState<{ content: number; clamp: number }>({ content: 0, clamp: 0 })
  useLayoutEffect(() => {
    const el = textRef.current
    if (!el) return
    // Same object back when nothing moved, so a resize that changes only the
    // WIDTH of a brief that still fits does not re-render the shelf at all.
    const measure = (): void =>
      setSize((prev) => {
        const next = measureBrief(el)
        return prev.content === next.content && prev.clamp === next.clamp ? prev : next
      })
    measure()
    if (typeof ResizeObserver === 'undefined') return
    // Re-measure as the pane is dragged: a control that should exist at one
    // width and not another has to appear and disappear with it.
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => ro.disconnect()
    // ...AND WHEN THE SHELF CHANGES HANDS. This ran once on mount, so the height
    // measured for the FIRST brief was still in force for every brief after it:
    // scroll from a one-line prompt to a ten-line one and the shelf clamped it
    // with no "Show full" anywhere, because `clipped` still described the prompt
    // before it. The observer does not cover this — the box never resizes, only
    // its contents do.
  }, [brief?.key, brief?.html])
  // A line box is not a whole number of pixels at every zoom and every density,
  // so three lines of content can measure a hair over three lines of clamp. One
  // pixel of slack is the difference between "the brief has a fourth line" and
  // "the browser rounded" — without it the control blinks on a brief that fits.
  const clipped = size.content > size.clamp + 1

  if (!brief) return null

  /**
   * THE SHELF IS NOT IN THE SCROLLER, SO THE WHEEL HAS TO BE HANDED BACK.
   *
   * It is drawn across the top of the reading column — exactly where a pointer
   * rests — and it is a SIBLING of the scroller, not a child, so a wheel event
   * over it finds no scrollable ancestor and the feed simply stops responding
   * until the reader moves the mouse off. Forwarding the delta is the whole fix.
   * Not `pointer-events: none` on the shelf instead: the toggle and the brief's
   * own refs have to stay clickable.
   */
  const onWheel = (e: WheelEvent): void => {
    const el = scrollerRef.current
    if (!el) return
    // An expanded shelf scrolls itself first, and only hands the feed what it
    // could not use — the browser's own overscroll behaviour, by hand.
    const inner = e.currentTarget.querySelector<HTMLElement>('.brief-shelf-text')
    if (open && inner) {
      const room =
        e.deltaY > 0 ? inner.scrollHeight - inner.clientHeight - inner.scrollTop : inner.scrollTop
      if (room > 0) return
    }
    el.scrollTop += e.deltaY
  }

  return (
    <div className="brief-shelf-layer" data-testid="pinned-brief">
      {/* biome-ignore lint/a11y/noStaticElementInteractions: the wheel handler restores default scrolling the overlay would otherwise swallow; the click handler activates only anchors the markdown pass emitted */}
      {/* biome-ignore lint/a11y/useKeyWithClickEvents: keyboard users reach those anchors and the toggle natively */}
      <div
        className="brief-shelf"
        data-open={open ? 'true' : undefined}
        data-clipped={clipped && !open ? 'true' : undefined}
        onWheel={onWheel}
        onClick={onBodyClick}
      >
        <div
          // `chat-md` on purpose: the shelf is carrying the reader's own
          // markdown, and expanded it may be a pasted spec with lists and code
          // in it. Without the class those get the browser's defaults — a 1em
          // paragraph margin alone would push the first line most of the way out
          // of a two-line clamp.
          ref={textRef}
          className="chat-md brief-shelf-text"
          // ONLY THE OPEN HEIGHT IS WRITTEN FROM HERE. Shut, the clamp is the
          // stylesheet's — three lines of whatever the shell set the brief in,
          // see `.brief-shelf-text`. It used to be an inline 69px on every
          // render, which is how compact density ended up clamping at three
          // lines and a sliver of a fourth: the number was in a file that could
          // not see the one that changed the line-height.
          //
          // Open, the expand travels exactly the distance the text needs and
          // stops, because a transition needs two real numbers — `max-height` to
          // a keyword does not animate at all, and to a cap far above the
          // content it eases across space the text does not occupy, which on the
          // way back is a pause before anything moves.
          style={open ? { maxHeight: `${Math.min(size.content, OPEN_MAX)}px` } : undefined}
          // biome-ignore lint/security/noDangerouslySetInnerHtml: lifted verbatim from the row's own body, which renderMarkdown already sanitized
          dangerouslySetInnerHTML={{ __html: brief.html }}
        />
        <div className="brief-shelf-side">
          {brief.time !== '' && <span className="brief-shelf-time">{brief.time}</span>}
          {/* ALWAYS IN THE LAYOUT, EVEN WHEN THERE IS NOTHING TO OFFER.
              Rendering it conditionally made the shelf flicker without end, and
              the loop is entirely of its own making: the toggle sits beside the
              text, so ADDING it narrows the text column, and a brief near the
              three-line boundary then wraps to a fourth line — which is what
              "clipped" means, so the toggle stays. Take it away and the column
              widens, the same brief fits in three lines, so it is not clipped,
              so the toggle goes — and the measurement that decides this is a
              ResizeObserver on the text, which the width change wakes. Two
              stable states, each of which destroys the conditions for itself.
              Reserving the space breaks the cycle at the only place it can be
              broken: the measured width no longer depends on the answer. */}
          <button
            data-pressable
            type="button"
            className="brief-shelf-toggle"
            data-testid="prompt-expand-toggle"
            aria-expanded={open}
            // `visibility`, never `hidden`/`display:none` — those free the box
            // again and hand the loop straight back.
            data-idle={clipped || open ? undefined : 'true'}
            aria-hidden={clipped || open ? undefined : true}
            tabIndex={clipped || open ? undefined : -1}
            onClick={() => {
              setPin({ key: brief.key, open: !open })
            }}
          >
            {open ? 'Show less' : 'Show full'}
          </button>
        </div>
      </div>
    </div>
  )
}
