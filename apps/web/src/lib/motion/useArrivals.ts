/**
 * The mount-latch for the row-arrival one-shot (§5 'Arrive', POD-167): a row
 * key is "arriving" only when it appears AFTER the list first mounted — a
 * freshly mounted sidebar must not replay N arrivals (same guarantee as
 * [usePhaseMorph]). Consumers apply `.row-arrive` while a key is in the set
 * and call `settle(key)` when the wash finishes, so a later unmount/remount
 * of the same row (group changes, virtualization) can't restart the CSS
 * animation.
 *
 * A key that leaves the list and later returns (issue reopened, unsnoozed)
 * arrives again — departure prunes it from the seen set.
 */
import { useEffect, useRef, useState } from 'react'

export function useArrivals(keys: readonly string[]): {
  /** Keys whose rows should currently wear the arrival animation. */
  arrivals: ReadonlySet<string>
  /** Drop a key once its animation completed (or was interrupted). */
  settle: (key: string) => void
} {
  const seen = useRef<Set<string> | null>(null)
  // One-way mount latch, written during render like usePhaseMorph's: the first
  // render's keys pre-exist and must never animate (idempotent under
  // StrictMode's double render).
  if (seen.current === null) seen.current = new Set(keys)
  const [arrivals, setArrivals] = useState<ReadonlySet<string>>(() => new Set())
  useEffect(() => {
    const present = new Set(keys)
    const known = seen.current!
    const fresh = keys.filter((k) => !known.has(k))
    // Prune departed keys so a returning row arrives again.
    for (const k of known) if (!present.has(k)) known.delete(k)
    if (fresh.length === 0) return
    for (const k of fresh) known.add(k)
    setArrivals((prev) => {
      const next = new Set(prev)
      for (const k of fresh) next.add(k)
      return next
    })
  }, [keys])
  const settle = (key: string): void => {
    setArrivals((prev) => {
      if (!prev.has(key)) return prev
      const next = new Set(prev)
      next.delete(key)
      return next
    })
  }
  return { arrivals, settle }
}
