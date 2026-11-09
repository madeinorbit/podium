import { CHAT_CONTEXT_SUMMARIES } from '@podium/client-graph/chat-context-schema'
import type { PoolScreen } from '@podium/client-graph/host'
import { NOTICE_SUMMARIES } from '@podium/client-graph/notice-schema'
import { replicaSourcePorts, superagentSourcePorts } from '@podium/client-graph/source-ports'
import { SUPERAGENT_SUMMARIES } from '@podium/client-graph/superagent'

export const chatContextPoolScreen: PoolScreen = {
  id: 'chatContext',
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
    await pool.sources.ensure(
      NOTICE_SOURCE_KEY,
      NOTICE_ENTITIES,
      () =>
        new NoticeSource({
          replica: runtime.replica,
          outbox: runtime.services.outbox.queue,
        }),
    )
    await pool.sources.ensure(
      superagent.SUPERAGENT_SOURCE_KEY,
      superagent.SUPERAGENT_ENTITIES,
      () => superagent.createSuperagentSource(superagentSourcePorts(runtime)),
    )
    await pool.sources.ensure(exits.SESSION_EXIT_SOURCE_KEY, SESSION_EXIT_ENTITIES, () =>
      exits.createSessionExitSource(replicaSourcePorts(runtime)),
    )
    pool.sources.register(
      CHAT_CONTEXT_ENTITIES,
      new ChatContextSource(
        {
          ui: runtime.ui,
          drafts: runtime.drafts,
          replica: runtime.replica,
          outbox: runtime.services.outbox.queue,
        },
        pool,
      ),
    )
  },
}
