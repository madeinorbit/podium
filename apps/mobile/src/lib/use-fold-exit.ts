import { useEffect, useReducer, useRef, useState } from 'react'

/** Long enough for SwiftUI's default animation to finish collapsing the rows. */
export const FOLD_EXIT_MS = 450

/**
 * Groups that just folded and whose rows should stay mounted, collapsed to zero
 * height, for one fold animation. React unmounting the rows would remove their
 * native views before SwiftUI could animate them out, so a fold would jump.
 * Computed during render so the first folded frame already keeps the rows.
 */
export function useFoldExit(folded: readonly string[]): ReadonlySet<string> {
  const previous = useRef<ReadonlySet<string> | null>(null)
  const exiting = useRef(new Set<string>())
  const [, refresh] = useReducer((n: number) => n + 1, 0)
  const now = new Set(folded)
  // The first render folds nothing: groups saved folded never animate in.
  if (previous.current)
    for (const key of now) if (!previous.current.has(key)) exiting.current.add(key)
  for (const key of exiting.current) if (!now.has(key)) exiting.current.delete(key)
  previous.current = now
  const pending = exiting.current.size > 0
  useEffect(() => {
    if (!pending) return
    const timer = setTimeout(() => {
      exiting.current.clear()
      refresh()
    }, FOLD_EXIT_MS)
    return () => clearTimeout(timer)
  })
  return new Set(exiting.current)
}

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
