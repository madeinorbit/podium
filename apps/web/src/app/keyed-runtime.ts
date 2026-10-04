import type {
  EngineState,
  KeyedInputs,
  KeyedListName,
  KeyedListRow,
  LocalKey,
} from '@podium/client-core/engine'
import { useStoreHandle } from '@podium/client-core/react'
import type { SessionId } from '@podium/model/browser'
import { useCallback, useMemo, useSyncExternalStore } from 'react'
import type { Store } from './store'
import type { Trpc } from './trpc'

/** The provider's existing runtime, with its keyed publication surface. */
function useInputs(): KeyedInputs {
  return useStoreHandle<Trpc>() as unknown as KeyedInputs
}

export function useRuntimeLocal<K extends LocalKey>(key: K): EngineState[K] {
  const inputs = useInputs()
  const subscribe = useCallback(
    (notify: () => void) => inputs.onLocals([key], notify),
    [inputs, key],
  )
  const read = useCallback(() => inputs.readLocal(key), [inputs, key])
  return useSyncExternalStore(subscribe, read)
}

/** Discovery/window lists arrive by id; retain the array while its rows agree. */
export function useRuntimeList<N extends KeyedListName>(name: N): KeyedListRow<N>[] {
  const inputs = useInputs()
  const view = useMemo(() => {
    let previous: KeyedListRow<N>[] = []
    return {
      subscribe: (notify: () => void) => inputs.onList(name, notify),
      read: () => {
        const next = inputs.listIds(name).flatMap((id) => {
          const row = inputs.listRow(name, id)
          return row === undefined ? [] : [row]
        })
        if (next.length !== previous.length || next.some((row, at) => row !== previous[at]))
          previous = next
        return previous
      },
    }
  }, [inputs, name])
  return useSyncExternalStore(view.subscribe, view.read)
}

/** Only identity-stable actions/services are acquired from the old API. */
export function useRuntimeActions<K extends keyof Store>(keys: readonly K[]): Pick<Store, K> {
  const owner = useStoreHandle<Trpc>()
  return useMemo(() => {
    const state = owner.getSnapshot()
    return Object.fromEntries(keys.map((key) => [key, state[key]])) as Pick<Store, K>
  }, [owner, keys])
}

export function usePendingSpawnPrompt(id: SessionId): string | undefined {
  const inputs = useInputs()
  const subscribe = useCallback(
    (notify: () => void) => inputs.onLocals(['pendingSpawnPrompts'], notify),
    [inputs],
  )
  const read = useCallback(() => inputs.readLocal('pendingSpawnPrompts').get(id), [inputs, id])
  return useSyncExternalStore(subscribe, read)
}

export function useRuntimeDraft(id: SessionId | undefined): string {
  const inputs = useInputs()
  const subscribe = useCallback(
    (notify: () => void) =>
      inputs.onDraft((changed) => {
        if (changed === id) notify()
      }),
    [inputs, id],
  )
  const read = useCallback(
    () => (id === undefined ? '' : (inputs.readLocal('drafts')?.[id] ?? '')),
    [inputs, id],
  )
  return useSyncExternalStore(subscribe, read)
}

const UI_ACTIONS = ['uiState'] as const
export function useRuntimeUiValue(key: string): string | null {
  const { uiState: ui } = useRuntimeActions(UI_ACTIONS)
  const subscribe = useCallback((notify: () => void) => ui?.subscribe(notify) ?? (() => {}), [ui])
  const read = useCallback(() => ui?.get(key) ?? null, [ui, key])
  return useSyncExternalStore(subscribe, read)
}
