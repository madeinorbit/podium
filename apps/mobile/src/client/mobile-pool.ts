/** The phone uses one shared pool over its existing runtime, replica and outbox.
 * Screens read only that pool; actions keep the existing store API and owner. */
import { COMMAND_ENTITIES } from '@podium/client-graph/command-launch-schema'
import { createPoolHost, type PoolHost } from '@podium/client-graph/host'
import {
  MOBILE_INBOX_ENTITIES,
  MOBILE_INBOX_SOURCE_KEY,
  MOBILE_INBOX_VIEW_KEY,
} from '@podium/client-graph/mobile-inbox-schema'
import { navigationPoolScreen } from '@podium/client-graph/navigation-screen'
import type { MobxPool } from '@podium/client-graph/pool'
import { replicaSourcePorts } from '@podium/client-graph/source-ports'
import {
  createSuperagentSource,
  SUPERAGENT_ENTITIES,
  SUPERAGENT_SOURCE_KEY,
} from '@podium/client-graph/superagent'
import { startupTiming } from '../lib/startup-timing'
import { afterFirstRoute } from './first-route'
import { useProjectionFocus } from './projection-focus'

export interface MobilePool {
  readonly host: PoolHost
}

/** One host per app load; a principal rebuild retains its normal teardown. */
export function createMobilePool(dev: boolean): MobilePool {
  const host = createPoolHost({
    start: () => {
      startupTiming.mark('pool.attach.start')
    },
    screens: [
      navigationPoolScreen,
      {
        id: 'mobile-screens',
        async attach(runtime, pool) {
          startupTiming.mark('pool.created')
          const [{ attachMobileScreens }, { attachIssuePageSource }] = await Promise.all([
            import('@podium/client-graph/mobile-screens'),
            import('@podium/client-graph/issue-page-source'),
          ])
          await attachMobileScreens(pool, runtime)
          attachIssuePageSource(pool, { replica: runtime.replica })
          startupTiming.mark('pool.screens.attached')
        },
      },
      {
        id: 'mobile-work',
        async attach(runtime, pool) {
          // POD-5423: the Work screen draws the worklist's lanes; hold them
          // filed from the attachment, before the lazy imports below.
          startupTiming.mark('pool.worklist.start')
          const release = pool.worklist.retain()
          startupTiming.mark('pool.worklist.end')
          try {
            // New Task's launch data is not on the first screen: it waits for
            // the first route's layout, off the launch path (POD-2666).
            await afterFirstRoute()
            const [{ CommandLaunchSource }, { commandLaunchViews }] = await Promise.all([
              import('@podium/client-graph/command-launch-source'),
              import('@podium/client-graph/command-launch-views'),
            ])
            commandLaunchViews(pool)
            await pool.sources.ensure(
              'commands',
              COMMAND_ENTITIES,
              () => new CommandLaunchSource(pool, runtime),
            )
          } catch (error) {
            release()
            throw error
          }
          return release
        },
      },
      {
        id: 'mobile-shell',
        options: () => ({
          preferences: true,
          header: true,
          settings: true,
        }),
        async attach(runtime, pool) {
          // Settings, superagent, notices, inbox and session context draw no
          // part of the first screen: they attach after its layout (POD-2666).
          await afterFirstRoute()
          const {
            createMobileSettingsSource,
            MOBILE_SETTINGS_SOURCE_KEY,
            MOBILE_SETTINGS_ENTITIES,
          } = await import('@podium/client-graph/mobile-settings')
          await pool.sources.ensure(MOBILE_SETTINGS_SOURCE_KEY, MOBILE_SETTINGS_ENTITIES, () =>
            createMobileSettingsSource(replicaSourcePorts(runtime)),
          )
          await pool.sources.ensure(SUPERAGENT_SOURCE_KEY, SUPERAGENT_ENTITIES, () =>
            createSuperagentSource({
              ui: runtime.ui,
              readPosition: runtime.readPosition,
              replica: runtime.replica,
            }),
          )
          const [{ NoticeSource, NOTICE_SOURCE_KEY }, { NOTICE_ENTITIES }] = await Promise.all([
            import('@podium/client-graph/notice-source'),
            import('@podium/client-graph/notice-schema'),
          ])
          await pool.sources.ensure(
            NOTICE_SOURCE_KEY,
            NOTICE_ENTITIES,
            () =>
              new NoticeSource({
                replica: runtime.replica,
                outbox: runtime.services.outbox.queue,
              }),
          )
          const [{ MobileInboxSource }, { createMobileInboxViews }] = await Promise.all([
            import('@podium/client-graph/mobile-inbox-source'),
            import('@podium/client-graph/mobile-inbox-views'),
          ])
          await pool.sources.ensure(MOBILE_INBOX_SOURCE_KEY, MOBILE_INBOX_ENTITIES, () => {
            pool.sources.view(MOBILE_INBOX_VIEW_KEY, () => createMobileInboxViews(pool))
            return new MobileInboxSource({ replica: runtime.replica }, pool)
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
/** The pool at the moment of an action, without subscribing the caller. */
export const useMobilePoolNow = mobilePool.host.usePoolNow
/** Scalar screen reads share the host's tracking and attachment loading state. */
export function useMobilePoolProjection<T>(read: (pool: MobxPool) => T, empty: T): T {
  return mobilePool.host.usePoolProjection(read, empty, useProjectionFocus())
}
