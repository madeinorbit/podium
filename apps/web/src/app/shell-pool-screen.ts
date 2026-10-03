import type { PoolScreen } from '@podium/client-graph/host'
import { SHELL_SUMMARIES } from '@podium/client-graph/shell-schema'
import { MISSION_VIEW_SUMMARIES } from '@podium/client-graph/mission-view-schema'
export const shellPoolScreen: PoolScreen = {
  id: 'shell',
  options: () => ({ header: true, summaries: { issue: [...SHELL_SUMMARIES.issue, ...MISSION_VIEW_SUMMARIES.issue],
    session: [...SHELL_SUMMARIES.session, ...MISSION_VIEW_SUMMARIES.session] } }),
  async attach(runtime, pool) {
    const [{ ShellSource }, { SHELL_SOURCE_KEY, SHELL_ENTITIES }] = await Promise.all([
      import('@podium/client-graph/shell-source'), import('@podium/client-graph/shell-schema'),
    ])
    await pool.sources.ensure(SHELL_SOURCE_KEY, SHELL_ENTITIES, () => new ShellSource(runtime))

  },
}
