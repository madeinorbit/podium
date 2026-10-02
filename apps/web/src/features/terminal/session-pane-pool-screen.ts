import type { PoolScreen } from '@/app/pool-screen-registry'
import { SESSION_PANE_SUMMARIES } from '@podium/client-graph/session-pane-schema'
import { initializeSessionPaneDataLayer, sessionPaneDataLayer, sessionPaneCheckRequested } from './session-pane-data-layer'

export const sessionPanePoolScreen: PoolScreen = {
  id: 'sessionPane',
  initialize: initializeSessionPaneDataLayer,
  enabled: () => sessionPaneDataLayer() === 'pool',
  options: () => ({ header: true, summaries: SESSION_PANE_SUMMARIES }),
  async attach(runtime, pool) {
    const [{ SessionPaneSource }, { SESSION_PANE_ENTITIES }] = await Promise.all([
      import('@podium/client-graph/session-pane-source'), import('@podium/client-graph/session-pane-schema'),
    ])
    pool.sources.register(SESSION_PANE_ENTITIES, new SessionPaneSource(runtime))
    if (!sessionPaneCheckRequested()) return
    const { installSessionPaneCheck } = await import('@podium/client-graph/diagnostics/session-pane-check')
    return installSessionPaneCheck(pool, runtime)
  },
}
