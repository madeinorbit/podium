import { useDeviceState, useDrafts } from '@podium/client-core/react'
import { allowImperativeRead } from '@podium/mobx-helpers'
import type { SessionId } from '@podium/model/browser'
import { reaction } from 'mobx'
import { useCallback, useSyncExternalStore } from 'react'
import { useWorklistPoolProjection } from './store-worklist-pool'

export function usePendingSpawnPrompt(id: SessionId): string | undefined {
  return useWorklistPoolProjection(
    (pool) => pool.spawnPlaceholders()?.get(id) ?? undefined,
    undefined,
  )
}

/** A non-observer leaf can subscribe to its addressed MobX document. */
export function useDraftValue(id: SessionId | undefined): string {
  const drafts = useDrafts()
  const read = useCallback(() => (id === undefined ? '' : drafts.get(id)), [drafts, id])
  const subscribe = useCallback((notify: () => void) => reaction(read, notify), [read])
  return useSyncExternalStore(subscribe, read)
}
export function useRuntimeUiValue(key: string): string | null {
  const ui = useDeviceState()
  const subscribe = useCallback((notify: () => void) => ui?.subscribe(notify) ?? (() => {}), [ui])
  const read = useCallback(() => allowImperativeRead(() => ui?.get(key) ?? null), [ui, key])
  return useSyncExternalStore(subscribe, read)
}
