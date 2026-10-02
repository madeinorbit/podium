import { MISSION_SUMMARIES } from '@podium/client-graph/mission-schema'
import type { UiState } from '@podium/client-core/ui-state'
import { initializeSettingsDataLayer, settingsDataLayer, settingsCheckRequested } from '@/features/settings/data-layer'
import { initializePreferencesDataLayer, preferencesDataLayer, preferencesCheckRequested } from '@/lib/preferences-data-layer'
import { initializeSidebarDataLayer, sidebarDataLayer, sidebarCheckRequested } from '@/lib/sidebar-data-layer'
import { initializeHeaderDataLayer, headerDataLayer, headerCheckRequested } from '@/lib/header-data-layer'
import { initializeChipsDataLayer, chipsDataLayer, chipsCheckRequested } from '@/lib/chips-data-layer'
import { noticePoolScreen } from '@/features/chat/notice-pool-screen'
import { initializeAutomationsDataLayer, automationsDataLayer, specsDataLayer, automationsCheckRequested } from '@/lib/automations-data-layer'
import type { PoolScreen } from '@podium/client-graph/host'
import { panePoolScreen } from './pane-pool-screen'
import { commandLaunchScreen } from '@/lib/command-launch-data-layer'

/** Latch with hydrated UI state before rendering any screen, including settings.
 * Provider attachments and principal rebuilds reuse the same app-load choices. */
export function initializePoolScreens(ui: UiState): void {
  for (const screen of poolBackedScreens) screen.initialize(ui)
}

/** Screen declarations are the only provider registration surface. Graph code
 * stays behind startup choices; every entry uses the existing runtime/pool. */
export const poolBackedScreens: readonly PoolScreen[] = [
  panePoolScreen,
  commandLaunchScreen,
  noticePoolScreen,
  { optional: true, initialize: initializeSettingsDataLayer, enabled: () => settingsDataLayer() === 'pool',
    options: () => ({ settings: true }),
    async attach(runtime, pool) {
      if (!settingsCheckRequested()) return
      const { installSettingsCheck } = await import('@podium/client-graph/diagnostics/settings-check')
      return installSettingsCheck(pool, runtime)
    },
  },
  { optional: true, initialize: initializePreferencesDataLayer, enabled: () => preferencesDataLayer() === 'pool',
    options: () => ({ preferences: true }),
    async attach(runtime, pool) {
      if (!preferencesCheckRequested()) return
      const { installPreferenceCheck } = await import('@podium/client-graph/diagnostics/preference-check')
      return installPreferenceCheck(pool, runtime.ui)
    },
  },
  { optional: true, initialize: initializeSidebarDataLayer, enabled: () => sidebarDataLayer() === 'pool',
    options: () => ({ summaries: MISSION_SUMMARIES }),
    async attach(runtime, pool) {
      const { startSidebarCheck } = await import('@podium/client-graph/diagnostics/runtime-check')
      return startSidebarCheck(runtime, pool, {
        startup: sidebarCheckRequested(),
        state: store => {
          const base = { pinnedRepos: store.pins.repos, pinnedWorktrees: store.pins.worktrees, projectOrder: store.sidebarSettings.repoOrder }
          const keys = ['podium:sidebar:pinned-fold', ...pool.sidebar.sections(base).bands.flatMap(band => [band.foldKey, band.snoozedFoldKey, band.closedFoldKey])]
          return { ...base, paneA: store.paneA, selectedWorktree: store.selectedWorktree,
            collapsed: Object.fromEntries(keys.flatMap(key => {
              const raw = runtime.ui.get(key)
              return raw === null ? [] : [[key, raw === 'true']]
            })),
          }
        },
      })
    },
  },
  { optional: true, initialize: initializeHeaderDataLayer, enabled: () => headerDataLayer() === 'pool',
    options: () => ({ header: true }),
    async attach(runtime, pool) {
      if (!headerCheckRequested()) return
      const { startHeaderCheck } = await import('@podium/client-graph/diagnostics/header-runtime-check')
      return startHeaderCheck(runtime, pool, report => {
        if (typeof window !== 'undefined') Object.assign(window, { __headerCheck: report })
      })
    },
  },
  { optional: true, initialize: initializeChipsDataLayer, enabled: () => chipsDataLayer() === 'pool',
    async attach(runtime, pool) {
      const references = pool.references
      if (!chipsCheckRequested()) return
      const { startChipCheck } = await import('@podium/client-graph/diagnostics/chip-check')
      return startChipCheck(runtime, references, () => [...document.querySelectorAll('a.ref-link--issue[data-ref], [data-issue-reference]')].map(node => node.getAttribute('data-ref') ?? node.getAttribute('data-issue-reference')!))
    },
  },
  { initialize: initializeAutomationsDataLayer, enabled: () => automationsDataLayer() === 'pool' || specsDataLayer() === 'pool',
    options: () => ({ settings: true }),
    async attach(runtime, pool) {
      const [{ AutomationSource }, { AUTOMATION_ENTITIES }] = await Promise.all([
        import('@podium/client-graph/automation-source'), import('@podium/client-graph/automation-schema'),
      ])
      pool.sources.register(AUTOMATION_ENTITIES, new AutomationSource(runtime.replica))
      if (!automationsCheckRequested() || typeof window === 'undefined') return
      const [{ checkAutomations }, { automationTargetChoices }, { machineViewsFromWire }] = await Promise.all([
        import('@podium/client-graph/diagnostics/automation-check'), import('@/features/automations/automation-form'), import('@podium/client-core/viewmodels'),
      ])
      const check = () => {
        const state = runtime.getSnapshot()
        return checkAutomations(pool, state, path => automationTargetChoices(state.repos, state.sessions, machineViewsFromWire(state.machines), path))
      }
      Object.assign(window, { __automationCheck: check })
      return () => { if (Reflect.get(window, '__automationCheck') === check) Reflect.deleteProperty(window, '__automationCheck') }
    },
  },
]
