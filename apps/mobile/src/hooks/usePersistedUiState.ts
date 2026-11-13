import { preferenceSource } from '@podium/client-graph/preference-source'
import { useCallback, useMemo } from 'react'
import { useUiState } from '../client/hooks'
import { useMobilePool } from '../client/mobile-pool'
import { usePoolPreference } from './mobile-preferences'

/** The native counterpart of the web shell's subscribed UI-state hook. */
export function usePersistedUiState<T>(
  key: string,
  parse: (raw: string | null) => T,
  serialize: (value: T) => string | null,
): [T, (next: T) => void] {
  const uiState = useUiState()
  const pool = useMobilePool()
  const raw = usePoolPreference(key)
  const value = useMemo(() => parse(raw), [parse, raw])
  const setValue = useCallback(
    (next: T) => {
      uiState.set(key, serialize(next))
      // Match desktop's draft hook: native controlled menu values must see
      // the accepted write before React restores the previous selection.
      if (pool) preferenceSource(pool)?.refreshKey(key)
    },
    [key, serialize, uiState, pool],
  )
  return [value, setValue]
}
