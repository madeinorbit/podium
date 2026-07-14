import { shallowEqual } from '@podium/client-core/store'
import { ChevronLeft, ChevronRight } from 'lucide-react'
import type { CSSProperties, JSX } from 'react'
import { useEffect, useState } from 'react'
import { Toaster } from '@/components/ui/sonner'
import { TooltipProvider } from '@/components/ui/tooltip'
import { OnboardingWizard } from '@/features/setup/OnboardingWizard'
import { SUPER_CHAT_OPEN_KEY, TRAY_OPEN_KEY } from '@/features/superagent/column-state'
import { trayCount } from '@/features/superagent/derive-tray'
import { SuperagentView } from '@/features/superagent/SuperagentView'
import { useIssueEvents } from '@/features/superagent/useIssueEvents'
import { SidebarRail } from '@/features/worklist/SidebarRail'
import { SidebarUnified } from '@/features/worklist/SidebarUnified'
import { ResizableAside, ResizableColumn } from '@/features/worklist/sidebar-common'
import { ConfirmProvider } from '@/lib/hooks/use-confirm'
import { useIsMobile } from '@/lib/hooks/use-is-mobile'
import { effectiveIssueColorHex, FLOW_SLATE } from '@/lib/issueColors'
import { AppErrorPage } from './AppErrorPage'
import { ApprovalDialog } from './ApprovalDialog'
import { AutoContinueDialog } from './AutoContinueDialog'
import { CommandPalette } from './CommandPalette'
import { ErrorBoundary } from './ErrorBoundary'
import { FoldedSuperagentBar } from './FoldedSuperagentBar'
import { MobileApp } from './MobileApp'
import { RightDock } from './RightDock'
import { RightRail } from './RightRail'
import { MainViewOutlet } from './routes'
import {
  RIGHT_PANEL_KEY,
  RIGHT_PANEL_LAST_KEY,
  type RightPanelTab,
  readBooleanState,
  readLastRightPanel,
  readRightPanel,
  readSuperagentMode,
  SIDEBAR_COLLAPSED_KEY,
  SUPERAGENT_MODE_KEY,
  type SuperagentMode,
} from './shell-state'
import { StoreProvider, useStoreSelector } from './store'
import { TopBar } from './TopBar'
import { ThemeUiStateMirror } from './theme'
import { serverConfig } from './trpc'
import { UpdatePrompt } from './UpdatePrompt'
import { Workspace } from './Workspace'

function LoadingScreen(): JSX.Element {
  return (
    <div className="app-loading" role="status" aria-live="polite">
      <span className="app-loading-spinner" aria-hidden="true" />
      <span>Loading Podium…</span>
    </div>
  )
}

export function AppShell(): JSX.Element {
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
        <ErrorBoundary resetKey={config.wsClientUrl} onRetry={() => setAppError(null)}>
          <StoreProvider config={config} onFatalError={setAppError}>
            <ThemeUiStateMirror />
            <ConfirmProvider>
              <AppBody isMobile={isMobile} />
            </ConfirmProvider>
          </StoreProvider>
        </ErrorBoundary>
      )}
      <Toaster
        position="top-center"
        offset={{ top: 'calc(env(safe-area-inset-top, 0px) + 24px)' }}
        mobileOffset={{ top: 'calc(env(safe-area-inset-top, 0px) + 16px)' }}
      />
    </TooltipProvider>
  )
}

