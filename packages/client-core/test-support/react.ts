import { allowImperativeRead } from '@podium/mobx-helpers'
import { reaction } from 'mobx'
import { useCallback, useSyncExternalStore } from 'react'
import type { UiStore } from '../src/ui/ui-store'
import type { RoutedUiState } from '../src/ui-state'
import { refreshFixtureUi } from './ui'

/** Provider-free suites bind UI hooks to the same real owner as their actions.
 * Replacing an exported useStoreHandle does not replace the provider module's
 * internal context reads. Keep the observable subscription used in production. */
export function fixtureUiHooks(
  owner: () => { readonly ui: UiStore; readonly deviceState: RoutedUiState },
) {
  return {
    useUi: () => {
      const handle = owner()
      refreshFixtureUi(handle)
      return handle.ui
    },
    useDeviceState: () => owner().deviceState,
    useUiValue<K extends keyof UiStore>(key: K): UiStore[K] {
      const handle = owner()
      refreshFixtureUi(handle)
      const ui = handle.ui
      const read = useCallback(() => allowImperativeRead(() => ui[key]), [ui, key])
      const subscribe = useCallback((notify: () => void) => reaction(read, notify), [read])
      return useSyncExternalStore(subscribe, read)
    },
  }
}
