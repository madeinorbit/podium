/** The phone uses one shared pool over its existing runtime, replica and outbox.
 * Screens read only that pool; actions keep the existing store API and owner. */
import { COMMAND_ENTITIES, COMMAND_SUMMARIES } from '@podium/client-graph/command-launch-schema'
import type {
  CommandLaunchData,
  commandLaunchViews,
} from '@podium/client-graph/command-launch-views'
import { createPoolHost, type PoolHost } from '@podium/client-graph/host'
import {
  MOBILE_INBOX_ENTITIES,
  MOBILE_INBOX_SOURCE_KEY,
  MOBILE_INBOX_SUMMARIES,
  MOBILE_INBOX_VIEW_KEY,
} from '@podium/client-graph/mobile-inbox-schema'
import { MOBILE_SCREEN_SUMMARIES } from '@podium/client-graph/mobile-screens-schema'
import { MOBILE_SESSION_SUMMARIES } from '@podium/client-graph/mobile-session-schema'
import { navigationPoolScreen } from '@podium/client-graph/navigation-screen'
import { NOTICE_SUMMARIES } from '@podium/client-graph/notice-schema'
import type { MobxPool } from '@podium/client-graph/pool'
import {
  createSuperagentSource,
  SUPERAGENT_ENTITIES,
  SUPERAGENT_SOURCE_KEY,
  SUPERAGENT_SUMMARIES,
} from '@podium/client-graph/superagent'

export interface MobilePool {
  readonly host: PoolHost
}

/** One host per app load; a principal rebuild retains its normal teardown. */
export function createMobilePool(dev: boolean): MobilePool {
  const host = createPoolHost({
    start(runtime) {
      runtime.enablePoolRuntimeWork({ lazyLegacyLists: true })
    },
    screens: [
      navigationPoolScreen,
      {
        id: 'mobile-screens',
        options: () => ({ summaries: MOBILE_SCREEN_SUMMARIES }),
        async attach(runtime, pool) {
          const [{ attachMobileScreens }, { attachIssuePageSource }] = await Promise.all([
            import('@podium/client-graph/mobile-screens'),
            import('@podium/client-graph/issue-page-source'),
          ])
          await attachMobileScreens(pool, runtime)
          attachIssuePageSource(pool, runtime)
        },
      },
      {
        id: 'mobile-work',
        options: () => ({ summaries: COMMAND_SUMMARIES }),
        async attach(runtime, pool) {
          const [{ CommandLaunchSource }, { commandLaunchViews }] = await Promise.all([
            import('@podium/client-graph/command-launch-source'),
            import('@podium/client-graph/command-launch-views'),
          ])
          launchViews = commandLaunchViews
          commandLaunchViews(pool)
          await pool.sources.ensure(
            'commands',
            COMMAND_ENTITIES,
            () => new CommandLaunchSource(pool, runtime),
          )
        },
      },
      {
        id: 'mobile-shell',
        options: () => ({
          preferences: true,
          header: true,
          settings: true,
          summaries: {
            issue: [...MOBILE_INBOX_SUMMARIES.issue, ...MOBILE_SESSION_SUMMARIES.issue],
            session: [
              ...SUPERAGENT_SUMMARIES.session,
              ...NOTICE_SUMMARIES.session,
              ...MOBILE_INBOX_SUMMARIES.session,
              ...MOBILE_SESSION_SUMMARIES.session,
            ],
          },
        }),
        async attach(runtime, pool) {
          const {
            createMobileSettingsSource,
            MOBILE_SETTINGS_SOURCE_KEY,
            MOBILE_SETTINGS_ENTITIES,
          } = await import('@podium/client-graph/mobile-settings')
          await pool.sources.ensure(MOBILE_SETTINGS_SOURCE_KEY, MOBILE_SETTINGS_ENTITIES, () =>
            createMobileSettingsSource(runtime),
          )
          await pool.sources.ensure(SUPERAGENT_SOURCE_KEY, SUPERAGENT_ENTITIES, () =>
            createSuperagentSource(runtime),
          )
          const [{ NoticeSource, NOTICE_SOURCE_KEY }, { NOTICE_ENTITIES }] = await Promise.all([
            import('@podium/client-graph/notice-source'),
            import('@podium/client-graph/notice-schema'),
          ])
          await pool.sources.ensure(
            NOTICE_SOURCE_KEY,
            NOTICE_ENTITIES,
            () => new NoticeSource(runtime),
          )
          const [{ MobileInboxSource }, { createMobileInboxViews }] = await Promise.all([
            import('@podium/client-graph/mobile-inbox-source'),
            import('@podium/client-graph/mobile-inbox-views'),
          ])
          await pool.sources.ensure(MOBILE_INBOX_SOURCE_KEY, MOBILE_INBOX_ENTITIES, () => {
            pool.sources.view(MOBILE_INBOX_VIEW_KEY, () => createMobileInboxViews(pool))
            return new MobileInboxSource(runtime, pool)
          })
          const { attachMobileSessionContext } = await import(
            '@podium/client-graph/mobile-session-context'
          )
          await attachMobileSessionContext(runtime, pool)
        },
      },
    ],
    dev,
  })
  return { host }
}

const mobilePool = createMobilePool(typeof __DEV__ !== 'undefined' && __DEV__)

/** StoreProvider's attachRuntime: it owns this teardown on sign-out, user switch
 * and unmount, including while the graph import is in flight. */
export const attachMobilePool = mobilePool.host.attach
/** null while the graph attaches. */
export const useMobilePool = mobilePool.host.usePool
/** Scalar screen reads share the host's tracking and attachment loading state. */
export const useMobilePoolProjection = mobilePool.host.usePoolProjection

let launchViews: typeof commandLaunchViews | undefined
const readLaunch = (pool: MobxPool): CommandLaunchData | null => {
  const catalog = pool.row('commandCatalog', 'catalog')
  if (!catalog || typeof catalog === 'symbol' || !launchViews) return null
  const data = launchViews(pool).launch()
  return data && typeof data !== 'symbol' ? data : null
}
export const useMobileLaunchData = () => useMobilePoolProjection(readLaunch, null)
