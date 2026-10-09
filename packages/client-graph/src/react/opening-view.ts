import { useEffect, useMemo } from 'react'

/** The root owns one model while open. No pool/global registry retains it.
 * Delay teardown to the next microtask so React's StrictMode effect replay
 * can reacquire the same opening before its resources are disposed. */
export function useOpeningView<P, V extends { dispose(): void }>(
  pool: P | null,
  create: (pool: P) => V,
  open = true,
): V | null {
  const opening = useMemo(
    () => (pool && open ? { view: create(pool) as V | null, mounts: 0 } : null),
    [pool, create, open],
  )
  useEffect(() => {
    if (!opening) return
    opening.mounts++
    return () => {
      opening.mounts--
      queueMicrotask(() => {
        if (opening.mounts === 0) {
          const view = opening.view
          opening.view = null
          view?.dispose()
        }
      })
    }
  }, [opening])
  return opening?.view ?? null
}
