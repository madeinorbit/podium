import { reaction } from 'mobx'
import type { UiState } from '../replica/contract'
import { createRoutedUiState, type RoutedUiState } from '../ui-state'
import { DEVICE_DRAFT_KEYS } from './draft-storage'
import type { LayoutAccess } from './layout-access'
import type { UiStore } from './ui-store'

/** Reactions belong to this access service. It stores no preference values:
 * device preferences are UiStore fields, synced choices are userLayout models. */
export function createUiKeys(
  ui: () => UiStore,
  drafts: UiState,
  layout: LayoutAccess,
): RoutedUiState {
  const local: UiState = {
    get: (key) => (DEVICE_DRAFT_KEYS.has(key) ? drafts.get(key) : ui().getDevicePref(key)),
    set: (key, value) => {
      if (DEVICE_DRAFT_KEYS.has(key)) drafts.set(key, value)
      else ui().setDevicePref(key, value)
    },
    subscribe(notify) {
      const stop = reaction(
        () => Object.fromEntries(ui().devicePrefs),
        (after, before) => {
          const keys = new Set(
            [...Object.keys(before), ...Object.keys(after)].filter(
              (key) => before[key] !== after[key],
            ),
          )
          if (keys.size) notify(keys)
        },
      )
      const off = drafts.subscribe(notify)
      return () => {
        stop()
        off()
      }
    },
  }
  return createRoutedUiState({ local, replicated: layout })
}
