import { useDeviceState } from '@podium/client-core/react'
import { allowImperativeRead } from '@podium/mobx-helpers'
import { useCallback, useMemo, useSyncExternalStore } from 'react'

/** Device preferences are already loaded in UiStore before this render. Synced
 * choices read the pool's userLayout model through the same access service. */
export function usePersistedUiValue<T>(key: string, parse: (raw: string | null) => T): T {
  const ui = useDeviceState()
  const read = useCallback(() => allowImperativeRead(() => ui.get(key)), [ui, key])
  const subscribe = useCallback(
    (notify: () => void) =>
      ui.subscribe((keys) => {
        if (keys.has(key)) notify()
      }),
    [ui, key],
  )
  const raw = useSyncExternalStore(subscribe, read, read)
  return useMemo(() => parse(raw), [raw, parse])
}
export function usePersistedUiState<T>(
  key: string,
  parse: (raw: string | null) => T,
  serialize: (value: T) => string | null,
): [T, (next: T) => void] {
  const ui = useDeviceState()
  const value = usePersistedUiValue(key, parse)
  const set = useCallback((next: T) => ui.set(key, serialize(next)), [ui, key, serialize])
  return [value, set]
}
