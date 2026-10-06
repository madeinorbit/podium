import { uiStateRoute, type UiStateHome } from '@podium/client-core/ui-state'

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
