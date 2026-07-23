import { useSyncExternalStore } from 'react'
import type { UiState } from '@/app/replica'
import { useStoreSelector } from '@/app/store'

/** Device-local chat preference. Absent means enabled so the restored behavior
 * remains the default; only an explicit `false` opts this browser/device out. */
export const STICKY_PROMPTS_KEY = 'podium.chat.stickyPrompts'

const subscribeUnavailable = (): (() => void) => () => {}
const readUnavailable = (): null => null

export function stickyPromptsEnabled(raw: string | null): boolean {
  return raw !== 'false'
}

export function useStickyPromptsPreference(): {
  enabled: boolean
  setEnabled: (enabled: boolean) => void
} {
  // Lightweight consumers (tests, embeds, transitional stores) may not expose
  // the device-local UI collection. Preserve the default-on behavior instead
  // of making chat rendering depend on optional preference storage.
  const ui = useStoreSelector((s) => s.uiState) as UiState | undefined
  const raw = useSyncExternalStore(
    ui ? (cb) => ui.subscribe(cb) : subscribeUnavailable,
    ui ? () => ui.get(STICKY_PROMPTS_KEY) : readUnavailable,
    readUnavailable,
  )
  return {
    enabled: stickyPromptsEnabled(raw),
    setEnabled: (enabled) => ui?.set(STICKY_PROMPTS_KEY, enabled ? null : 'false'),
  }
}
