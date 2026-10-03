import type { UiState } from '@podium/client-core/ui-state'
import type { PoolScreen } from '@podium/client-graph/host'
import { MISSION_SUMMARIES } from '@podium/client-graph/mission-schema'
import { chatContextPoolScreen } from '@/features/chat/chat-context-pool-screen'
import { noticePoolScreen } from '@/features/chat/notice-pool-screen'
import { issueBoardPoolScreen } from '@/features/issues/board-pool-screen'
import { issuePagePoolScreen } from '@/features/issues/issue-page/pool-screen'
import { superagentPoolScreen } from '@/features/superagent/pool-screen'
import { sessionPanePoolScreen } from '@/features/terminal/session-pane-pool-screen'
import { workflowPoolScreen } from '@/features/workflows/workflow-pool-screen'
import { commandLaunchScreen } from './command-launch-pool-screen'
import { missionPanePoolScreen } from './mission-pane-pool-screen'
import { panePoolScreen } from './pane-pool-screen'
import { shellPoolScreen } from './shell-pool-screen'

/** Latch with hydrated UI state before rendering any screen, including settings.
 * Provider attachments and principal rebuilds reuse the same app-load choices. */
export function initializePoolScreens(ui: UiState): void {
  for (const screen of poolBackedScreens) screen.initialize?.(ui)
}

/** Screen declarations register sources on the existing runtime and pool. */
export const poolBackedScreens: readonly PoolScreen[] = [
  issueBoardPoolScreen,
  issuePagePoolScreen,
  panePoolScreen,
  sessionPanePoolScreen,
  chatContextPoolScreen,
  commandLaunchScreen,
  noticePoolScreen,
  superagentPoolScreen,
  missionPanePoolScreen,
  workflowPoolScreen,
  shellPoolScreen,
  { id: 'settings', options: () => ({ settings: true }) },
  {
    id: 'preferences',
    options: () => ({ preferences: true }),
  },
  { id: 'sidebar', options: () => ({ summaries: MISSION_SUMMARIES }) },
  { id: 'header', options: () => ({ header: true }) },
  {
    id: 'automations',
    options: () => ({ settings: true }),
    async attach(runtime, pool) {
      const [{ AutomationSource }, { AUTOMATION_ENTITIES }] = await Promise.all([
        import('@podium/client-graph/automation-source'),
        import('@podium/client-graph/automation-schema'),
      ])
      pool.sources.register(AUTOMATION_ENTITIES, new AutomationSource(runtime.replica))
    },
  },
]
