import { useEffect, useState } from 'react'

/**
 * A coarse clock that re-renders the caller every `intervalMs`. Used so timed
 * snoozes lapse on screen without a server round-trip. One tiny interval per
 * consumer — fine at minute granularity.
 */
export function useNow(intervalMs: number): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), intervalMs)
    return () => clearInterval(id)
  }, [intervalMs])
  return now
}
