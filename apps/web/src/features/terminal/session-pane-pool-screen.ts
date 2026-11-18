import type { PoolScreen } from '@podium/client-graph/host'
export const sessionPanePoolScreen: PoolScreen = {
  id: 'sessionPane',
  options: () => ({ sessionPane: true, header: true }),
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
