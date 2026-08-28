/**
 * Evict the PWA service worker and its caches before reloading the document.
 *
 * This is shared by boot and the stale-build banner.
 */
export async function forceReload(): Promise<void> {
  try {
    const regs = await globalThis.navigator?.serviceWorker?.getRegistrations?.()
    if (regs) await Promise.all(regs.map((registration) => registration.unregister()))
  } catch {
    // best-effort: unregister failures should not block the reload
  }
  try {
    if (typeof globalThis.caches !== 'undefined') {
      const keys = await globalThis.caches.keys()
      await Promise.all(keys.map((key) => globalThis.caches.delete(key)))
    }
  } catch {
    // best-effort: cache eviction failures should not block the reload
  }
  globalThis.location.reload()
}
