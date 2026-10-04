import { useCallback, useMemo } from 'react'
import { useUiState } from '../client/hooks'
import { usePoolPreference } from './mobile-preferences'

/** The native counterpart of the web shell's subscribed UI-state hook. */
export function usePersistedUiState<T>(
  key: string,
  parse: (raw: string | null) => T,
  serialize: (value: T) => string | null,
): [T, (next: T) => void] {
  const uiState = useUiState()
  const raw = usePoolPreference(key)
  const value = useMemo(() => parse(raw), [parse, raw])
  const setValue = useCallback(
    (next: T) => uiState.set(key, serialize(next)),
    [key, serialize, uiState],
  )
  return [value, setValue]
}
