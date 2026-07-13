import { shallowEqual } from '@podium/client-core/store'
import { Sparkles } from 'lucide-react'
import type { JSX } from 'react'
import { useEffect, useState } from 'react'
import { Toaster } from '@/components/ui/sonner'
import { TooltipProvider } from '@/components/ui/tooltip'
import { HostStatusBar } from '@/features/machines/HostIndicators'
import { OnboardingWizard } from '@/features/setup/OnboardingWizard'
import { SuperagentView } from '@/features/superagent/SuperagentView'
import { SidebarUnified } from '@/features/worklist/SidebarUnified'
import { ResizableAside, ResizableColumn } from '@/features/worklist/sidebar-common'
import { ConfirmProvider } from '@/lib/hooks/use-confirm'
import { useIsMobile } from '@/lib/hooks/use-is-mobile'
import { cn } from '@/lib/utils'
import { AppErrorPage } from './AppErrorPage'
import { AutoContinueDialog } from './AutoContinueDialog'
import { CommandPalette } from './CommandPalette'
import { ErrorBoundary } from './ErrorBoundary'
import { MobileApp } from './MobileApp'
import { RIGHT_PANELS, RightDock, type RightPanelTab } from './RightDock'
import { MainViewOutlet } from './routes'
import { StoreProvider, useStoreSelector } from './store'
import { ThemeUiStateMirror } from './theme'
import { serverConfig } from './trpc'
import { UpdatePrompt } from './UpdatePrompt'
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
        // Render crashes are handled INSIDE the boundary (its own "Podium
        // crashed" page) — never funneled into `appError`, which is strictly
        // for connection/boot failures and titles itself accordingly.
        <ErrorBoundary resetKey={config.wsClientUrl} onRetry={() => setAppError(null)}>
          <StoreProvider config={config} onFatalError={setAppError}>
            {/* Theme initializes pre-store (anti-flash) — this mirrors it into ui-state. */}
            <ThemeUiStateMirror />
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

const RIGHT_PANEL_KEY = 'podium.rightPanel'

function readStoredRightPanel(v: string | null): RightPanelTab | null {
  return v === 'files' || v === 'git' || v === 'issue' || v === 'shell' ? v : null
}

function AppBody({ isMobile }: { isMobile: boolean }): JSX.Element {
  const {
    repos,
    reposLoaded,
    superOpen,
    setSuperOpen,
    paletteOpen,
    setPaletteOpen,
    uiState,
  } = useStoreSelector(
    (s) => ({
      repos: s.repos,
      reposLoaded: s.reposLoaded,
      superOpen: s.superOpen,
      setSuperOpen: s.setSuperOpen,
      paletteOpen: s.paletteOpen,
      setPaletteOpen: s.setPaletteOpen,
      uiState: s.uiState,
    }),
    shallowEqual,
  )
  const [dismissed, setDismissed] = useState(false)
  // The right dock panel (Files/Git/Issue), opened from the thin icon rail on the
  // shell's right edge. One panel at a time; persisted like the other shell state.
  const [rightPanel, setRightPanelState] = useState<RightPanelTab | null>(() =>
    readStoredRightPanel(uiState.get(RIGHT_PANEL_KEY)),
  )
  const setRightPanel = (tab: RightPanelTab | null): void => {
    setRightPanelState(tab)
    uiState.set(RIGHT_PANEL_KEY, tab ?? '')
  }

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
          <div className="desktop-shell-row">
            <ResizableAside>
              <SidebarUnified />
            </ResizableAside>
            {/* The superagent is the CENTER column (sidebar | superagent |
                workspace), collapsible via superOpen so the workspace can go
                wide, drag-resizable on its right edge like the sidebar. */}
            {superOpen && (
              <ResizableColumn
                storageKey="podium:superagent:width"
                min={320}
                max={860}
                defaultWidth={460}
                handleLabel="Resize superagent panel"
                className="max-w-[55vw]"
              >
                <aside className="flex w-full min-w-0 min-h-0 flex-col border-r border-border bg-background">
                  <SuperagentView onClose={() => setSuperOpen(false)} />
                </aside>
              </ResizableColumn>
            )}
            <MainViewOutlet workspace={<Workspace />} />
            {rightPanel && (
              <ResizableColumn
                storageKey="podium:rightdock:width"
                min={280}
                max={860}
                defaultWidth={340}
                handleLabel="Resize right dock"
                handleSide="left"
                className="max-w-[45vw]"
              >
                <aside className="flex w-full min-w-0 min-h-0 flex-col border-l border-border bg-background">
                  <RightDock tab={rightPanel} onClose={() => setRightPanel(null)} />
                </aside>
              </ResizableColumn>
            )}
            {/* Thin right rail: always visible, vertical icons — reopen the
                superagent column, and toggle the Files/Git/Issue panel. */}
            <nav
              aria-label="Panels"
              className="flex flex-none flex-col items-center gap-1 border-l border-border bg-card px-[3px] pt-1.5"
            >
              {!superOpen && (
                <button
                  type="button"
                  aria-label="Open superagent"
                  title="Open superagent"
                  onClick={() => setSuperOpen(true)}
                  className="flex size-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                >
                  <Sparkles size={15} aria-hidden="true" />
                </button>
              )}
              {RIGHT_PANELS.map((p) => (
                <button
                  key={p.id}
                  type="button"
                  aria-label={p.label}
                  aria-pressed={rightPanel === p.id}
                  title={p.label}
                  onClick={() => setRightPanel(rightPanel === p.id ? null : p.id)}
                  className={cn(
                    'flex size-7 items-center justify-center rounded-md transition-colors',
                    rightPanel === p.id
                      ? 'bg-secondary text-primary'
                      : 'text-muted-foreground hover:bg-accent hover:text-foreground',
                  )}
                >
                  <p.icon size={15} aria-hidden="true" />
                </button>
              ))}
            </nav>
          </div>
          <HostStatusBar />
        </div>
      )}
      <AutoContinueDialog />
      <CommandPalette />
    </>
  )
}
