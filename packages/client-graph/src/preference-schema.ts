import { uiStateRoute, type UiStateHome } from '@podium/client-core/ui-state'

/** A routed preference is an entity owned by this principal's existing UI port.
 * Dynamic layout keys use the same declared routing vocabulary as their writer.
 * There are no relations or unloaded summaries: demand is by exact key, and the
 * small resident rows contain only that key's scalar value. No entity scan. */
export const PREFERENCE_SCHEMA = {
  preference: {
    key: 'key', source: 'runtime:ui', fields: ['key', 'home', 'value'],
    relations: {}, summaries: {}, residency: 'on-demand',
  },
} as const

export interface PreferenceRow {
  readonly key: string
  readonly home: UiStateHome
  readonly value: string | null
}

export function declarePreference(key: string): UiStateHome {
  const { home } = uiStateRoute(key)
  if (home !== 'pre-auth-theme' && home !== 'device-local' && home !== 'per-user-replicated') {
    throw new Error('This key is not owned by the routed preference source')
  }
  return home
}
