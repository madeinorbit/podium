import { PanelRightClose, PanelRightOpen } from 'lucide-react'
import type { JSX } from 'react'
import { lazy, Suspense, useEffect, useState } from 'react'
import { Toaster } from '@/components/ui/sonner'
import { TooltipProvider } from '@/components/ui/tooltip'
import { ConfirmProvider } from '@/hooks/use-confirm'
import { useIsMobile } from '@/hooks/use-is-mobile'
import { AppErrorPage } from './AppErrorPage'
import { AutoContinueDialog } from './AutoContinueDialog'
import { AutomationsView } from './AutomationsView'
import { CommandPalette } from './CommandPalette'
import { ErrorBoundary } from './ErrorBoundary'
import { HomeView } from './HomeView'
import { IssuesView } from './IssuesView'
import { MobileApp } from './MobileApp'
import { OnboardingWizard } from './OnboardingWizard'
import { RightDock } from './RightDock'
import { SettingsView } from './SettingsView'
import { Sidebar } from './Sidebar'
import { StoreProvider, useStore } from './store'
import { serverConfig } from './trpc'
import { UpdatePrompt } from './UpdatePrompt'
import { UsageView } from './UsageView'
import { Workspace } from './Workspace'

// Lazy: BlockNote (the spec WYSIWYG editor) is a heavy chunk only Specs needs —
// keeping it out of the shell bundle also keeps every precached file under
// workbox's 2 MB per-file cap.
const SpecsView = lazy(() => import('./SpecsView').then((m) => ({ default: m.SpecsView })))

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
  const { repos, reposLoaded, view, superOpen, setSuperOpen, paletteOpen, setPaletteOpen } =
    useStore()
  const [dismissed, setDismissed] = useState(false)

  // Global Cmd/Ctrl+K toggles the command palette. Registered at shell level so
  // it works from every view; IssuesView's global handler already ignores
  // meta-chords, and its `[role="dialog"]` guard makes it inert while open.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if ((e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        setPaletteOpen(!paletteOpen)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [paletteOpen, setPaletteOpen])

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

  return (
    <>
      {isMobile ? (
        <MobileApp />
      ) : (
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
          ) : view === 'automations' ? (
            <AutomationsView />
          ) : view === 'specs' ? (
            <Suspense fallback={<LoadingScreen />}>
              <SpecsView />
            </Suspense>
          ) : (
            <Workspace />
          )}
          {/* The superagent / BTW thread is a collapsible right dock, so you can watch
              an agent and orchestrate it side by side instead of a full-screen swap. */}
          {superOpen && (
            <aside className="flex w-[400px] max-w-[40vw] min-w-[320px] flex-none flex-col border-l border-border bg-card">
              <RightDock />
            </aside>
          )}
          {/* Always-visible dock toggle rail (IDE-style): open/close the right
              panel from anywhere, independent of the sidebar Superagent button. */}
          <div className="flex flex-none flex-col items-center border-l border-border bg-card px-0.5 pt-1.5">
            <button
              type="button"
              aria-label={superOpen ? 'Close right panel' : 'Open right panel'}
              title={superOpen ? 'Close right panel' : 'Open right panel'}
              aria-pressed={superOpen}
              onClick={() => setSuperOpen(!superOpen)}
              className="rounded-md p-1.5 text-muted-foreground hover:bg-accent hover:text-foreground"
            >
              {superOpen ? (
                <PanelRightClose size={16} aria-hidden="true" />
              ) : (
                <PanelRightOpen size={16} aria-hidden="true" />
              )}
            </button>
          </div>
        </div>
      )}
      <AutoContinueDialog />
      <CommandPalette />
    </>
  )
}
