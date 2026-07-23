import { useSyncExternalStore } from 'react'
import { useStoreSelector } from '@/app/store'

/** Device-local chat preference. Absent means enabled so the restored behavior
 * remains the default; only an explicit `false` opts this browser/device out. */
export const STICKY_PROMPTS_KEY = 'podium.chat.stickyPrompts'

export function stickyPromptsEnabled(raw: string | null): boolean {
  return raw !== 'false'
}

export function useStickyPromptsPreference(): {
  enabled: boolean
  setEnabled: (enabled: boolean) => void
} {
  const ui = useStoreSelector((s) => s.uiState)
  const raw = useSyncExternalStore(
    (cb) => ui.subscribe(cb),
    () => ui.get(STICKY_PROMPTS_KEY),
  )
  return {
    enabled: stickyPromptsEnabled(raw),
    setEnabled: (enabled) => ui.set(STICKY_PROMPTS_KEY, enabled ? null : 'false'),
  }
}
