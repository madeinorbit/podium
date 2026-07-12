import type { TerminalAppearance } from '@podium/terminal-client'
import { useMemo, useSyncExternalStore } from 'react'
import { useStoreSelector } from '@/app/store'
import {
  parseTerminalAppearance,
  TERMINAL_APPEARANCE_KEY,
  type TerminalAppearanceSettings,
  toTerminalAppearance,
} from './appearance'

export interface UseTerminalAppearanceResult {
  settings: TerminalAppearanceSettings
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
  const appearance = useMemo(() => toTerminalAppearance(settings), [settings])
  return {
    settings,
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
