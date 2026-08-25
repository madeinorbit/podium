import { useLayoutEffect, useState } from 'react'
import { usePanelVisible } from '@/app/panel-visible'

/**
 * A coarse clock that re-renders the caller every `intervalMs`. Used so timed
 * snoozes lapse on screen without a server round-trip. One tiny interval per
 * consumer — fine at minute granularity.
 *
 * Pass `enabled: false` to stop the clock: a per-second consumer that only
 * matters while something is on screen (a startup wait) must not re-render a
 * warm hidden panel once a second for the life of the session. Re-enabling
 * resamples immediately, so the caller never renders the value it froze at.
 *
 * A hidden deck panel stops the clock automatically. Callers outside a deck
 * panel read the context default and keep their existing behavior.
 */
export function useNow(intervalMs: number, enabled = true): number {
  const painted = usePanelVisible()
  const live = enabled && painted
  const [now, setNow] = useState(() => Date.now())
  // Resample before paint so a revealed panel never shows its frozen timestamp.
  useLayoutEffect(() => {
    if (!live) return
    setNow(Date.now())
    const id = setInterval(() => setNow(Date.now()), intervalMs)
    return () => clearInterval(id)
  }, [intervalMs, live])
  return now
}
