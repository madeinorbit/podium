import type { JSX } from 'react'
import { useState } from 'react'
import { Toaster } from '@/components/ui/sonner'
import { TooltipProvider } from '@/components/ui/tooltip'
import { ConfirmProvider } from '@/hooks/use-confirm'
import { useIsMobile } from '@/hooks/use-is-mobile'
import { AppErrorPage } from './AppErrorPage'
import { ErrorBoundary } from './ErrorBoundary'
import { HomeView } from './HomeView'
import { IssuesView } from './IssuesView'
import { MobileApp } from './MobileApp'
import { OnboardingWizard } from './OnboardingWizard'
import { SettingsView } from './SettingsView'
import { Sidebar } from './Sidebar'
import { SuperagentView } from './SuperagentView'
import { StoreProvider, useStore } from './store'
import { serverConfig } from './trpc'
import { UpdatePrompt } from './UpdatePrompt'
import { UsageView } from './UsageView'
import { Workspace } from './Workspace'

/** Cold-start splash shown while the first backend state fetch is in flight. */
function LoadingScreen(): JSX.Element {
  return (
    <div className="app-loading" role="status" aria-live="polite">
      <span className="app-loading-spinner" aria-hidden="true" />
      <span>Loading Podium…</span>
    </div>
  )
}

export function AppShell(): JSX.Element {
  // Relay endpoints are always resolved automatically — never typed by the user.
  // serverConfig() derives same-origin ws:// + tRPC URLs from window.location (the
  // host server proxies /client + /trpc to the backend), and honors an explicit
  // `?server=ws://host:port` URL override for connecting to a remote relay.
  const [config] = useState(() => serverConfig(window.location))
  const [appError, setAppError] = useState<string | null>(null)
  const isMobile = useIsMobile()

  return (
    <TooltipProvider>
      <UpdatePrompt />
      {appError ? (
        <AppErrorPage
          title="Podium could not connect"
          message={appError}
          onRetry={() => setAppError(null)}
        />
      ) : (
        <ErrorBoundary
          resetKey={config.wsClientUrl}
          onRetry={() => setAppError(null)}
          onError={setAppError}
        >
          <StoreProvider config={config} onFatalError={setAppError}>
            <ConfirmProvider>
              <AppBody isMobile={isMobile} />
            </ConfirmProvider>
          </StoreProvider>
        </ErrorBoundary>
      )}
      <Toaster
        position="top-center"
        // Clear the iOS Dynamic Island / notch in installed-PWA standalone
        // mode, where env(safe-area-inset-top) is non-zero; otherwise the
        // update prompt lands under the island and can't be tapped. Falls
        // back to sonner's defaults (24px desktop / 16px mobile) in browser
        // tabs, where the inset resolves to 0.
        offset={{ top: 'calc(env(safe-area-inset-top, 0px) + 24px)' }}
        mobileOffset={{ top: 'calc(env(safe-area-inset-top, 0px) + 16px)' }}
      />
    </TooltipProvider>
  )
}

function AppBody({ isMobile }: { isMobile: boolean }): JSX.Element {
  const { repos, reposLoaded, view, superOpen, setSuperOpen } = useStore()
  const [dismissed, setDismissed] = useState(false)

  // Cold start: the first backend fetch (repos/pins/tab orders) hasn't resolved
  // yet. Show a loading splash rather than flashing an empty shell — and never
  // mistake "still loading" for the first-run empty state below.
  if (!reposLoaded) return <LoadingScreen />

  // First run: the registry is genuinely empty (not just still loading). Show the
  // onboarding scan flow. Adding repos makes it non-empty; dismissing skips to the
  // empty workspace, where "+ Add repo" reopens the same flow.
  if (repos.length === 0 && !dismissed) {
    return <OnboardingWizard onDismiss={() => setDismissed(true)} />
  }

  if (isMobile) return <MobileApp />
  return (
    <div className="desktop-shell">
      <Sidebar />
      {view === 'home' ? (
        <HomeView />
      ) : view === 'settings' ? (
        <SettingsView />
      ) : view === 'usage' ? (
        <UsageView />
      ) : view === 'issues' ? (
        <IssuesView />
      ) : (
        <Workspace />
      )}
      {/* The superagent / BTW thread is a collapsible right dock, so you can watch
          an agent and orchestrate it side by side instead of a full-screen swap. */}
      {superOpen && (
        <aside className="flex w-[400px] max-w-[40vw] min-w-[320px] flex-none flex-col border-l border-border bg-card">
          <SuperagentView onClose={() => setSuperOpen(false)} />
        </aside>
      )}
    </div>
  )
}
