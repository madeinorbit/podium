import type { PoolScreen } from '@podium/client-graph/host'
import { SESSION_PANE_SUMMARIES } from '@podium/client-graph/session-pane-schema'
export const sessionPanePoolScreen: PoolScreen = {
  id: 'sessionPane',
  options: () => ({ header: true, summaries: SESSION_PANE_SUMMARIES }),
  async attach(runtime, pool) {
    const [{ SessionPaneSource, SESSION_PANE_SOURCE_KEY }, { SESSION_PANE_ENTITIES }] =
      await Promise.all([
        import('@podium/client-graph/session-pane-source'),
        import('@podium/client-graph/session-pane-schema'),
      ])
    await pool.sources.ensure(
      SESSION_PANE_SOURCE_KEY,
      SESSION_PANE_ENTITIES,
      () => new SessionPaneSource(runtime),
    )

  },
}
