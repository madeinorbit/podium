import { recordChipWork } from '@podium/client-core/perf'
import { initializeSettingsDataLayer, settingsDataLayer, settingsCheckRequested } from '@/features/settings/data-layer'
import { initializePreferencesDataLayer, preferencesDataLayer, preferencesCheckRequested } from '@/lib/preferences-data-layer'
import { initializeSidebarDataLayer, sidebarDataLayer, sidebarCheckRequested } from '@/lib/sidebar-data-layer'
import { initializeHeaderDataLayer, headerDataLayer, headerCheckRequested } from '@/lib/header-data-layer'
import { initializeChipsDataLayer, chipsDataLayer, chipsCheckRequested } from '@/lib/chips-data-layer'
import type { PoolScreen } from './pool-screen-registry'

/** Screen declarations are the only provider registration surface. Graph code
 * stays behind startup choices; every entry uses the existing runtime/pool. */
export const poolBackedScreens: readonly PoolScreen[] = [
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
    options: runtime => ({ resolveReferences: async refs => {
      recordChipWork(runtime, 'resolveBatches'); recordChipWork(runtime, 'resolveRefs', refs.length)
      return runtime.getSnapshot().trpc.issues.resolveRefs.query({ refs: [...refs] })
    } }),
    async attach(runtime, pool) {
      const references = pool.references
      if (!chipsCheckRequested()) return
      const { startChipCheck } = await import('@podium/client-graph/diagnostics/chip-check')
      return startChipCheck(runtime, references, () => [...document.querySelectorAll('a.ref-link--issue[data-ref], [data-issue-reference]')].map(node => node.getAttribute('data-ref') ?? node.getAttribute('data-issue-reference')!))
    },
  },
]
