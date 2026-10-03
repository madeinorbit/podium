import type { UiState } from '@podium/client-core/ui-state'
import type { PoolScreen } from '@podium/client-graph/host'
import { SHELL_SUMMARIES } from '@podium/client-graph/shell-schema'
import { MISSION_VIEW_SUMMARIES } from '@podium/client-graph/mission-view-schema'
import { webPoolSwitch } from '@/lib/mobx-pilot'

/** TEMPORARY rollout switch. Defaults OFF and freezes before rendering, even
 * when the existing pool is still importing or a principal is replaced. */
const shell = webPoolSwitch('mobxShell', 'mobxShellCheck')
export function initializeShellDataLayer(ui: Pick<UiState, 'get'>): void { shell.initialize(ui) }
export const shellDataLayer = shell.layer
export const shellCheckRequested = shell.checkRequested

export const shellPoolScreen: PoolScreen = {
  id: 'shell',
  initialize: initializeShellDataLayer,
  enabled: () => shellDataLayer() === 'pool',
  options: () => ({ header: true, summaries: { issue: [...SHELL_SUMMARIES.issue, ...MISSION_VIEW_SUMMARIES.issue],
    session: [...SHELL_SUMMARIES.session, ...MISSION_VIEW_SUMMARIES.session] } }),
  async attach(runtime, pool) {
    const [{ ShellSource }, { SHELL_SOURCE_KEY, SHELL_ENTITIES }] = await Promise.all([
      import('@podium/client-graph/shell-source'), import('@podium/client-graph/shell-schema'),
    ])
    await pool.sources.ensure(SHELL_SOURCE_KEY, SHELL_ENTITIES, () => new ShellSource(runtime))
    if (!shellCheckRequested()) return
    const { startShellCheck } = await import('@podium/client-graph/diagnostics/shell-check')
    return startShellCheck(runtime, pool)
  },
}
