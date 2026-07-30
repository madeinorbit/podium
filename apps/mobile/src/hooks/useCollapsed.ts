import AsyncStorage from '@react-native-async-storage/async-storage'
import { useCallback, useEffect, useState } from 'react'

/**
 * Per-key collapsed state persisted to AsyncStorage — the phone twin of the
 * desktop sidebar's `useCollapsed` (same key namespace, so the two surfaces
 * read as one product even though the stores are separate). Hydration is async;
 * until it lands the caller's default shows, which is the right first paint.
 */
export function useCollapsed(key: string, defaultCollapsed: boolean): [boolean, () => void] {
  const [collapsed, setCollapsed] = useState(defaultCollapsed)
  useEffect(() => {
    let alive = true
    void AsyncStorage.getItem(key)
      .then((raw) => {
        if (alive && raw != null) setCollapsed(raw === 'true')
      })
      .catch(() => {})
    return () => {
      alive = false
    }
  }, [key])
  const toggle = useCallback(() => {
    setCollapsed((prev) => {
      const next = !prev
      void AsyncStorage.setItem(key, String(next)).catch(() => {})
      return next
    })
  }, [key])
  return [collapsed, toggle]
}
