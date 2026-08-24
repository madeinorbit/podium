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
 * Reduced motion takes neither: the state simply flips, which is what a folded
 * column looks like to someone who asked not to be moved.
 */
import { useReducedMotion } from 'motion/react'
import { type RefObject, useEffect, useRef, useState } from 'react'
import { flushSync } from 'react-dom'
import { COLLAPSE_EASE, COLLAPSE_MS } from './sidebar-common'

export interface ColumnFold {
  /** Goes on the ONE node that survives the swap between the two subtrees. */
  ref: RefObject<HTMLDivElement | null>
  /** The width to commit — the END of the motion, or null once it has landed. */
  width: number | null
  /** True for the length of the gesture. Clip the wrapper; hold the open subtree. */
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
  const animation = useRef<Animation | null>(null)
  const [width, setWidth] = useState<number | null>(null)
  const reduceMotion = useReducedMotion()
  useEffect(() => () => animation.current?.cancel(), [])

  const fold = (collapsed: boolean): void => {
    animation.current?.cancel()
    animation.current = null
    if (reduceMotion) {
      setWidth(null)
      onFold(collapsed)
      return
    }
    // The LIVE width on the way in, not the persisted wish: flex pressure and a
    // viewport cap both leave the column narrower than the number in ui-state,
    // and a fold that starts from the wish jumps before it moves. On the way
    // OUT there is nothing to measure but the rail, so the wish is the answer.
    const measured = Math.round(ref.current?.getBoundingClientRect().width ?? 0)
    const open = (collapsed && measured > foldedWidth ? measured : 0) || openWidth()
    const from = collapsed ? open : foldedWidth
    const to = collapsed ? foldedWidth : open
    flushSync(() => {
      onFold(collapsed)
      setWidth(to)
    })
    const node = ref.current
    if (!node) {
      setWidth(null)
      return
    }
    const running = node.animate([{ width: `${from}px` }, { width: `${to}px` }], {
      duration: COLLAPSE_MS,
      easing: COLLAPSE_EASE,
      fill: 'both',
    })
    animation.current = running
    running.onfinish = () => {
      running.cancel()
      if (animation.current === running) animation.current = null
      // Hand the width back to layout: folded, the rail's own flex basis; open,
      // whatever the drag handle last said. An inline pixel left behind here
      // would win the next resize.
      setWidth(null)
    }
  }

  return { ref, width, folding: width !== null, fold }
}
