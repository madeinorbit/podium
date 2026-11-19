/** Production shell over the shared local demo replica. Only transport is stubbed. */
import { useClientRuntime, useDeviceState } from '@podium/client-core/react'
import { asIssueId } from '@podium/model'
import { useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { AppBody } from '@/app/AppShell'
import { WebDemoProvider } from '@/app/demo-mode'
import { DensityProvider } from '@/app/density'
import { ErrorBoundary } from '@/app/ErrorBoundary'
import { installVitePreloadErrorRecovery } from '@/app/preload-error-recovery'
import { ToolbarSlotProvider } from '@/app/ToolbarSlot'
import { ThemeProvider } from '@/app/theme'
import { TooltipProvider } from '@/components/ui/tooltip'
import { WebSyncProgressStore } from '@/lib/sync-progress'
import '@/index.css'
import '@/styles.css'

function Body() {
  const runtime = useClientRuntime()
  const uiState = useDeviceState()
  const [syncProgress] = useState(() => {
    const progress = new WebSyncProgressStore()
    progress.begin('live')
    return progress
  })
  useEffect(() => {
    Object.assign(window, {
      offlineRoutes: {
        openDeck() {
          uiState.set('podium:superagent:mode', 'open')
          runtime.ui.setSelectedIssueId(asIssueId('demo-mission-root'))
          runtime.ui.setView('workspace')
        },
      },
    })
  }, [runtime, uiState])
  return <AppBody syncProgress={syncProgress} />
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
