import type { PoolScreen } from '@/app/pool-screen-registry'
import { initializeNoticesDataLayer, noticesCheckRequested, noticesDataLayer } from './notice-data-layer'

export const noticePoolScreen: PoolScreen = {
  initialize: initializeNoticesDataLayer,
  enabled: () => noticesDataLayer() === 'pool',
  options: () => ({ header: true, summaries: { session: ['sessionId', 'name', 'title', 'cwd', 'agentKind'] } }),
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
