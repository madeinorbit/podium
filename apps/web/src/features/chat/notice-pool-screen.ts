import { NOTICE_SUMMARIES } from '@podium/client-graph/notice-schema'
import type { PoolScreen } from '@podium/client-graph/host'
import { initializeNoticesDataLayer, noticesCheckRequested, noticesDataLayer } from './notice-data-layer'

export const noticePoolScreen: PoolScreen = {
  id: 'notices',
  initialize: initializeNoticesDataLayer,
  enabled: () => noticesDataLayer() === 'pool',
  options: () => ({ header: true, summaries: NOTICE_SUMMARIES }),
  async attach(runtime, pool) {
    const [{ NoticeSource }, { NOTICE_ENTITIES }] = await Promise.all([
      import('@podium/client-graph/notice-source'), import('@podium/client-graph/notice-schema'),
    ])
    pool.sources.register(NOTICE_ENTITIES, new NoticeSource(runtime))
    if (!noticesCheckRequested()) return
    const { installNoticeCheck } = await import('@podium/client-graph/diagnostics/notice-check')
    return installNoticeCheck(pool, runtime)
  },
}
