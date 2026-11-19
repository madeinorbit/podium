/** Production shell over the shared local demo replica. Only transport is stubbed. */
import { useClientRuntime, useDeviceState, useRequestClient } from '@podium/client-core/react'
import { asIssueId } from '@podium/model'
import { type ComponentType, Suspense, useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { AppSheet } from '@/app/AppSheet'
import { AppBody } from '@/app/AppShell'
import { WebDemoProvider } from '@/app/demo-mode'
import { DensityProvider } from '@/app/density'
import { ErrorBoundary } from '@/app/ErrorBoundary'
import { installVitePreloadErrorRecovery } from '@/app/preload-error-recovery'
import { ToolbarSlotProvider } from '@/app/ToolbarSlot'
import { ThemeProvider } from '@/app/theme'
import type { Trpc } from '@/app/trpc'
import { lazyScreen } from '@/components/LazyScreen'
import { TooltipProvider } from '@/components/ui/tooltip'
import { AdminViewerContext } from '@/features/settings/admin-viewer'
import { lazySurfaces } from '@/lib/lazy-surface'
import { WebSyncProgressStore } from '@/lib/sync-progress'
import '@/index.css'
import '@/styles.css'

function Body() {
  const runtime = useClientRuntime()
  const api = useRequestClient<Trpc>()
  const uiState = useDeviceState()
  const [LateScreen, setLateScreen] = useState<ComponentType | null>(null)
  const [syncProgress] = useState(() => {
    const progress = new WebSyncProgressStore()
    progress.begin('live')
    return progress
  })
  useEffect(() => {
    // The demo summary has no usage history. Supply the sheet's other read-only
    // transport answers before opening it, rather than throwing from its effect.
    Object.assign(api, {
      quota: { history: { query: async () => [] } },
      cost: { tasks: { query: async () => [] } },
    })
    Object.assign(window, {
      offlineRoutes: {
        registry: () => lazySurfaces.snapshot(),
        openUncached() {
          setLateScreen(() =>
            lazyScreen(
              () => import('./offline-unvisited-screen'),
              (module) => module.UnvisitedScreen,
              (content) => (
                <AppSheet
                  label="Usage & analytics"
                  title="Usage & analytics"
                  className="app-sheet-fit"
                  onClose={() => setLateScreen(null)}
                >
                  {content}
                </AppSheet>
              ),
            ),
          )
        },
        openDeck() {
          uiState.set('podium:superagent:mode', 'open')
          runtime.ui.setSelectedIssueId(asIssueId('demo-mission-root'))
          runtime.ui.setView('workspace')
        },
      },
    })
  }, [runtime, uiState, api])
  return (
    <AdminViewerContext.Provider
      value={{
        status: 'ready',
        sections: [],
        setupFinished: true,
        capabilities: { addMachine: false, setUpServer: false },
        retry: () => {},
      }}
    >
      <AppBody syncProgress={syncProgress} />
      {LateScreen && (
        <Suspense fallback={null}>
          <LateScreen />
        </Suspense>
      )}
    </AdminViewerContext.Provider>
  )
}

installVitePreloadErrorRecovery()
const root = document.getElementById('root')
if (!root) throw new Error('Offline harness root is missing')
createRoot(root).render(
  <ThemeProvider>
    <TooltipProvider>
      <ErrorBoundary resetKey="offline-harness">
        <WebDemoProvider>
          <DensityProvider>
            <ToolbarSlotProvider>
              <Body />
            </ToolbarSlotProvider>
          </DensityProvider>
        </WebDemoProvider>
      </ErrorBoundary>
    </TooltipProvider>
  </ThemeProvider>,
)
