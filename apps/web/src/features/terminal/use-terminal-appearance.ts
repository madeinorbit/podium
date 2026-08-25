import type { TerminalAppearance } from '@podium/terminal-client/appearance'
import { useMemo, useSyncExternalStore } from 'react'
import { useStoreSelector } from '@/app/store'
import { useThemeAppearance } from '@/app/theme'
import {
  OMARCHY_TERMINAL_DEFAULTS,
  parseTerminalAppearance,
  TERMINAL_APPEARANCE_KEY,
  type TerminalAppearanceSettings,
  toTerminalAppearance,
} from './appearance'

export interface UseTerminalAppearanceResult {
  /** What the OPERATOR has set — what Settings edits and resets. Never the
   *  profile's defaults, or "Reset to defaults" would offer to clear values the
   *  operator never chose. */
  settings: TerminalAppearanceSettings
  /** The appearance's own defaults, under `settings`. Empty on Podium. */
  profileDefaults: TerminalAppearanceSettings
  /** Memoized on the stored blob — safe to hand to useTerminalSession. */
  appearance: TerminalAppearance
  /** Patch (merge) the stored settings; `undefined` fields reset to default. */
  update(patch: Partial<TerminalAppearanceSettings>): void
}

/** Read + subscribe to the device's terminal appearance (ui-state backed, see
 *  appearance.ts). All native panels and the settings section share this, so a
 *  change applies everywhere, live — including across tabs. */
export function useTerminalAppearance(): UseTerminalAppearanceResult {
  const ui = useStoreSelector((s) => s.uiState)
  const raw = useSyncExternalStore(
    (cb) => ui.subscribe(cb),
    () => ui.get(TERMINAL_APPEARANCE_KEY),
  )
  const settings = useMemo(() => parseTerminalAppearance(raw), [raw])
  // The Omarchy design sets the terminal's ground and face; Podium leaves both
  // to the terminal-client defaults. Either way the operator's own settings sit
  // on top — see OMARCHY_TERMINAL_DEFAULTS.
  const themeAppearance = useThemeAppearance()
  const profileDefaults: TerminalAppearanceSettings = useMemo(
    () => (themeAppearance === 'omarchy' ? { ...OMARCHY_TERMINAL_DEFAULTS } : {}),
    [themeAppearance],
  )
  const appearance = useMemo(
    () => toTerminalAppearance(settings, profileDefaults),
    [settings, profileDefaults],
  )
  return {
    settings,
    profileDefaults,
    appearance,
    update: (patch) => {
      const next = { ...parseTerminalAppearance(ui.get(TERMINAL_APPEARANCE_KEY)), ...patch }
      for (const k of Object.keys(next) as (keyof TerminalAppearanceSettings)[]) {
        if (next[k] === undefined) delete next[k]
      }
      ui.set(TERMINAL_APPEARANCE_KEY, Object.keys(next).length ? JSON.stringify(next) : null)
    },
  }
}
