import type { UiState } from '@podium/client-core/ui-state'
import { mobxPilotEnabled } from './mobx-pilot'

export type SidebarDataLayer = 'legacy' | 'pool'

// The lifetime is the app load, including StoreProvider/principal rebuilds.
// AppShell initializes this before any worklist consumer mounts. No subscription
// or reset: changing the preference or URL takes effect only after a reload.
let startupDataLayer: SidebarDataLayer | undefined
let startupCheck = false

export function initializeSidebarDataLayer(ui: Pick<UiState, 'get'>): void {
  if (startupDataLayer !== undefined) return
  let params: URLSearchParams | undefined
  try {
    if (typeof location !== 'undefined') {
      params = new URLSearchParams(location.search)
    }
  } catch {
    // The authenticated principal's setting is the fallback, like echoHud.
  }
  startupDataLayer = mobxPilotEnabled(ui, params, 'mobxSidebar') ? 'pool' : 'legacy'
  startupCheck = startupDataLayer === 'pool' && params?.get('mobxSidebarCheck') === '1'
}

/** The switch requests one startup comparison; later checks require an explicit request. */
export function sidebarCheckRequested(): boolean {
  return startupCheck
}

/** The startup choice shared by the real sidebar and its companion readers. */
export function sidebarDataLayer(): SidebarDataLayer {
  return startupDataLayer ?? 'legacy'
}
