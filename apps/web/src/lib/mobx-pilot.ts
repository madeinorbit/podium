import { debugFlagEnabled, MOBX_SIDEBAR_KEY } from '@podium/client-core/ui-state'
import { poolSwitches } from '@podium/client-graph/host'

/** The web's switch storage (TEMPORARY with the per-screen switches): converted
 * screens share the existing device setting and keep independent URL overrides.
 * Each screen's startup latch reads it once, when UI state is available. */
export const webPoolSwitch = poolSwitches((ui) => {
  let params: URLSearchParams | undefined
  try {
    if (typeof location !== 'undefined') params = new URLSearchParams(location.search)
  } catch {
    // SSR: the authenticated principal's setting is the fallback, like echoHud.
  }
  return { get: (key) => params?.get(key), device: () => debugFlagEnabled(ui, MOBX_SIDEBAR_KEY) }
})
