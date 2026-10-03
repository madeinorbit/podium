import { useCallback, useMemo, useSyncExternalStore } from 'react'
import { useUiState } from '../client/hooks'
import { mobileDataLayer } from '../client/mobile-pool'
import { readLegacyPreference, usePoolPreference } from './mobile-preferences'

/** The native counterpart of the web shell's subscribed UI-state hook. */
export function usePersistedUiState<T>(
  key: string,
  parse: (raw: string | null) => T,
  serialize: (value: T) => string | null,
): [T, (next: T) => void] {
  const uiState = useUiState()
  // The app-root switch is latched before these hooks mount, even while its
  // pool is still importing. Hook order cannot change under mounted screens.
  const usePreference = mobileDataLayer() === 'pool' ? usePoolPreference : useLegacyPreference
  const raw = usePreference(key, uiState)
  const value = useMemo(() => parse(raw), [parse, raw])
  const setValue = useCallback(
    (next: T) => uiState.set(key, serialize(next)),
    [key, serialize, uiState],
  )
  return [value, setValue]
}

function useLegacyPreference(key: string, uiState: ReturnType<typeof useUiState>): string | null {
  return useSyncExternalStore(
    (notify) => uiState.subscribe(notify),
    () => readLegacyPreference(uiState, key),
    () => null,
  )
}
