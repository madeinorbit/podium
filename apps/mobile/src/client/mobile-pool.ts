/**
 * THE MOBILE POOL HOST (POD-4976): the shared `@podium/client-graph/host` over
 * the app's own StoreProvider runtime and replica. No second runtime, replica or
 * outbox: the pool reads what the composition root already opened, and every
 * write keeps going through the existing store actions.
 *
 * The switch is ONE device setting, off by default: this phone's own copy of the
 * web's "MobX pilot" preference, a device-local UI-state key kept in the mobile
 * replica's side cache (never synced from another device, and no URL override).
 * It latches at the first signed-in attachment of the app load; a principal
 * rebuild or a later edit keeps that answer, and an app restart applies a new one.
 * Mobile screens convert later, so there is one app-wide entry and no per-screen
 * switch yet.
 */
import { debugFlagEnabled, MOBX_SIDEBAR_KEY } from '@podium/client-core/ui-state'
import {
  createPoolHost,
  type PoolDataLayer,
  type PoolHost,
  type PoolSwitchStorage,
  poolSwitches,
} from '@podium/client-graph/host'

/** TEMPORARY with the per-screen switches: mobile has no per-screen overrides;
 * every screen falls back to this device's setting. */
export function mobileSwitchStorage(ui: Parameters<typeof debugFlagEnabled>[0]): PoolSwitchStorage {
  return { get: () => undefined, device: () => debugFlagEnabled(ui, MOBX_SIDEBAR_KEY) }
}

export interface MobilePool {
  readonly host: PoolHost
  /** The latched choice for this app load; 'legacy' before the first attachment. */
  layer(): PoolDataLayer
}

/** One host and one latch per app load. Tests build their own to model a restart. */
export function createMobilePool(
  dev: boolean,
  storage: typeof mobileSwitchStorage = mobileSwitchStorage,
): MobilePool {
  const pilot = poolSwitches(storage)('mobxMobile')
  const host = createPoolHost({
    screens: [
      {
        id: 'mobile-pilot',
        initialize: (ui) => void pilot.initialize(ui),
        enabled: () => pilot.layer() === 'pool',
      },
    ],
    dev,
  })
  return { host, layer: pilot.layer }
}

const mobilePool = createMobilePool(typeof __DEV__ !== 'undefined' && __DEV__)

/** StoreProvider's attachRuntime: it owns this teardown on sign-out, user switch
 * and unmount, including while the graph import is in flight. */
export const attachMobilePool = mobilePool.host.attach
/** null while switched off or while the graph loads. */
export const useMobilePool = mobilePool.host.usePool
export const mobileDataLayer = mobilePool.layer
