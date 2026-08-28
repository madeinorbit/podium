/**
 * A SHELL COLUMN'S FOLD, as a gesture instead of a state flip (POD-1584).
 *
 * The left sidebar's two states are two SUBTREES — the work list and the 58px
 * identity rail — so collapsing it swapped one for the other in a single frame
 * and a quarter of the window arrived or vanished with nothing attached to it.
 * The flight deck next to it had already been given a width animation; the work
 * list, which is the column an operator opens and shuts most, had none.
 *
 * What makes that animatable is a node that OUTLIVES the swap. `ref` goes on it,
 * the hook drives its width, and the two subtrees come and go inside it.
 *
 * The two rules the callers depend on, both load-bearing:
 *
 * 1. REACT COMMITS THE END WIDTH; WAAPI holds the start over it for the whole
 *    motion. Commit the start instead and `cancel()` on finish uncovers it for
 *    the frame before the state update lands — the column snaps back open and
 *    shuts again. This is the flight deck's rule, kept.
 * 2. `folding` STAYS TRUE FOR THE LENGTH OF THE GESTURE, so a caller can clip
 *    its wrapper and hold the OPEN subtree mounted in both directions. Swapping
 *    the rail in on the press instead leaves a 58px rail in a 300px box with the
 *    remaining ground closing beside it — that is a gap sliding shut, not a
 *    column folding.
 *
 * ---
 *
 * WHAT POD-1658 ADDED, and why the fold still looked wrong with all of the
 * above already true. Both were measured off the shipping harness (`?fold=1`),
 * not reasoned about:
 *
 * 3. THE SWAP AT THE END WAS A DETONATION. Rule 2 holds the OPEN subtree for the
 *    whole collapse, so the last animated frame is the work list clipped to its
 *    leftmost 58px — truncated row titles, a half-cut filter box, the QR block.
 *    The frame after it is the rail: centred 36px identity tiles on a different
 *    vertical rhythm. Every element in the column moved 20–90px in one frame,
 *    at the exact moment the eye had settled. The old comment claimed the cut
 *    "lands on matching pixels"; the filmstrip says it lands on a different
 *    composition. So the hook now also drives a GHOST of the rail (`ghostRef`)
 *    that dissolves in over the collapse and out over the expand. The swap
 *    still happens — underneath an opaque rail that is already there, which is
 *    what makes it invisible.
 *
 * 4. INTERRUPTING THE FOLD TELEPORTED THE COLUMN. `fold()` cancelled the running
 *    animation and only THEN measured, so it measured the width React had
 *    committed — the far end — instead of the width on screen. Re-pressing
 *    120ms into a collapse was measured jumping the column from 58px back to
 *    306px and replaying the whole gesture. The live width is now read BEFORE
 *    the cancel, and the new leg is shortened in proportion to the ground it has
 *    left to cover, so a reversal near the end is a short correction and not a
 *    full-length crawl across 30 pixels.
 *
 * ---
 *
 * WHAT POD-1672 CHANGED, from a screen recording and from stepping the frozen
 * animations one progress point at a time in the fold harness. The swap was
 * covered; the gesture around it was not.
 *
 * 5. THE CROSSFADE RAN OVER A STATIONARY COLUMN. POD-1658 timed the dissolve to
 *    OWN the dead tail of the old ease-out — 129ms to 280ms, by which point the
 *    column had 9 of its 248 pixels left to travel. So for 150ms the only thing
 *    moving on screen was two legible compositions at half strength dissolving
 *    through each other, the work list's row titles crossing the rail's ID tiles
 *    on a different vertical rhythm, with no motion to explain either. That
 *    reads as a shimmer, and it is what "very flickery" was pointing at.
 *
 *    Filling dead air with a crossfade was the wrong half of the trade. The
 *    dead air is now gone from the curve itself (`COLUMN_FOLD_EASE`), and what is left
 *    of the swap happens where the column is travelling fastest.
 *
 * 6. AND IT IS NOT A CROSSFADE AT ALL ANY MORE. Hurrying it was not enough: at
 *    half opacity the rail's ID tiles and the work list's row numbers are BOTH
 *    legible, seven pixels apart on two different vertical rhythms, and the eye
 *    reads that as one picture vibrating rather than two pictures trading
 *    places. Nothing about the timing fixes a picture that is genuinely double.
 *
 *    So the ghost is now two layers and they go in SEQUENCE. Its SURFACE — the
 *    column's own ground, plus a backdrop blur — comes up first and alone, over
 *    24%→40% of the leg, and by the end of that the work list is gone behind an
 *    opaque lid. Only then does its CONTENT arrive, over 40%→76%, onto a lid
 *    that is already opaque. There is no frame with two compositions in it. The
 *    expand runs it backwards: the rail's content leaves over 4%→26%, then the
 *    lid over 27%→52%, so the work list is revealed by something lifting off it
 *    rather than fading up through it.
 *
 *    The windows do not overlap at all, by a millisecond of rounding. The beat
 *    where the lid is up and the rail is not yet on it — a plain sidebar-toned
 *    slab — is where the column crosses from 200px to 116px, which is the
 *    fastest the gesture ever moves. It is not a beat anyone sees; it is the
 *    seam it removes that they do.
 *
 * 7. THE RAIL ARRIVES, IT DOES NOT MATERIALISE. Collapsing, its content covers
 *    the last six pixels in from the left on the fold's own curve, with the edge
 *    that is closing over it. Opacity alone puts a picture where there was none;
 *    a picture that moves in has somewhere it came from. Expanding, it holds
 *    still and only fades — see `GHOST_SLIDE_PX`.
 *
 * 8. THE LAST FRAME FLASHED THE WORK LIST BACK. `cancel()` on the dissolve drops
 *    its fill, and the value underneath is the inline opacity the ghost MOUNTED
 *    with — 0 on a collapse. React's `setWidth(null)` is what unmounts the ghost
 *    and swaps the rail in, and it is a state update, so between the cancel and
 *    that commit the browser is free to paint a frame with the rail invisible
 *    and the clipped work list under it. Measured in the recording: the settled
 *    rail, one frame of clipped work list, the rail again. The ends are now
 *    written to the nodes BEFORE the fills are dropped, and the commit that
 *    unmounts the ghost is flushed in the same task.
 *
 * Reduced motion takes none of it: the state simply flips, which is what a
 * folded column looks like to someone who asked not to be moved.
 */
