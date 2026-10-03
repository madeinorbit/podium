import { useCallback, useEffect, useState } from 'react'
import { useUiState } from '../client/hooks'
import { mobileDataLayer } from '../client/mobile-pool'
import {
  readLegacyPreference,
  useOptimisticPreferences,
  usePoolPreference,
} from './mobile-preferences'

/**
 * Per-key collapsed state in the principal-scoped replica UI store — the phone twin of the
 * desktop sidebar's `useCollapsed` (same key namespace, so the two surfaces
 * read as one product even though the stores are separate).
 */
export function useCollapsed(key: string, defaultCollapsed: boolean): [boolean, () => void] {
  // The app-root latch keeps this implementation fixed across pool attachment.
  const useFold = mobileDataLayer() === 'pool' ? usePoolCollapsed : useLegacyCollapsed
  return useFold(key, defaultCollapsed)
}

function usePoolCollapsed(key: string, defaultCollapsed: boolean): [boolean, () => void] {
  const uiState = useUiState()
  const raw = usePoolPreference(key)
  const { overlay, pending } = useOptimisticPreferences(uiState)
  const current = pending.get(key) ?? raw
  const collapsed = current === null ? defaultCollapsed : current === 'true'
  const toggle = useCallback(() => {
    const value = overlay.get(key) ?? raw
    overlay.set(key, String(!(value === null ? defaultCollapsed : value === 'true')), false)
  }, [defaultCollapsed, key, overlay, raw])
  return [collapsed, toggle]
}

function useLegacyCollapsed(key: string, defaultCollapsed: boolean): [boolean, () => void] {
  const uiState = useUiState()
  const read = useCallback(() => readLegacyPreference(uiState, key) === 'true', [key, uiState])
  const [collapsed, setCollapsed] = useState(() =>
    readLegacyPreference(uiState, key) === null ? defaultCollapsed : read(),
  )
  useEffect(() => {
    const refresh = (): void => {
      const raw = readLegacyPreference(uiState, key)
      setCollapsed(raw === null ? defaultCollapsed : raw === 'true')
    }
    refresh()
    return uiState.subscribe(refresh)
  }, [defaultCollapsed, key, uiState])
  const toggle = useCallback(() => {
    setCollapsed((prev) => {
      const next = !prev
      uiState.set(key, String(next))
      return next
    })
  }, [key, uiState])
  return [collapsed, toggle]
}
