import { debugFlagEnabled, MOBX_SIDEBAR_KEY, type UiState } from '@podium/client-core/ui-state'

export type SidebarDataLayer = 'legacy' | 'pool'

// The lifetime is the app load, including StoreProvider/principal rebuilds.
// AppShell initializes this before any worklist consumer mounts. No subscription
// or reset: changing the preference or URL takes effect only after a reload.
let startupDataLayer: SidebarDataLayer | undefined
let startupCheck = false

export function initializeSidebarDataLayer(ui: Pick<UiState, 'get'>): void {
  if (startupDataLayer !== undefined) return
  let override: boolean | undefined
  let checkRequested = false
  try {
    if (typeof location !== 'undefined') {
      const value = new URLSearchParams(location.search).get('mobxSidebar')
      checkRequested = new URLSearchParams(location.search).get('mobxSidebarCheck') === '1'
      if (value === '1' || value === 'true') override = true
      if (value === '0' || value === 'false') override = false
    }
  } catch {
    // The authenticated principal's setting is the fallback, like echoHud.
  }
  startupDataLayer = (override ?? debugFlagEnabled(ui, MOBX_SIDEBAR_KEY)) ? 'pool' : 'legacy'
  startupCheck = startupDataLayer === 'pool' && checkRequested
}

export function sidebarCheckRequested(): boolean {
  return startupCheck
}

/** The only mode read for sidebar mounts and worklist readers. Until the pool
 * integration lands, 'pool' is a request; the app still renders its legacy UI. */
export function sidebarDataLayer(): SidebarDataLayer {
  return startupDataLayer ?? 'legacy'
}