import { useReducedMotion } from 'motion/react'
import { type RefObject, useEffect, useRef, useState } from 'react'
import { flushSync } from 'react-dom'
import { COLUMN_FOLD_EASE, COLUMN_FOLD_MS } from './sidebar-common'

/** The shortest leg worth animating. Below this a correction reads as a stutter
 *  rather than a movement, and an interrupted fold can ask for very little. */
const FOLD_MIN_MS = 120

/** The two halves of the swap, as fractions of the leg's own duration, and in
 *  the order they run. LID is the ghost's surface going opaque over the work
 *  list; RAIL is its content arriving on top of the lid. They barely overlap on
 *  purpose — the whole point is that the two compositions are never both
 *  visible (rule 6) — and both windows sit inside the stretch where `COLUMN_FOLD_EASE`
 *  is moving the column fastest, so neither is ever performed in front of a
 *  column standing still (rule 5). */
const COLLAPSE_LID = { start: 0.24, end: 0.4 }
const COLLAPSE_RAIL = { start: 0.4, end: 0.76 }
/** Expanding, the same two events in the mirror order: the rail leaves the lid,
 *  then the lid lifts off the work list. */
const EXPAND_RAIL = { start: 0.04, end: 0.26 }
const EXPAND_LID = { start: 0.27, end: 0.52 }

/** How far the rail's content travels as it ARRIVES, from the left, with the
 *  edge that is closing over it. Small enough to read as arrival rather than as
 *  a second animation with opinions of its own.
 *
 *  Only on the way in. Expanding, the rail is not going anywhere — the column
 *  is — so an exit vector of its own is motion with no cause, and it shears the
 *  rail's `PINNED` and `PODIUM` labels against the column's left edge on the
 *  way out, which is the one artifact a fold this size cannot hide. It settles
 *  home and fades instead. */
const GHOST_SLIDE_PX = 6

/** A stretch of one leg, as fractions of its duration. */
interface Fraction {
  start: number
  end: number
}

export interface ColumnFold {
  /** Goes on the ONE node that survives the swap between the two subtrees. */
  ref: RefObject<HTMLDivElement | null>
  /** Goes on the ghost of the FOLDED subtree, rendered whenever `folding`. It
   *  must be pixel-identical to the real folded column and inert. */
  ghostRef: RefObject<HTMLDivElement | null>
  /** Goes on the ghost's CONTENT, one node inside `ghostRef`. It carries the
   *  rail's own arrival — its fade and its slide — which runs AFTER the ghost
   *  itself has gone opaque, so the rail never lands on a visible work list
   *  (rule 6). The ghost is the lid and must stay put; a lid that moves is a
   *  gap. */
  ghostContentRef: RefObject<HTMLDivElement | null>
  /** The width to commit — the END of the motion, or null once it has landed. */
  width: number | null
  /** True for the length of the gesture. Clip the wrapper; hold the open subtree;
   *  render the ghost. */
  folding: boolean
  /** Fold to `collapsed`. Flips the caller's state as part of the same commit. */
  fold: (collapsed: boolean) => void
}

