import { NOTICE_SUMMARIES } from '@podium/client-graph/notice-schema'
import type { PoolScreen } from '@podium/client-graph/host'

export const noticePoolScreen: PoolScreen = {
  id: 'notices',
  initialize() {},
  enabled: () => true,
  options: () => ({ header: true, summaries: NOTICE_SUMMARIES }),
  async attach(runtime, pool) {
    const [{ NoticeSource, NOTICE_SOURCE_KEY }, { NOTICE_ENTITIES }] = await Promise.all([
      import('@podium/client-graph/notice-source'), import('@podium/client-graph/notice-schema'),
    ])
    await pool.sources.ensure(NOTICE_SOURCE_KEY, NOTICE_ENTITIES, () => new NoticeSource(runtime))
  },
}
