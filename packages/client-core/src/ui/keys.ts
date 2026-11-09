import { reaction } from 'mobx'
import type { UiState } from '../replica/contract'
import {
  clearPreAuthTheme,
  createRoutedUiState,
  type RoutedUiState,
  readPreAuthTheme,
  uiStateRoute,
  writePreAuthTheme,
} from '../ui-state'
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
    get: (key) => {
      if (DEVICE_DRAFT_KEYS.has(key)) return drafts.get(key)
      // The theme's home is raw pre-auth storage: index.html reads it before sign-in.
      const home = uiStateRoute(key).home
      if (home === 'pre-auth-theme') return readPreAuthTheme(key as never)
      // Only device preferences live in UiStore; any other local key keeps the
      // device key/value store it had before UiStore.
      if (home !== 'device-local') return drafts.get(key)
      return ui().getDevicePref(key)
    },
    set: (key, value) => {
      if (DEVICE_DRAFT_KEYS.has(key)) drafts.set(key, value)
      else {
        const home = uiStateRoute(key).home
        if (home === 'pre-auth-theme') {
          if (value === null) clearPreAuthTheme(key as never)
          else writePreAuthTheme(key as never, value)
        } else if (home !== 'device-local') drafts.set(key, value)
        else ui().setDevicePref(key, value)
      }
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
