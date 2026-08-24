/**
 * FETCH IT AFTER THE PAINT, NOT BEFORE IT (POD-2730).
 *
 * Deferring a module moves its bytes out of the eager graph — the chunks
 * `index.html` references, which the browser must download, parse and evaluate
 * before anything renders. It does NOT have to move the FETCH to the moment the
 * user needs it, and for a surface the user is likely to reach (a session panel,
 * the hover preview) that would trade a measured first-paint win for a visible
 * hitch later.
 *
 * So: ask for the chunk once the shell is up and the main thread is idle. By
 * the time the replica has synced enough to render a panel — which needs a
 * round trip, not a chunk read — the module is already resolved and `lazy()`
 * renders it synchronously, with no fallback frame at all.
 *
 * `requestIdleCallback` where it exists (not Safari before 17), a macrotask
 * otherwise. Either way this runs after first paint, never during it.
 */
export function prefetchAfterFirstPaint(load: () => Promise<unknown>): () => void {
  const run = (): void => {
    // A failed prefetch is not an error: the same import runs again when the
    // component actually renders, and THAT one is allowed to reject into the
    // Suspense boundary's error handling. Swallowing here keeps a flaky network
    // from raising an unhandled rejection on a page that is working fine.
    void load().catch(() => {})
  }
  if (typeof requestIdleCallback === 'function') {
    const handle = requestIdleCallback(run, { timeout: 2_000 })
    return () => cancelIdleCallback(handle)
  }
  const handle = setTimeout(run, 0)
  return () => clearTimeout(handle)
}
