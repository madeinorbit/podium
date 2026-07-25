import { useEffect, useState } from 'react'

/**
 * A coarse clock for derivations that age (relative stamps, grace windows).
 * One interval per caller, deliberately slow — the sidebar's derivation reruns
 * on every tick, so a 1s clock would rebuild the whole work list every second.
 */
export function useNow(intervalMs = 60_000): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), intervalMs)
    return () => clearInterval(id)
  }, [intervalMs])
  return now
}
