import type { CSSProperties, JSX } from 'react'
import { isApplePlatform } from '@/lib/mod-chord'

/** A modifier-and-digit shortcut over the row's identity square. The overlay
 * keeps row geometry fixed while the modifier is held. */
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
