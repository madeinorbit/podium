import type { CSSProperties, JSX } from 'react'

/**
 * The ⌘-hold digit (POD-790), drawn OVER the row's identity square.
 *
 * It covers the square exactly rather than sitting beside it. Two reasons: the
 * row's geometry cannot change because a modifier is down — a column that
 * reflows under your hand is unusable — and the square is the one mark in the
 * row that is already an identifier, so the digit stands in for it for as long
 * as the digit is what you would type. Nothing else in the row moves or fades.
 *
 * Chip ground and a strong rim: the shell's raised-control vocabulary, so the
 * badge reads as a KEY sitting on the row rather than as new status about it.
 * No colour — this says nothing about the task, only about the keyboard.
 */
export function RowShortcutBadge({
  digit,
  size = 30,
  radius,
}: {
  digit: number
  /** Square edge in px, matched to the mark underneath (30 wide rows, 32 rail). */
  size?: number
  /** Corner override, matched to the mark underneath — the rail's tile takes a
   *  9px corner, and a badge that covers it exactly must take the same one. */
  radius?: number
}): JSX.Element {
  const style: CSSProperties = {
    borderRadius: radius ?? (size >= 26 ? 7 : Math.round((size / 26) * 7)),
    // The digit runs a step larger than the square's own number: it is a single
    // glyph on an empty ground, and it has to be legible at a glance in the
    // moment before the operator commits to a keystroke.
    fontSize: Math.round(size * 0.44),
  }
  return (
    <span
      aria-hidden="true"
      data-testid="row-shortcut-badge"
      data-shortcut-digit={digit}
      className="pointer-events-none absolute inset-0 z-[2] flex items-center justify-center bg-chip font-mono leading-none font-semibold tabular-nums text-text-strong shadow-[inset_0_0_0_1px_var(--border-strong)]"
      style={style}
    >
      {digit}
    </span>
  )
}
