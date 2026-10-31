/**
 * ONE SET OF NUMBERS FOR EVERY MOVING THING IN THE WORK SIDEBAR (POD-2080).
 *
 * Rows arriving and leaving, folds opening and shutting, rows and folders
 * trading places, the lane switch: each used to carry its own duration and
 * curve, and they had drifted to between 0.7s and 1.6s for a row to settle.
 * The operator's call was "fast, elegant ease-in and ease-out", so every one of
 * them now reads from here, and the CSS twins live in `motion.css` as
 * `--motion-*` custom properties with the same values.
 *
 * - Entering is a strong ease-out: it is at full speed on the first frame,
 *   which is what makes a short animation feel immediate rather than late.
 * - Leaving is a short ease-in: the thing gathers speed and is gone, so the
 *   eye is already on what replaces it.
 * - A fold's height uses the standard decelerate curve. A strong expo-out over
 *   six hundred pixels of column spends most of its travel in two frames and
 *   then drifts (measured in POD-1253); this one moves in one gesture.
 *
 * Only transform and opacity animate per row. The fold panel's height is the
 * one layout animation, on a single clipped, `contain`ed element.
 */

export const EASE_OUT = [0.22, 1, 0.36, 1] as const
export const EASE_IN = [0.4, 0, 1, 1] as const
export const EASE_FOLD = [0.2, 0, 0, 1] as const

/** Seconds, as Motion takes them. */
export const MOTION_S = {
  /** A worklist row arriving. */
  enter: 0.18,
  /** A row leaving. `ROW_EXIT_MS` holds the row just past this. */
  exit: 0.14,
  /** Rows and folders sliding to new places after an insert, removal or sort. */
  move: 0.2,
  /** A slot trading places under a drag: it has to keep up with the pointer. */
  slot: 0.16,
  foldOpen: 0.2,
  foldClose: 0.16,
  /** A folder drag folds every folder's rows away and back. */
  foldQuick: 0.12,
  /** The list cross-fading in when the lane switch changes lane. */
  lane: 0.14,
} as const

export const cssEase = (curve: readonly number[]): string => `cubic-bezier(${curve.join(', ')})`

/** Rows and folder sections moving to a new layout position. */
export const ROW_LAYOUT_TRANSITION = { duration: MOTION_S.move, ease: EASE_OUT }
