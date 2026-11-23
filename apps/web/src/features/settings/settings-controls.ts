import type { PodiumSettings } from '@podium/runtime'
import { createContext, useContext } from 'react'

/** Supply the existing synced settings object, never a copy of its values.
 * `setting` binds a row to its command permission, pending write and refusal.
 * Page tasks should pass the dotted leaf (or list of leaves) they edit.
 *
 * SettingsFrame provides this to the page body AND to pages opened inside it
 * (takeovers), which render beside the body rather than within it. */
export interface SettingsControlsState {
  settings?: PodiumSettings
  permitted?: Readonly<Record<string, boolean>>
  feedback?: Readonly<Record<string, { pending?: boolean; error?: string }>>
  readOnly?: boolean
}
export const SettingsControlsContext = createContext<SettingsControlsState>({})
/** Header actions and custom controls use the same default-closed answer. */
export function useSettingsPermitted(command: string): boolean {
  return useContext(SettingsControlsContext).permitted?.[command] === true
}
