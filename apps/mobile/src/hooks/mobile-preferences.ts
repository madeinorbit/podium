import type { RoutedUiState } from '@podium/client-core/ui-state'
import type { MobxPool } from '@podium/client-graph'
import { useCallback, useMemo, useSyncExternalStore } from 'react'
import { useMobilePoolProjection } from '../client/mobile-pool'

// Counts retain neither keys nor values and cost nothing while disabled.
let counting = false
let legacyReads = new WeakMap<object, number>()
export const mobilePreferenceReadStats = {
  enable(value = true): void {
    counting = value
  },
  reset(): void {
    legacyReads = new WeakMap()
  },
  read(owner: object): { legacyReads: number } {
    return { legacyReads: legacyReads.get(owner) ?? 0 }
  },
}

export function readLegacyPreference(ui: RoutedUiState, key: string): string | null {
  if (counting) legacyReads.set(ui, (legacyReads.get(ui) ?? 0) + 1)
  return ui.get(key)
}

function preferenceValue(pool: MobxPool, key: string): string | null {
  const row = pool.row('preference', key)
  // A cold row or an attaching pool paints the default, never a legacy read.
  return typeof row === 'object' && row !== null ? row.value : null
}

export function usePoolPreference(key: string): string | null {
  const read = useCallback((pool: MobxPool) => preferenceValue(pool, key), [key])
  return useMobilePoolProjection(read, null)
}

export function usePoolPreferences(keys: readonly string[]): readonly (string | null)[] {
  const empty = useMemo(() => keys.map(() => null), [keys])
  const read = useCallback(
    (pool: MobxPool) => keys.map((key) => preferenceValue(pool, key)),
    [keys],
  )
  return useMobilePoolProjection(read, empty)
}

/** Local fold intentions bridge the owner's optimistic write and the pool's
 * next batch. This is not a persistence owner: every write still uses ui.set.
 * A new principal gets a new overlay; old deferred writes keep their old owner.
 */
export function useOptimisticPreferences(ui: RoutedUiState) {
  const overlay = useMemo(() => {
    const pending = new Map<string, { value: string }>()
    const listeners = new Set<() => void>()
    let snapshot: ReadonlyMap<string, string> = new Map()
    const publish = (): void => {
      snapshot = new Map([...pending].map(([key, intent]) => [key, intent.value]))
      for (const wake of listeners) wake()
    }
    return {
      get: (key: string): string | undefined => pending.get(key)?.value,
      snapshot: () => snapshot,
      subscribe: (wake: () => void) => {
        listeners.add(wake)
        return () => {
          listeners.delete(wake)
        }
      },
      set(key: string, value: string, deferred: boolean): void {
        const intent = { value }
        pending.set(key, intent)
        publish()
        const persist = (): void => {
          if (pending.get(key) !== intent) return
          ui.set(key, value)
          // The source queues its batch synchronously on the owner's notify.
          // Release after that batch, including when the screen unmounted.
          queueMicrotask(() => {
            if (pending.get(key) !== intent) return
            pending.delete(key)
            publish()
          })
        }
        if (deferred) setTimeout(persist, 0)
        else persist()
      },
    }
  }, [ui])
  const pending = useSyncExternalStore(overlay.subscribe, overlay.snapshot, overlay.snapshot)
  return { overlay, pending }
}
