import { useCallback, useEffect, useState } from 'react'
import { useMobileClient } from '../client/MobileClientProvider'

/**
 * Per-key collapsed state in the principal-scoped replica UI store — the phone twin of the
 * desktop sidebar's `useCollapsed` (same key namespace, so the two surfaces
 * read as one product even though the stores are separate).
 */
export function useCollapsed(key: string, defaultCollapsed: boolean): [boolean, () => void] {
  const { uiState } = useMobileClient()
  const read = useCallback(() => uiState.get(key) === 'true', [key, uiState])
  const [collapsed, setCollapsed] = useState(() =>
    uiState.get(key) === null ? defaultCollapsed : read(),
  )
  useEffect(() => {
    const refresh = (): void => {
      const raw = uiState.get(key)
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
