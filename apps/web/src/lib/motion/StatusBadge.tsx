/**
 * Corner status badge of the motion grammar (.design/specs/motion.md §2.5):
 * sits on an ID square / rail icon (parent must be `position: relative`) and
 * carries the phase signal onto collapsed surfaces —
 *
 *   spinner — 13px dark-green circle with an 8px braille spinner (computing);
 *             enters with a one-shot tick-in.
 *   count   — amber numbered pill (waiting on you); pops in one-shot, and pops
 *             again when the count increases (keyed by the number).
 *   check   — green ✓ circle (done); soft one-shot pop.
 *   dot     — plain 10px amber dot, the wide-sidebar variant where the numbered
 *             pill lives in the row meta instead.
 *
 * All variants are perfectly still after their entry morph — the spinner glyph
 * is the only ongoing motion, and only while the agent computes.
 */
import type { CSSProperties, JSX } from 'react'
import { cn } from '@/lib/utils'
import { BrailleSpinner } from './BrailleSpinner'
import { usePhaseMorph } from './usePhaseMorph'

export type StatusBadgeKind = 'spinner' | 'count' | 'check' | 'dot'

export function StatusBadge({
  kind,
  count,
  ringColor = '#131318',
  className,
}: {
  /** Null keeps the transition latch mounted while rendering no badge. */
  kind: StatusBadgeKind | null
  /** Required for `count`; the pill pops again whenever it increases. */
  count?: number
  /** The backdrop the badge punches out of (rail/sidebar/bar background). */
  ringColor?: string
  className?: string
}): JSX.Element | null {
  // One token for "what the badge shows": a kind change OR a count change is a
  // transition worth a pop; a freshly mounted rail replays nothing.
  const morph = usePhaseMorph(kind === 'count' ? `count:${count}` : (kind ?? 'none'))

  if (kind === null) return null
  if (kind === 'count' && !count) return null

  if (kind === 'dot') {
    return (
      <span
        key="dot"
        role="img"
        aria-label="waiting on you"
        className={cn(
          'absolute -top-1 -right-1 size-2.5 rounded-full',
          morph && 'morph-pop',
          className,
        )}
        style={{ background: 'var(--motion-waiting)', border: `2px solid ${ringColor}` }}
      />
    )
  }

  const base =
    'absolute -top-[5px] -right-[5px] flex h-[13px] min-w-[13px] items-center justify-center rounded-full font-mono'
  if (kind === 'count') {
    return (
      <span
        key={`count:${count}`}
        role="img"
        aria-label={`${count} waiting on you`}
        className={cn(base, 'px-[3px] font-bold', morph && 'morph-pop', className)}
        style={{
          fontSize: 7.5,
          background: 'var(--motion-waiting)',
          color: 'var(--motion-waiting-ink)',
          border: `1px solid ${ringColor}`,
        }}
      >
        {count}
      </span>
    )
  }
  return (
    <span
      key={kind}
      role="img"
      aria-label={kind === 'check' ? 'done' : 'working'}
      className={cn(
        base,
        morph && (kind === 'check' ? 'morph-pop-soft' : 'morph-tick-in'),
        kind === 'check' && 'font-bold',
        className,
      )}
      style={
        {
          background: 'var(--motion-badge-bg)',
          border: '1px solid var(--motion-working)',
          color: 'var(--motion-working-bright)',
          '--spb-color': 'var(--motion-working-bright)',
          fontSize: 8,
        } as CSSProperties
      }
    >
      {kind === 'check' ? '✓' : <BrailleSpinner size={8} />}
    </span>
  )
}