export function useColumnFold({
  foldedWidth,
  openWidth,
  onFold,
}: {
  /** The column's closed width. Not 0 — this shell folds columns to a rail. */
  foldedWidth: number
  /** Fallback for the open end, used whenever there is nothing to measure. */
  openWidth: () => number
  /** The caller's own collapsed state, flipped inside the fold's commit. */
  onFold: (collapsed: boolean) => void
}): ColumnFold {
  const ref = useRef<HTMLDivElement>(null)
  const ghostRef = useRef<HTMLDivElement>(null)
  const ghostContentRef = useRef<HTMLDivElement>(null)
  const animation = useRef<Animation | null>(null)
  const lid = useRef<Animation | null>(null)
  const rail = useRef<Animation | null>(null)
  const slide = useRef<Animation | null>(null)
  const [width, setWidth] = useState<number | null>(null)
  const reduceMotion = useReducedMotion()
  useEffect(
    () => () => {
      animation.current?.cancel()
      lid.current?.cancel()
      rail.current?.cancel()
      slide.current?.cancel()
    },
    [],
  )

  const fold = (collapsed: boolean): void => {
    const node = ref.current
    const running = animation.current
    // BEFORE the cancel, and only while something is running: `cancel()` drops
    // the fill and snaps the node back to the width React committed, which is
    // the end this gesture is trying to leave. Reading after it is what made an
    // interrupted fold teleport (rule 4). The ghost's two channels are read on
    // the same terms, so a reversal picks both of them up where they stand
    // instead of restarting them from their own far ends.
    const live = running && node ? Math.round(node.getBoundingClientRect().width) : null
    const liveLid = running ? readOpacity(ghostRef.current) : null
    const liveRail = running ? readOpacity(ghostContentRef.current) : null
    const liveShift = running ? readShift(ghostContentRef.current) : null
    running?.cancel()
    lid.current?.cancel()
    rail.current?.cancel()
    slide.current?.cancel()
    animation.current = null
    lid.current = null
    rail.current = null
    slide.current = null
    if (reduceMotion) {
      setWidth(null)
      onFold(collapsed)
      return
    }
    // The LIVE width on the way in, not the persisted wish: flex pressure and a
    // viewport cap both leave the column narrower than the number in ui-state,
    // and a fold that starts from the wish jumps before it moves. On the way
    // OUT there is nothing to measure but the rail, so the wish is the answer.
    // Mid-gesture the column is somewhere between the two ends and measures as
    // neither, so an interrupted leg takes the wish as well.
    const measured = Math.round(node?.getBoundingClientRect().width ?? 0)
    const settledOpen = !running && collapsed && measured > foldedWidth ? measured : 0
    const open = settledOpen || openWidth()
    const from = live ?? (collapsed ? open : foldedWidth)
    const to = collapsed ? foldedWidth : open
    // Shorten the leg to the ground it actually has to cover. A reversal 30px
    // from the rail is a correction, not a second full fold.
    const span = Math.abs(open - foldedWidth) || 1
    const duration = Math.max(
      FOLD_MIN_MS,
      Math.round(COLUMN_FOLD_MS * Math.min(1, Math.abs(to - from) / span)),
    )
    flushSync(() => {
      onFold(collapsed)
      setWidth(to)
    })
    if (!node) {
      setWidth(null)
      return
    }
    const running2 = node.animate([{ width: `${from}px` }, { width: `${to}px` }], {
      duration,
      easing: COLUMN_FOLD_EASE,
      fill: 'both',
    })
    animation.current = running2
    const lidWindow = collapsed ? COLLAPSE_LID : EXPAND_LID
    const railWindow = collapsed ? COLLAPSE_RAIL : EXPAND_RAIL
    const to01 = collapsed ? 1 : 0
    // Home, both ways. Collapsing, the rail travels the last few pixels in from
    // the left; expanding, it stays where it is and only fades — and an
    // interrupted collapse still has somewhere to put it down.
    const shiftTo = 0
    const shiftFrom = liveShift ?? (collapsed ? -GHOST_SLIDE_PX : 0)
    lid.current = startFade({
      node: ghostRef.current,
      to: to01,
      from: liveLid,
      window_: lidWindow,
      duration,
    })
    rail.current = startFade({
      node: ghostContentRef.current,
      to: to01,
      from: liveRail,
      window_: railWindow,
      duration,
    })
    slide.current =
      shiftFrom === shiftTo
        ? null
        : startSlide({
            node: ghostContentRef.current,
            to: shiftTo,
            from: shiftFrom,
            window_: railWindow,
            duration,
          })
    running2.onfinish = () => {
      // PIN BEFORE CANCEL (rule 8). Dropping the fills first leaves the ghost on
      // the inline value it mounted with, and the commit that unmounts it is a
      // React state update — a frame can be painted in between, and it is the
      // one that flashes the clipped work list back over a settled rail.
      pin(ghostRef.current, ghostContentRef.current, to01, shiftTo)
      running2.cancel()
      lid.current?.cancel()
      rail.current?.cancel()
      slide.current?.cancel()
      if (animation.current === running2) animation.current = null
      lid.current = null
      rail.current = null
      slide.current = null
      // Hand the width back to layout: folded, the rail's own flex basis; open,
      // whatever the drag handle last said. An inline pixel left behind here
      // would win the next resize. Flushed, so the ghost leaves and the real
      // rail arrives in the same frame the fills were dropped in.
      flushSync(() => setWidth(null))
    }
  }

  return { ref, ghostRef, ghostContentRef, width, folding: width !== null, fold }
}

