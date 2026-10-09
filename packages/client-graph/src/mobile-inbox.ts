import { omitGone } from './lookup'
import { MOBILE_INBOX_VIEW_KEY } from './mobile-inbox-schema'
import type { MobileInboxViews } from './mobile-inbox-views'
import type { MobxPool } from './pool'

/** Importing an OFF phone screen brings in declarations only. Graph and MobX
 * implementations are created by the enabled host before source publication. */
export function mobileInboxViews(pool: MobxPool): MobileInboxViews | undefined {
  const state = omitGone(pool.row('mobileInboxState', 'state'))
  if (!state || typeof state === 'symbol') return undefined
  return pool.sources.view(MOBILE_INBOX_VIEW_KEY, () => {
    throw new Error('Mobile inbox views were not attached')
  })
}
