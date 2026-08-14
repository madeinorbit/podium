/**
 * THE PINNED BRIEF (POD-993 round 2) — the shelf drawn OVER the feed.
 *
 * A long answer pushes the question that caused it off the top of the screen,
 * and the reader loses the one piece of context every line below depends on. The
 * shelf is the answer to that, and the whole design of it follows from one
 * constraint: it must be able to appear and leave WITHOUT MOVING A ROW.
 *
 * That is why it is absolutely positioned over the column rather than sticky
 * inside it. A sticky row is still in the flow — it changes the height of the
 * document as it pins and unpins, so the words the reader is mid-sentence on
 * shift under them, and two consecutive briefs have to be hand-translated past
 * one another on every scroll frame. Overlaying costs one thing, occlusion, and
 * pays for it with a blur and a rim so what is underneath reads as underneath.
 *
 * It keeps the brief's own geometry — same radius, same measure, same ink — so
 * the reader recognises it as the message they wrote and not as a new kind of
 * chrome. What it adds is what a shelf needs and a message does not: a height.
 * Clamped to two lines behind a mask that fades the third, with one control on
 * the right to open it in place. Expanded, it scrolls inside itself and keeps
 * that control in reach.
 */
import type { JSX, MouseEvent as ReactMouseEvent, RefObject, WheelEvent } from 'react'
import { useState } from 'react'
import type { PinnedBrief as PinnedBriefState } from './use-transcript-scroll'

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
        onWheel={onWheel}
        onClick={onBodyClick}
      >
        <div
          // `chat-md` on purpose: the shelf is carrying the reader's own
          // markdown, and expanded it may be a pasted spec with lists and code
          // in it. Without the class those get the browser's defaults — a 1em
          // paragraph margin alone would push the first line most of the way out
          // of a two-line clamp.
          className="chat-md brief-shelf-text"
          // biome-ignore lint/security/noDangerouslySetInnerHtml: lifted verbatim from the row's own body, which renderMarkdown already sanitized
          dangerouslySetInnerHTML={{ __html: brief.html }}
        />
        <div className="brief-shelf-side">
          {brief.time !== '' && <span className="brief-shelf-time">{brief.time}</span>}
          <button
            data-pressable
            type="button"
            className="brief-shelf-toggle"
            data-testid="prompt-expand-toggle"
            aria-expanded={open}
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
