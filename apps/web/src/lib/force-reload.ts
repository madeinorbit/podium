import { navigateFreshInterface, navigateReload } from '@/lib/navigate'
import { prepareForReload, withReloadPreparation } from './reload-preparation'

export const CACHE_RESET_BUDGET_MS = 1_000

/** Recover the interface without clearing draft storage or the durable outbox.
 * The network entry bypasses even an old controller whose unregister stalls. */
export function forceReload(reason = 'force-reload', clearCaches = true): Promise<void> {
  return withReloadPreparation(async () => {
    let unregistered = 0
    let cachesDeleted = 0
    let stopped = false
    let refused: string | undefined
    let timer: ReturnType<typeof setTimeout> | undefined
    const evict = async (): Promise<void> => {
      try {
        const regs = await globalThis.navigator?.serviceWorker?.getRegistrations?.()
        if (stopped) return
        if (regs) {
          const outcomes = await Promise.all(regs.map((registration) => registration.unregister()))
          unregistered = outcomes.filter(Boolean).length
        }
        if (stopped || !clearCaches || typeof globalThis.caches === 'undefined') return
        const keys = await globalThis.caches.keys()
        if (stopped) return
        const outcomes = await Promise.all(keys.map((key) => globalThis.caches.delete(key)))
        cachesDeleted = outcomes.filter(Boolean).length
      } catch (error) {
        refused = error instanceof Error ? error.message : String(error)
      }
    }
    try {
      await Promise.race([
        evict(),
        new Promise<void>((resolve) => {
          timer = setTimeout(() => {
            stopped = true
            refused = 'Service-worker cleanup exceeded its time budget.'
            resolve()
          }, CACHE_RESET_BUDGET_MS)
        }),
      ])
    } finally {
      stopped = true
      if (timer !== undefined) clearTimeout(timer)
    }
    // Capture edits typed while the browser was unregistering its worker.
    await prepareForReload()
    const fields = { unregistered, cachesDeleted, ...(refused ? { evictionRefused: refused } : {}) }
    if (/^https?:$/.test(window.location.protocol)) navigateFreshInterface(reason, fields)
    else navigateReload('force-reload', reason, fields)
  })
}
