import type { UiState } from '@podium/client-core/ui-state'
import type { PoolDataLayer } from '@podium/client-graph/host'
import { webPoolSwitch } from './mobx-pilot'

export type SidebarDataLayer = PoolDataLayer

// The lifetime is the app load, including StoreProvider/principal rebuilds.
// AppShell initializes this before any worklist consumer mounts. No subscription
// or reset: changing the preference or URL takes effect only after a reload.
const sidebar = webPoolSwitch('mobxSidebar', 'mobxSidebarCheck')

export function initializeSidebarDataLayer(ui: Pick<UiState, 'get'>): void {
  sidebar.initialize(ui)
}

/** The switch requests one startup comparison; later checks require an explicit request. */
export function sidebarCheckRequested(): boolean {
  return sidebar.checkRequested()
}

/** The startup choice shared by the real sidebar and its companion readers. */
export function sidebarDataLayer(): SidebarDataLayer {
  return sidebar.layer()
}
