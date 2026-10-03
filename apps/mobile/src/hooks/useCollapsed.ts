import { useCallback } from 'react'
import { useUiState } from '../client/hooks'
import {
  useOptimisticPreferences,
  usePoolPreference,
} from './mobile-preferences'

/**
 * Per-key collapsed state in the principal-scoped replica UI store — the phone twin of the
 * desktop sidebar's `useCollapsed` (same key namespace, so the two surfaces
 * read as one product even though the stores are separate).
 */
export function useCollapsed(key: string, defaultCollapsed: boolean): [boolean, () => void] {
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

