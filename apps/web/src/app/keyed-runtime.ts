import { useStoreHandle } from '@podium/client-core/react'
import { allowImperativeRead } from '@podium/mobx-helpers'
import type { SessionId } from '@podium/model/browser'
import { reaction } from 'mobx'
import { useCallback, useMemo, useSyncExternalStore } from 'react'
import type { Store } from './store'
import { useWorklistPoolProjection } from './store-worklist-pool'
import type { Trpc } from './trpc'

/** Identity-stable actions/services acquired from their runtime owner. */
export function useRuntimeActions<K extends keyof Store>(keys: readonly K[]): Pick<Store, K> {
  const owner = useStoreHandle<Trpc>()
  return useMemo(() => {
    const state = owner.access
    return Object.fromEntries(
      keys.map((key) => [
        key,
        key === 'uiState'
          ? owner.deviceState
          : key in owner.ui
            ? Reflect.get(owner.ui, key)
            : state[key],
      ]),
    ) as Pick<Store, K>
  }, [owner, keys])
}

export function usePendingSpawnPrompt(id: SessionId): string | undefined {
  return useWorklistPoolProjection(
    (pool) => pool.spawnPlaceholders()?.get(id) ?? undefined,
    undefined,
  )
}

/** A non-observer leaf can subscribe to its addressed MobX document. */
export function useDraftValue(id: SessionId | undefined): string {
  const { drafts } = useStoreHandle<Trpc>()
  const read = useCallback(() => (id === undefined ? '' : drafts.get(id)), [drafts, id])
  const subscribe = useCallback((notify: () => void) => reaction(read, notify), [read])
  return useSyncExternalStore(subscribe, read)
}

const UI_ACTIONS = ['uiState'] as const
export function useRuntimeUiValue(key: string): string | null {
  const { uiState: ui } = useRuntimeActions(UI_ACTIONS)
  const subscribe = useCallback((notify: () => void) => ui?.subscribe(notify) ?? (() => {}), [ui])
  const read = useCallback(() => allowImperativeRead(() => ui?.get(key) ?? null), [ui, key])
  return useSyncExternalStore(subscribe, read)
}
