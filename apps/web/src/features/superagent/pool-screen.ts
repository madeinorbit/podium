import type { PoolScreen } from '@podium/client-graph/host'
import {
  createSuperagentSource,
  SUPERAGENT_ENTITIES,
  SUPERAGENT_SOURCE_KEY,
  SUPERAGENT_SUMMARIES,
} from '@podium/client-graph/superagent'

export const superagentPoolScreen: PoolScreen = {
  id: 'superagent',
  initialize() {},
  enabled: () => true,
  options: () => ({ header: true, summaries: SUPERAGENT_SUMMARIES }),
  async attach(runtime, pool) {
    await pool.sources.ensure(SUPERAGENT_SOURCE_KEY, SUPERAGENT_ENTITIES, () =>
      createSuperagentSource(runtime),
    )
    const [{ NoticeSource, NOTICE_SOURCE_KEY }, { NOTICE_ENTITIES }] = await Promise.all([
      import('@podium/client-graph/notice-source'),
      import('@podium/client-graph/notice-schema'),
    ])
    await pool.sources.ensure(NOTICE_SOURCE_KEY, NOTICE_ENTITIES, () => new NoticeSource(runtime))
  },
}
