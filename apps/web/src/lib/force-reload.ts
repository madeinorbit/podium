import { navigateReload } from '@/lib/navigate'

/**
 * Evict the PWA service worker and its caches before reloading the document.
 *
 * This is shared by boot and the stale-build banner.
 *
 * WHAT IT EVICTED IS RECORDED (POD-3224). This is the heaviest recovery the app
 * has — it unregisters every worker and deletes every cache — and its two
 * `catch`es are deliberately silent, so a run that evicted NOTHING because the
 * browser refused looked identical to one that swept the page clean. The counts
 * are the difference, and they are what distinguishes "the reset did not help"
 * from "the reset did not happen".
 */
export async function forceReload(reason = 'force-reload'): Promise<void> {
  let unregistered = 0
  let cachesDeleted = 0
  let refused: string | undefined
  try {
    const regs = await globalThis.navigator?.serviceWorker?.getRegistrations?.()
    if (regs) {
      const outcomes = await Promise.all(regs.map((registration) => registration.unregister()))
      unregistered = outcomes.filter(Boolean).length
    }
  } catch (err) {
    // best-effort: unregister failures should not block the reload
    refused = err instanceof Error ? err.message : String(err)
  }
  try {
    if (typeof globalThis.caches !== 'undefined') {
      const keys = await globalThis.caches.keys()
      const outcomes = await Promise.all(keys.map((key) => globalThis.caches.delete(key)))
      cachesDeleted = outcomes.filter(Boolean).length
    }
  } catch (err) {
    // best-effort: cache eviction failures should not block the reload
    refused ??= err instanceof Error ? err.message : String(err)
  }
  // ONE record, not two: the counts ride on the navigation line rather than on a
  // line of their own, because they describe the same event.
  navigateReload('force-reload', reason, {
    unregistered,
    cachesDeleted,
    ...(refused ? { evictionRefused: refused } : {}),
  })
}
