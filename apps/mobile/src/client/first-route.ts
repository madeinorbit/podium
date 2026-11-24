/**
 * The first route's layout, as a promise for work that draws nothing on the
 * first screen (POD-2666). Pool attachments that the launch screen does not
 * read wait for it, so they no longer share the JS thread with the attachments
 * and layout the first frame needs. A cap keeps them from waiting forever when
 * no route reports (a sign-in or pairing screen, a failed boot).
 */
export const FIRST_ROUTE_CAP_MS = 1500

let reached = false
const waiting = new Set<() => void>()

/** Called once by the launch boundary when the first route has laid out. */
export function markFirstRoute(): void {
  if (reached) return
  reached = true
  for (const resolve of [...waiting]) resolve()
  waiting.clear()
}

/** For React readers (useSyncExternalStore): whether the first route has laid out. */
export function firstRouteReached(): boolean {
  return reached
}

export function subscribeFirstRoute(listener: () => void): () => void {
  if (reached) return () => {}
  waiting.add(listener)
  return () => waiting.delete(listener)
}

/** Resolves after the first route's layout, or after the cap. */
export function afterFirstRoute(cap = FIRST_ROUTE_CAP_MS): Promise<void> {
  if (reached) return Promise.resolve()
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer)
      waiting.delete(done)
      resolve()
    }
    const timer = setTimeout(done, cap)
    waiting.add(done)
  })
}