function AppBody({ isMobile }: { isMobile: boolean }): JSX.Element {
  const {
    repos,
    reposLoaded,
    issues,
    selectedIssueId,
    superOpen,
    setSuperOpen,
    paletteOpen,
    setPaletteOpen,
    uiState,
    trpc,
  } = useStoreSelector(
    (s) => ({
      repos: s.repos,
      reposLoaded: s.reposLoaded,
      issues: s.issues,
      selectedIssueId: s.selectedIssueId,
      superOpen: s.superOpen,
      setSuperOpen: s.setSuperOpen,
      paletteOpen: s.paletteOpen,
      setPaletteOpen: s.setPaletteOpen,
      uiState: s.uiState,
      trpc: s.trpc,
    }),
    shallowEqual,
  )
  const [dismissed, setDismissed] = useState(false)
  const [sidebarCollapsed, setSidebarCollapsedState] = useState(() =>
    readBooleanState(uiState.get(SIDEBAR_COLLAPSED_KEY)),
  )
  const [superMode, setSuperModeState] = useState<SuperagentMode>(() =>
    readSuperagentMode(uiState.get(SUPERAGENT_MODE_KEY), superOpen),
  )
  const [rightPanel, setRightPanelState] = useState<RightPanelTab | null>(() =>
    readRightPanel(uiState.get(RIGHT_PANEL_KEY)),
  )
  const [lastRightPanel, setLastRightPanel] = useState<RightPanelTab>(() =>
    readLastRightPanel(uiState.get(RIGHT_PANEL_LAST_KEY)),
  )

  const setSidebarCollapsed = (collapsed: boolean): void => {
    setSidebarCollapsedState(collapsed)
    uiState.set(SIDEBAR_COLLAPSED_KEY, String(collapsed))
  }
  const setSuperMode = (mode: SuperagentMode): void => {
    setSuperModeState(mode)
    uiState.set(SUPERAGENT_MODE_KEY, mode)
    setSuperOpen(mode !== 'closed')
  }
  const setRightPanel = (panel: RightPanelTab | null): void => {
    setRightPanelState(panel)
    uiState.set(RIGHT_PANEL_KEY, panel ?? '')
    if (panel) {
      setLastRightPanel(panel)
      uiState.set(RIGHT_PANEL_LAST_KEY, panel)
    }
  }

  useEffect(() => {
    if (!superOpen && superMode !== 'closed') {
      setSuperModeState('closed')
      uiState.set(SUPERAGENT_MODE_KEY, 'closed')
    } else if (superOpen && superMode === 'closed') {
      setSuperModeState('open')
      uiState.set(SUPERAGENT_MODE_KEY, 'open')
    }
  }, [superOpen, superMode, uiState])

  // The folded 3d bar keeps the ✦ unread dot live — this instance polls only
  // while folded (the open column's own view polls otherwise).
  const foldedFeed = useIssueEvents(trpc, uiState, false, superMode === 'folded')

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (
        (event.metaKey || event.ctrlKey) &&
        !event.altKey &&
        !event.shiftKey &&
        event.key.toLowerCase() === 'k'
      ) {
        event.preventDefault()
        setPaletteOpen(!paletteOpen)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [paletteOpen, setPaletteOpen])

  if (!reposLoaded) return <LoadingScreen />
  if (repos.length === 0 && !dismissed) {
    return <OnboardingWizard onDismiss={() => setDismissed(true)} />
  }

  const selectedIssue = selectedIssueId
    ? issues.find((issue) => issue.id === selectedIssueId && !issue.archived && !issue.deletedAt)
    : undefined
  // The one reactive colour source (§4.2): the selected issue's flow colour —
  // own palette slot, else the nearest coloured ancestor's (an uncoloured
  // sub-issue runs its parent's context) — scoped as --issue on the shell
  // root. data-issue-colored drives the quieter slate percentages, and
  // .issue-scope derives the text ramp and the .4s crossfade (index.css).
  const effectiveHex = effectiveIssueColorHex(selectedIssue, (id) =>
    issues.find((issue) => issue.id === id),
  )
  const issueAccent = effectiveHex ?? FLOW_SLATE
  const issueStyle = { '--issue': issueAccent } as CSSProperties

  return (
    <>
      {isMobile ? (
        <MobileApp />
      ) : (
        <div
          className="desktop-shell issue-scope"
          data-issue-colored={effectiveHex ? 'true' : 'false'}
          style={issueStyle}
        >
          <TopBar superMode={superMode} onSuperModeChange={setSuperMode} />
          <div className="desktop-shell-row" data-sidebar-collapsed={sidebarCollapsed}>
            {sidebarCollapsed ? (
              <aside className="collapsed-sidebar" aria-label="Collapsed work sidebar">
                <button
                  type="button"
                  className="collapsed-sidebar-expand"
                  aria-label="Expand sidebar"
                  title="Expand sidebar"
                  onClick={() => setSidebarCollapsed(false)}
                >
                  <ChevronRight size={13} aria-hidden="true" />
                </button>
                <SidebarRail />
              </aside>
            ) : (
              <div className="relative z-10 flex flex-none">
                <ResizableAside>
                  <SidebarUnified />
                </ResizableAside>
                <button
                  type="button"
                  className="sidebar-collapse-control"
                  aria-label="Collapse sidebar"
                  title="Collapse sidebar"
                  onClick={() => setSidebarCollapsed(true)}
                >
                  <ChevronLeft size={12} aria-hidden="true" />
                </button>
              </div>
            )}
            {superMode === 'open' && (
              <ResizableColumn
                storageKey="podium:superagent:width"
                min={320}
                max={860}
                defaultWidth={460}
                handleLabel="Resize tray and superagent"
                className="max-w-[55vw]"
              >
                <aside
                  className="engraved-column issue-base-engraved issue-glow"
                  data-superagent-mode="open"
                >
                  <SuperagentView onClose={() => setSuperMode('folded')} />
                </aside>
              </ResizableColumn>
            )}
            {superMode === 'folded' && (
              <FoldedSuperagentBar
                issue={selectedIssue}
                trayCount={trayCount(issues, selectedIssue?.id ?? null)}
                unread={foldedFeed.unread}
                onExpand={(target) => {
                  // Land on the clicked half (3b/3d): pre-open that section so
                  // the expanding column mounts with it visible.
                  if (target === 'tray') uiState.set(TRAY_OPEN_KEY, 'true')
                  if (target === 'superagent') uiState.set(SUPER_CHAT_OPEN_KEY, 'true')
                  setSuperMode('open')
                }}
                onClose={() => setSuperMode('closed')}
                onColorChange={
                  selectedIssue
                    ? (color) =>
                        trpc.issues.update.mutate({ id: selectedIssue.id, patch: { color } })
                    : undefined
                }
              />
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
                <aside className="right-dock-shell">
                  <RightDock tab={rightPanel} onClose={() => setRightPanel(null)} />
                </aside>
              </ResizableColumn>
            )}
            <RightRail
              issue={selectedIssue}
              rightPanel={rightPanel}
              lastPanel={lastRightPanel}
              superMode={superMode}
              onPanelChange={setRightPanel}
              onSuperModeChange={setSuperMode}
            />
          </div>
        </div>
      )}
      <AutoContinueDialog />
      <ApprovalDialog />
      <CommandPalette />
    </>
  )
}
