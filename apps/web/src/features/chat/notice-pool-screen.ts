import type { PoolScreen } from '@podium/client-graph/host'

export const noticePoolScreen: PoolScreen = {
  id: 'notices',
  options: () => ({ header: true }),
  async attach(runtime, pool) {
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
  },
}
