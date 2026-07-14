/**
 * THE spinner of the motion grammar (.design/specs/motion.md): 10 braille
 * frames animated as pure CSS `content` keyframes (motion.css `.spb`), 0.8s
 * steps — one stylesheet rule drives every instance, zero JS per frame. It is
 * the only permanent motion in the app and must render ONLY while an agent is
 * actually computing (motionPhase === 'working'); gating is the caller's job.
 */
import type { JSX } from 'react'
import { cn } from '@/lib/utils'

export function BrailleSpinner({
  size = 9,
  className,
}: {
  /** Glyph font-size in px: 9 sidebar rows/tabs, 10 mobile menu, 8 rail badge. */
  size?: number
  className?: string
}): JSX.Element {
  // Decorative: the accompanying timer/label carries the state for readers.
  return <span aria-hidden className={cn('spb', className)} style={{ fontSize: size }} />
}
