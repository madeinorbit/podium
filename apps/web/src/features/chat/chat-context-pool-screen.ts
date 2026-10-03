import { CHAT_CONTEXT_SUMMARIES } from '@podium/client-graph/chat-context-schema'
import type { PoolScreen } from '@podium/client-graph/host'
import { NOTICE_SUMMARIES } from '@podium/client-graph/notice-schema'
import { SUPERAGENT_SUMMARIES } from '@podium/client-graph/superagent'

export const chatContextPoolScreen: PoolScreen = {
  id: 'chatContext',
  initialize() {},
  enabled: () => true,
  options: () => ({
    header: true,
    summaries: {
      issue: CHAT_CONTEXT_SUMMARIES.issue,
      session: [
        ...CHAT_CONTEXT_SUMMARIES.session,
        ...NOTICE_SUMMARIES.session,
        ...SUPERAGENT_SUMMARIES.session,
      ],
    },
  }),
  async attach(runtime, pool) {
    const [
      { ChatContextSource },
      { CHAT_CONTEXT_ENTITIES },
      { NoticeSource, NOTICE_SOURCE_KEY },
      { NOTICE_ENTITIES },
      superagent,
      exits,
      { SESSION_EXIT_ENTITIES },
    ] = await Promise.all([
      import('@podium/client-graph/chat-context-source'),
      import('@podium/client-graph/chat-context-schema'),
      import('@podium/client-graph/notice-source'),
      import('@podium/client-graph/notice-schema'),
      import('@podium/client-graph/superagent'),
      import('@podium/client-graph/session-exit-source'),
      import('@podium/client-graph/session-exit-schema'),
    ])
    await pool.sources.ensure(NOTICE_SOURCE_KEY, NOTICE_ENTITIES, () => new NoticeSource(runtime))
    await pool.sources.ensure(
      superagent.SUPERAGENT_SOURCE_KEY,
      superagent.SUPERAGENT_ENTITIES,
      () => superagent.createSuperagentSource(runtime),
    )
    await pool.sources.ensure(exits.SESSION_EXIT_SOURCE_KEY, SESSION_EXIT_ENTITIES, () =>
      exits.createSessionExitSource(runtime),
    )
    pool.sources.register(CHAT_CONTEXT_ENTITIES, new ChatContextSource(runtime, pool))
  },
}
