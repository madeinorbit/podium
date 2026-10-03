/**
 * THE MOBILE POOL HOST (POD-4976): the shared `@podium/client-graph/host` over
 * the app's own StoreProvider runtime and replica. No second runtime, replica or
 * outbox: the pool reads what the composition root already opened, and every
 * write keeps going through the existing store actions.
 *
 * The switch is ONE device setting, off by default: this phone's own copy of the
 * web's "MobX pilot" preference, a device-local UI-state key kept in the mobile
 * replica's side cache (never synced from another device, and no URL override).
 * It latches before the first signed-in screen of the app load; a principal
 * rebuild or a later edit keeps that answer, and an app restart applies a new one.
 * Converted mobile screens share one app-wide entry and no per-screen switch.
 */
import { debugFlagEnabled, MOBX_SIDEBAR_KEY } from '@podium/client-core/ui-state'
import { COMMAND_ENTITIES, COMMAND_SUMMARIES } from '@podium/client-graph/command-launch-schema'
import type { commandLaunchViews, CommandLaunchData } from '@podium/client-graph/command-launch-views'
import type { MobxPool } from '@podium/client-graph/pool'
import { SUPERAGENT_ENTITIES, SUPERAGENT_SOURCE_KEY, SUPERAGENT_SUMMARIES, createSuperagentSource } from '@podium/client-graph/superagent'
import { NOTICE_SUMMARIES } from '@podium/client-graph/notice-schema'
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
  initialize(ui: Parameters<typeof mobileSwitchStorage>[0]): void
  /** The latched choice for this app load; 'legacy' before initialization. */
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
        id: 'mobile-work',
        initialize: (ui) => void pilot.initialize(ui),
        enabled: () => pilot.layer() === 'pool',
        options: () => ({ summaries: COMMAND_SUMMARIES }),
        async attach(runtime, pool) {
          const [{ CommandLaunchSource }, { commandLaunchViews }] = await Promise.all([
            import('@podium/client-graph/command-launch-source'),
            import('@podium/client-graph/command-launch-views'),
          ])
          launchViews = commandLaunchViews
          commandLaunchViews(pool)
          await pool.sources.ensure('commands', COMMAND_ENTITIES, () => new CommandLaunchSource(pool, runtime))
        },
      },
      {
        id: 'mobile-pilot',
        initialize: (ui) => void pilot.initialize(ui),
        enabled: () => pilot.layer() === 'pool',
        options: () => ({
          preferences: true,
          header: true,
          settings: true,
          summaries: { session: [...SUPERAGENT_SUMMARIES.session, ...NOTICE_SUMMARIES.session] },
        }),
        async attach(runtime, pool) {
          const { createMobileSettingsSource, MOBILE_SETTINGS_SOURCE_KEY, MOBILE_SETTINGS_ENTITIES } =
            await import('@podium/client-graph/mobile-settings')
          await pool.sources.ensure(MOBILE_SETTINGS_SOURCE_KEY, MOBILE_SETTINGS_ENTITIES, () => createMobileSettingsSource(runtime))
          await pool.sources.ensure(SUPERAGENT_SOURCE_KEY, SUPERAGENT_ENTITIES, () => createSuperagentSource(runtime))
          const [{ NoticeSource, NOTICE_SOURCE_KEY }, { NOTICE_ENTITIES }] = await Promise.all([
            import('@podium/client-graph/notice-source'), import('@podium/client-graph/notice-schema'),
          ])
          await pool.sources.ensure(NOTICE_SOURCE_KEY, NOTICE_ENTITIES, () => new NoticeSource(runtime))
        },
      },
    ],
    dev,
  })
  return { host, initialize: (ui) => void pilot.initialize(ui), layer: pilot.layer }
}

const mobilePool = createMobilePool(typeof __DEV__ !== 'undefined' && __DEV__)

/** StoreProvider's attachRuntime: it owns this teardown on sign-out, user switch
 * and unmount, including while the graph import is in flight. */
export const attachMobilePool = mobilePool.host.attach
/** Called by the composition root with hydrated device state before children. */
export const initializeMobileDataLayer = mobilePool.initialize
/** null while switched off or while the graph loads. */
export const useMobilePool = mobilePool.host.usePool
/** Scalar screen reads share the host's tracking and attachment loading state. */
export const useMobilePoolProjection = mobilePool.host.usePoolProjection
export const mobileDataLayer = mobilePool.layer

let launchViews: typeof commandLaunchViews | undefined
const readLaunch = (pool: MobxPool): CommandLaunchData | null => {
  const catalog = pool.row('commandCatalog', 'catalog')
  if (!catalog || typeof catalog === 'symbol' || !launchViews) return null
  const data = launchViews(pool).launch()
  return data && typeof data !== 'symbol' ? data : null
}
export const useMobileLaunchData = () => useMobilePoolProjection(readLaunch, null)
