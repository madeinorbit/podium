import { STICKY_PROMPTS_KEY } from '@podium/client-core/ui-state'
import { usePersistedUiState } from './use-persisted-ui-state'

export { STICKY_PROMPTS_KEY }

/** Device-local chat preference. Absent means enabled so the restored behavior
 * remains the default; only an explicit `false` opts this browser/device out. */

const serializeEnabled = (enabled: boolean): string | null => enabled ? null : 'false'

export function stickyPromptsEnabled(raw: string | null): boolean {
  return raw !== 'false'
}

export function useStickyPromptsPreference(): {
  enabled: boolean
  setEnabled: (enabled: boolean) => void
} {
  const [enabled, setEnabled] = usePersistedUiState(STICKY_PROMPTS_KEY, stickyPromptsEnabled, serializeEnabled)
  return { enabled, setEnabled }
}
