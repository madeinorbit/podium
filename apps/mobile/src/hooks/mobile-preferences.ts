import type { RoutedUiState } from '@podium/client-core/ui-state'
import type { MobxPool } from '@podium/client-graph'
import { omitGone } from '@podium/client-graph/lookup'
import { allowImperativeRead } from '@podium/mobx-helpers'
import { useCallback, useMemo, useSyncExternalStore } from 'react'
import { useUiState } from '../client/hooks'
import { useMobilePoolProjection } from '../client/mobile-pool'

export function usePoolPreference(key: string): string | null {
  const ui = useUiState()
  const read = useCallback(() => allowImperativeRead(() => ui.get(key)), [ui, key])
  const subscribe = useCallback(
    (notify: () => void) =>
      ui.subscribe((keys) => {
        if (keys.has(key)) notify()
      }),
    [ui, key],
  )
  return useSyncExternalStore(subscribe, read, read)
}
export function usePoolPreferences(keys: readonly string[]): readonly (string | null)[] {
  const ui = useUiState()
  const read = useCallback(
    () => allowImperativeRead(() => JSON.stringify(keys.map((key) => ui.get(key)))),
    [ui, keys],
  )
  const subscribe = useCallback(
    (notify: () => void) =>
      ui.subscribe((changed) => {
        if (keys.some((key) => changed.has(key))) notify()
      }),
    [ui, keys],
  )
  const raw = useSyncExternalStore(subscribe, read, read)
  return useMemo(() => JSON.parse(raw) as (string | null)[], [raw])
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
