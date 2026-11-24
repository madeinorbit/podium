import { useEffect, useState } from 'react'

/** How long a freshly mounted row draws itself before the viewport window takes over. */
export const ROW_PRIME_MS = 1000

/**
 * Whether a freshly mounted row (an unfold, a first render) draws its content
 * before SwiftUI reports it on screen. On screen rows are in the viewport window
 * by the time this lapses; rows below the fold drop back to their placeholder,
 * so the window's bound on live row observers still holds.
 */
export function useRowPrime(prime: boolean): [boolean, () => void] {
  const [primed, setPrimed] = useState(prime)
  useEffect(() => {
    if (!primed) return
    const timer = setTimeout(() => setPrimed(false), ROW_PRIME_MS)
    return () => clearTimeout(timer)
  }, [primed])
  return [primed, () => setPrimed(false)]
}