/** The ghost's opacity as it stands, so a reversal dissolves from what is on
 *  screen instead of restarting the crossfade from its own far end. */
function readOpacity(node: HTMLElement | null): number | null {
  if (!node || typeof getComputedStyle !== 'function') return null
  const value = Number.parseFloat(getComputedStyle(node).opacity)
  return Number.isFinite(value) ? value : null
}

/** The same question for the slide: the translation on screen, in pixels, off
 *  the resolved matrix rather than off the opacity it happens to share a window
 *  with — the two channels are eased differently and do not stay in step. */
function readShift(node: HTMLElement | null): number | null {
  if (!node || typeof getComputedStyle !== 'function') return null
  const transform = getComputedStyle(node).transform
  if (!transform || transform === 'none') return 0
  const parts = transform
    .slice(transform.indexOf('(') + 1, transform.lastIndexOf(')'))
    .split(',')
    .map((part) => Number.parseFloat(part))
  // matrix(a, b, c, d, tx, ty) and matrix3d(...16) put tx at 4 and 12.
  const tx = parts.length === 16 ? parts[12] : parts[4]
  return Number.isFinite(tx) ? (tx as number) : null
}

/** Write both channels' end values to the nodes. Called before the fills are
 *  dropped; see rule 8. */
function pin(
  ghost: HTMLElement | null,
  content: HTMLElement | null,
  opacity: number,
  shift: number,
): void {
  if (ghost) ghost.style.opacity = String(opacity)
  if (content) {
    content.style.opacity = String(opacity)
    content.style.transform = `translate3d(${shift}px, 0, 0)`
  }
}

/** A window of the leg, as the delay and duration WAAPI wants. */
function span(window_: Fraction, duration: number): { delay: number; duration: number } {
  return {
    delay: Math.round(duration * window_.start),
    duration: Math.max(1, Math.round(duration * (window_.end - window_.start))),
  }
}

function startFade({
  node,
  to,
  from,
  window_,
  duration,
}: {
  node: HTMLElement | null
  to: number
  from: number | null
  window_: Fraction
  duration: number
}): Animation | null {
  if (!node || typeof node.animate !== 'function') return null
  const start = from ?? (to === 1 ? 0 : 1)
  // Written to the node as well as to the keyframes. `fill: 'both'` holds this
  // value through the delay, but only from the moment WAAPI is attached, and
  // the ghost mounts one statement earlier — this leaves nothing for a stray
  // paint in between to find.
  node.style.opacity = String(start)
  return node.animate([{ opacity: String(start) }, { opacity: String(to) }], {
    ...span(window_, duration),
    // Linear: an opacity ramp that is eased spends its middle somewhere other
    // than half way, and half way is the only part of this anyone can see.
    easing: 'linear',
    fill: 'both',
  })
}

function startSlide({
  node,
  to,
  from,
  window_,
  duration,
}: {
  node: HTMLElement | null
  to: number
  from: number
  window_: Fraction
  duration: number
}): Animation | null {
  if (!node || typeof node.animate !== 'function') return null
  const at = (px: number): string => `translate3d(${px}px, 0, 0)`
  node.style.transform = at(from)
  return node.animate([{ transform: at(from) }, { transform: at(to) }], {
    ...span(window_, duration),
    // The column's own curve, so the rail decelerates into place with the edge
    // that is carrying it rather than on a clock of its own.
    easing: COLUMN_FOLD_EASE,
    fill: 'both',
  })
}
