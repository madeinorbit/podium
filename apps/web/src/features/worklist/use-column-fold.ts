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
 *    that dissolves in over the tail of the collapse and out over the head of
 *    the expand. The swap still happens — underneath an opaque rail that is
 *    already there, which is what makes it invisible.
 *
 *    The dissolve is deliberately ASYMMETRIC. Collapsing it is late and slow:
 *    the rail is the destination ARRIVING, and it has the tail of the width
 *    curve to itself — a strong ease-out has spent 99% of its travel by 70% of
 *    its duration, so the last beat used to be dead air, and now it is the
 *    crossfade. Expanding it is early and fast: the rail is in the way, and the
 *    column is already two-thirds open 70ms in.
 *
 * 4. INTERRUPTING THE FOLD TELEPORTED THE COLUMN. `fold()` cancelled the running
 *    animation and only THEN measured, so it measured the width React had
 *    committed — the far end — instead of the width on screen. Re-pressing
 *    120ms into a collapse was measured jumping the column from 58px back to
 *    306px and replaying the whole gesture. The live width is now read BEFORE
 *    the cancel, and the new leg is shortened in proportion to the ground it has
 *    left to cover, so a reversal near the end is a short correction and not a
 *    full 280ms crawl across 30 pixels.
 *
 * Reduced motion takes none of it: the state simply flips, which is what a
 * folded column looks like to someone who asked not to be moved.
 */
import { useReducedMotion } from 'motion/react'
import { type RefObject, useEffect, useRef, useState } from 'react'
import { flushSync } from 'react-dom'
import { COLLAPSE_EASE, COLLAPSE_MS } from './sidebar-common'

/** The shortest leg worth animating. Below this a correction reads as a stutter
 *  rather than a movement, and an interrupted fold can ask for very little. */
const FOLD_MIN_MS = 120

/** The rail's dissolve, as fractions of the leg's own duration. Collapsing it
 *  owns the tail the width curve has already abandoned; expanding it clears out
 *  of the way while the column is still narrow. See rule 3 above. */
const DISSOLVE_IN = { start: 0.46, end: 1 }
const DISSOLVE_OUT = { start: 0, end: 0.32 }

export interface ColumnFold {
  /** Goes on the ONE node that survives the swap between the two subtrees. */
  ref: RefObject<HTMLDivElement | null>
  /** Goes on the ghost of the FOLDED subtree, rendered whenever `folding`. It
   *  must be pixel-identical to the real folded column and inert. */
  ghostRef: RefObject<HTMLDivElement | null>
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
  const animation = useRef<Animation | null>(null)
  const dissolve = useRef<Animation | null>(null)
  const [width, setWidth] = useState<number | null>(null)
  const reduceMotion = useReducedMotion()
  useEffect(
    () => () => {
      animation.current?.cancel()
      dissolve.current?.cancel()
    },
    [],
  )

  const fold = (collapsed: boolean): void => {
    const node = ref.current
    const running = animation.current
    // BEFORE the cancel, and only while something is running: `cancel()` drops
    // the fill and snaps the node back to the width React committed, which is
    // the end this gesture is trying to leave. Reading after it is what made an
    // interrupted fold teleport (rule 4).
    const live = running && node ? Math.round(node.getBoundingClientRect().width) : null
    const liveOpacity = running ? readOpacity(ghostRef.current) : null
    running?.cancel()
    dissolve.current?.cancel()
    animation.current = null
    dissolve.current = null
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
      Math.round(COLLAPSE_MS * Math.min(1, Math.abs(to - from) / span)),
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
      easing: COLLAPSE_EASE,
      fill: 'both',
    })
    animation.current = running2
    dissolve.current = startDissolve({
      node: ghostRef.current,
      to: collapsed ? 1 : 0,
      from: liveOpacity,
      duration,
    })
    running2.onfinish = () => {
      running2.cancel()
      dissolve.current?.cancel()
      if (animation.current === running2) animation.current = null
      dissolve.current = null
      // Hand the width back to layout: folded, the rail's own flex basis; open,
      // whatever the drag handle last said. An inline pixel left behind here
      // would win the next resize.
      setWidth(null)
    }
  }

  return { ref, ghostRef, width, folding: width !== null, fold }
}

/** The ghost's opacity as it stands, so a reversal dissolves from what is on
 *  screen instead of restarting the crossfade from its own far end. */
function readOpacity(node: HTMLElement | null): number | null {
  if (!node || typeof getComputedStyle !== 'function') return null
  const value = Number.parseFloat(getComputedStyle(node).opacity)
  return Number.isFinite(value) ? value : null
}

function startDissolve({
  node,
  to,
  from,
  duration,
}: {
  node: HTMLElement | null
  to: number
  from: number | null
  duration: number
}): Animation | null {
  if (!node || typeof node.animate !== 'function') return null
  const window_ = to === 1 ? DISSOLVE_IN : DISSOLVE_OUT
  const start = from ?? (to === 1 ? 0 : 1)
  // Written to the node as well as to the keyframes. `fill: 'both'` holds this
  // value through the delay, but only from the moment WAAPI is attached, and
  // the ghost mounts one statement earlier — this leaves nothing for a stray
  // paint in between to find.
  node.style.opacity = String(start)
  return node.animate([{ opacity: String(start) }, { opacity: String(to) }], {
    delay: Math.round(duration * window_.start),
    duration: Math.max(1, Math.round(duration * (window_.end - window_.start))),
    // Linear: both ends of a crossfade sum to one only if neither is eased.
    easing: 'linear',
    fill: 'both',
  })
}
