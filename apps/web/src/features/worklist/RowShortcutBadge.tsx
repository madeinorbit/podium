import type { CSSProperties, JSX } from 'react'
import { isApplePlatform } from '@/lib/mod-chord'

/**
 * The hold-to-reveal shortcut (POD-790), drawn OVER the row's identity mark.
 * The modifier uses the same platform rule as other chord labels: ⌘ on Apple
 * hardware and ⌃ elsewhere, followed by the row's positional digit.
 *
 * It covers the mark exactly rather than sitting beside it. Two reasons: the
 * row's geometry cannot change because a modifier is down; a column that
 * reflows under your hand is unusable. The mark is already an identifier, so
 * the shortcut stands in for it while the digit is what you would type.
 * Nothing else in the row moves or fades.
 *
 * Chip ground and a strong rim: the shell's raised-control vocabulary, so the
 * badge reads as a KEY sitting on the row rather than as new status about it.
 * No colour: this says nothing about the task, only about the keyboard.
 */
export function RowShortcutBadge({
  digit,
  size = 30,
  radius,
}: {
  digit: number
  /** Size of the identity mark or reference underneath, in px. */
  size?: number
  /** Corner override, matched to the mark underneath — the rail's tile takes a
   *  9px corner, and a badge that covers it exactly must take the same one. */
  radius?: number
}): JSX.Element {
  const style: CSSProperties = {
    borderRadius: radius ?? (size >= 26 ? 7 : Math.round((size / 26) * 7)),
    // The modifier and digit must fit together without changing the mark's
    // bounds. Smaller type and tighter tracking leave room for both glyphs;
    // the 10px floor keeps the compact row-reference overlay legible at a glance.
    fontSize: Math.max(10, Math.round(size * 0.4)),
    letterSpacing: '-0.05em',
  }
  return (
    <span
      aria-hidden="true"
      data-testid="row-shortcut-badge"
      data-shortcut-digit={digit}
      className="pointer-events-none absolute inset-0 z-[2] flex items-center justify-center bg-chip font-mono leading-none font-semibold tabular-nums text-text-strong shadow-[inset_0_0_0_1px_var(--border-strong)]"
      style={style}
    >
      {isApplePlatform() ? '⌘' : '⌃'}
      {digit}
    </span>
  )
}
