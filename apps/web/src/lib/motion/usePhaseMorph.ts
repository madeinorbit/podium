/**
 * The one-shot mechanism of the motion grammar: morphs fire exactly once per
 * REAL phase transition, never on mount — a freshly mounted sidebar must not
 * replay thirty amber flashes, and a `.morph-*` class must never be applied/
 * removed/re-applied by unrelated re-renders (that would restart the CSS
 * animation and break the no-loop guarantee).
 *
 * Returns `null` until the observed value first CHANGES after mount; from then
 * on it returns the current value. Consumers apply the morph class only when
 * non-null and key the animated node by the value, so React remounts it once
 * per transition and the class then stays put across re-renders:
 *
 *   const morph = usePhaseMorph(phase)
 *   <span key={phase} className={cn(morph === 'waiting' && 'morph-flip-ago')}>
 */
import { useRef } from 'react'

export function usePhaseMorph<T>(value: T): T | null {
  const initial = useRef(value)
  const changed = useRef(false)
  // A one-way latch: writing during render is safe here because the write is
  // idempotent and depends only on props (StrictMode double-renders agree).
  if (value !== initial.current) changed.current = true
  return changed.current ? value : null
}
