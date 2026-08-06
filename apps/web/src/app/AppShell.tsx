import { shallowEqual } from '@podium/client-core/store'
import { trayCount } from '@podium/client-core/viewmodels'
import type { IssueColorSlot } from '@podium/model'
import { ChevronLeft, ChevronRight } from 'lucide-react'
import type { CSSProperties, JSX, ReactNode } from 'react'
import { useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'
import { IssuePeekOverlay } from '@/components/IssuePeekOverlay'
import { RefMiniviewHost, RefPrefixSync } from '@/components/RefMiniview'
import { Toaster } from '@/components/ui/sonner'
import { TooltipProvider } from '@/components/ui/tooltip'
import { SettingsView } from '@/features/settings/SettingsView'
import { OnboardingWizard } from '@/features/setup/OnboardingWizard'
import { SUPER_CHAT_OPEN_KEY, TRAY_OPEN_KEY } from '@/features/superagent/column-state'
import { SuperagentView } from '@/features/superagent/SuperagentView'
import { UsageView } from '@/features/usage/UsageView'
import { SidebarRail } from '@/features/worklist/SidebarRail'
import { SidebarUnified } from '@/features/worklist/SidebarUnified'
import { ResizableAside, ResizableColumn } from '@/features/worklist/sidebar-common'
import { ConfirmProvider } from '@/lib/hooks/use-confirm'
import { effectiveIssueColorHex, FLOW_SLATE } from '@/lib/issueColors'
import type { KernelAssembly } from '@/lib/kernelReplica'
import { ShadowComparisonRunner } from '@/lib/shadow/ShadowComparisonRunner'
import { useFeature } from '@/lib/use-feature'
import { useKernelReplica } from '@/lib/use-kernel-replica'
import { AppErrorPage } from './AppErrorPage'
import { ApprovalDialog } from './ApprovalDialog'
import { AsciiLoader } from './AsciiLoader'
import { AutoContinueDialog } from './AutoContinueDialog'
import { BrowserOpenOverlay } from './BrowserOpenOverlay'
import { CommandPalette } from './CommandPalette'
import { DensityProvider } from './density'
import { ErrorBoundary } from './ErrorBoundary'
import { FoldedSuperagentBar } from './FoldedSuperagentBar'
import { RightDock } from './RightDock'
import { RightRail } from './RightRail'
import { MainViewOutlet } from './routes'
import { StatusStrip } from './StatusStrip'
import {
  isOverlayView,
  nextBaseView,
  OPEN_RIGHT_PANEL_EVENT,
  RIGHT_PANEL_KEY,
  type RightPanelTab,
  readBooleanState,
  readRightPanel,
  readSuperagentMode,
  SIDEBAR_COLLAPSED_KEY,
  SUPERAGENT_MODE_KEY,
  type SuperagentMode,
} from './shell-state'
import { describeWireSkew, reportSkew } from './skew-notice'
import { type MainView, StoreProvider, useReplicaIssues, useStoreSelector } from './store'
import { ToolbarSlotProvider } from './ToolbarSlot'
import { TopBar } from './TopBar'
import { ThemeUiStateMirror } from './theme'
import { makeTrpc, serverConfig } from './trpc'
import { UpdatePrompt } from './UpdatePrompt'
import { Workspace } from './Workspace'

function LoadingScreen(): JSX.Element {
  return (
    <div className="app-loading" role="status" aria-live="polite">
      <AsciiLoader />
    </div>
  )
}

/**
 * Attach the engine's hub to the kernel assembly (POD-1223).
 *
 * A re-bootstrap is a reconnect, so `PushedBootstrapSource` needs the hub — and
 * the hub is built by the engine FROM the assembly, so it cannot be handed over
 * at construction. This runs inside the provider, where the hub exists.
 */
function KernelHubAttach({ assembly }: { assembly: KernelAssembly }): null {
  const hub = useStoreSelector((s) => s.hub)
  useEffect(() => {
    assembly.attachHub(hub)
  }, [assembly, hub])
  // The transport's ground truth about build skew (POD-1610): rows or whole
  // frames this build could not read. Routed to the module-level notice rather
  // than to local state so the banner can live OUTSIDE this subtree — the failure
  // it reports is one where this subtree is the thing that did not come up.
  useEffect(() => hub.onWireSkew((skew) => reportSkew(describeWireSkew(skew))), [hub])
  return null
}

export function AppShell(): JSX.Element {
  const [config] = useState(() => serverConfig(window.location))
  const [appError, setAppError] = useState<string | null>(null)
  // One tRPC client for the gate, memoized on the origin so the gate's effect
  // does not re-run (and re-open IndexedDB) on every render.
  const [gateTrpc] = useState(() => makeTrpc(config.httpOrigin))
  const kernel = useKernelReplica({ httpOrigin: config.httpOrigin, trpc: gateTrpc })

  // Queued offline writes the boot migration could not simply carry across
  // (POD-1232). Shown once, as a toast rather than a console line, because the
  // work is the user's and the two outcomes it reports — parked for review, or
  // kept on disk unsent — are things only they can act on.
  const migrationNotice = kernel.status === 'kernel' ? kernel.notice : undefined
  useEffect(() => {
    if (migrationNotice !== undefined) toast(migrationNotice)
  }, [migrationNotice])

  // The store must not mount until BOTH gates settle: the desktop SQLite
  // replica and the kernel-replica decision. Each one is a synchronous read the
  // engine makes at construction.
  if (kernel.status === 'resolving') {
    return (
      <TooltipProvider>
        <LoadingScreen />
      </TooltipProvider>
    )
  }

  if (kernel.status === 'failed') {
    return (
      <TooltipProvider>
        <AppErrorPage
          title="Podium could not open its private replica"
          message={kernel.failure}
          onRetry={() => window.location.reload()}
        />
      </TooltipProvider>
    )
  }

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
          <StoreProvider
            // The principal the boot gate resolved from the authenticated
            // transport — the runtime, its socket, its replica and its outbox
            // are all bound to it, and a change to it rebuilds all three
            // (POD-404). Never read from the URL or a raw storage key.
            principal={kernel.principal}
            config={config}
            onFatalError={setAppError}
            createReplicaFn={kernel.assembly.createReplicaFn}
            feed={kernel.assembly.feed}
            createOutboxFn={kernel.assembly.createOutboxFn}
          >
            <KernelHubAttach assembly={kernel.assembly} />
            {kernel.shadow ? (
              <ShadowComparisonRunner
                assembly={kernel.assembly}
                trpc={gateTrpc}
                wsClientUrl={config.wsClientUrl}
                authorityScoped={kernel.authorityScoped}
              />
            ) : null}
            <RoutedDensityProvider>
              <ThemeUiStateMirror />
              <BrowserOpenOverlay />
              <ConfirmProvider>
                {/* Above both TopBar and the view outlet: the command bar's centre
                    is a portal target the active mode fills (POD-365). */}
                <ToolbarSlotProvider>
                  <AppBody />
                </ToolbarSlotProvider>
              </ConfirmProvider>
            </RoutedDensityProvider>
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

function RoutedDensityProvider({ children }: { children: ReactNode }): JSX.Element {
  const uiState = useStoreSelector((s) => s.uiState)
  return <DensityProvider uiState={uiState}>{children}</DensityProvider>
}

function AppBody(): JSX.Element {
  const {
    repos,
    reposLoaded,
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
  const view = useStoreSelector((s) => s.view)
  const setView = useStoreSelector((s) => s.setView)
  const issues = useReplicaIssues()
  // Settings and Usage are utilities layered OVER a mode, not modes themselves
  // (POD-365). The shell keeps rendering the mode underneath, and closing the
  // sheet returns you to the one you actually came from rather than always
  // dumping you in the workspace.
  const overlay = isOverlayView(view)
  const [baseView, setBaseView] = useState<MainView>(() => (overlay ? 'workspace' : view))
  useEffect(() => {
    setBaseView((current) => nextBaseView(current, view))
  }, [view])
  const closeOverlay = (): void => setView(baseView)
  const workspaceActive = baseView === 'workspace'
  const sessions = useStoreSelector((s) => s.sessions)
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
  const commandPaletteEnabled = useFeature('command-palette')
  const gitPanelEnabled = useFeature('git-panel')
  const messagesPanelEnabled = useFeature('messages-panel')
  const panelAllowed = (panel: RightPanelTab | null): boolean =>
    panel !== 'git' && panel !== 'mail'
      ? true
      : panel === 'git'
        ? gitPanelEnabled
        : messagesPanelEnabled
  const visibleRightPanel = panelAllowed(rightPanel) ? rightPanel : null

  const setSidebarCollapsed = (collapsed: boolean): void => {
    setSidebarCollapsedState(collapsed)
    uiState.set(SIDEBAR_COLLAPSED_KEY, String(collapsed))
  }
  const setSuperMode = (mode: SuperagentMode): void => {
    setSuperModeState(mode)
    uiState.set(SUPERAGENT_MODE_KEY, mode)
    setSuperOpen(mode === 'open')
  }
  const setRightPanel = (panel: RightPanelTab | null): void => {
    if (!panelAllowed(panel)) return
    setRightPanelState(panel)
    uiState.set(RIGHT_PANEL_KEY, panel ?? '')
  }

  // superOpen (store) is how surfaces outside the shell drive the column
  // (palette toggle, concierge/btw opens). The shell mirrors persisted mode
  // back into the store once, then follows superOpen CHANGES only — and
  // resolves close to 'folded': the column never fully disappears (#65).
  const lastSuperOpen = useRef(superOpen)
  useEffect(() => {
    if (superOpen === lastSuperOpen.current) return
    lastSuperOpen.current = superOpen
    const mode = superOpen ? 'open' : 'folded'
    setSuperModeState(mode)
    uiState.set(SUPERAGENT_MODE_KEY, mode)
  }, [superOpen, uiState])
  // biome-ignore lint/correctness/useExhaustiveDependencies: mount-only — seed the store from the persisted desktop mode.
  useEffect(() => {
    setSuperOpen(superMode === 'open')
  }, [])

  // Deep surfaces (the pane header's git stamp [POD-98]) ask for a dock panel
  // via a window event — the panel state is AppShell-local. A request for a
  // feature-gated panel falls back to the Task panel (its Git section is the
  // next-best detail view).
  useEffect(() => {
    const onOpenPanel = (event: Event): void => {
      const detail = (event as CustomEvent).detail
      const panel = readRightPanel(typeof detail === 'string' ? detail : null)
      if (!panel) return
      setRightPanel(panelAllowed(panel) ? panel : 'issue')
    }
    window.addEventListener(OPEN_RIGHT_PANEL_EVENT, onOpenPanel)
    return () => window.removeEventListener(OPEN_RIGHT_PANEL_EVENT, onOpenPanel)
  })

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (
        commandPaletteEnabled &&
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
  }, [commandPaletteEnabled, paletteOpen, setPaletteOpen])

  if (!reposLoaded) return <LoadingScreen />
  if (repos.length === 0 && sessions.length === 0 && !dismissed) {
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
  // One colour-pick handler for every shell surface showing the ID square.
  const changeIssueColor = selectedIssue
    ? (color: IssueColorSlot | null) =>
        trpc.issues.update.mutate({ id: selectedIssue.id, patch: { color } })
    : undefined

  return (
    <>
      <div
        className="desktop-shell issue-scope"
        data-issue-colored={effectiveHex ? 'true' : 'false'}
        style={issueStyle}
      >
        <TopBar />
        <div className="desktop-shell-row" data-sidebar-collapsed={sidebarCollapsed}>
          {/* The work list is persistent chrome: it stays mounted in every mode,
              so switching modes swaps the CONTENT REGION rather than the window
              (POD-365). The engraved column, dock and rail are workspace
              instruments and stay with the workspace. */}
          {sidebarCollapsed ? (
            <aside className="collapsed-sidebar" aria-label="Collapsed work sidebar">
              <button
                data-pressable
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
                data-pressable
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
          {workspaceActive && superMode === 'open' && (
            <ResizableColumn
              storageKey="podium:superagent:width"
              min={320}
              max={860}
              defaultWidth={400}
              handleLabel="Resize tray and superagent"
              className="max-w-[45vw]"
            >
              <aside className="engraved-column" data-superagent-mode="open">
                <SuperagentView onClose={() => setSuperMode('folded')} />
              </aside>
            </ResizableColumn>
          )}
          {workspaceActive && superMode === 'folded' && (
            <FoldedSuperagentBar
              trayCount={trayCount(issues, sessions)}
              onExpand={(target) => {
                // Land on the clicked half (3b/3d): pre-open that section so
                // the expanding column mounts with it visible.
                if (target === 'tray') uiState.set(TRAY_OPEN_KEY, 'true')
                if (target === 'superagent') uiState.set(SUPER_CHAT_OPEN_KEY, 'true')
                setSuperMode('open')
              }}
            />
          )}
          <MainViewOutlet workspace={<Workspace />} view={baseView} />
          {workspaceActive && visibleRightPanel && (
            <ResizableColumn
              storageKey="podium:rightdock:width"
              min={280}
              max={860}
              defaultWidth={340}
              handleLabel="Resize right dock"
              handleSide="left"
              className="max-w-[45vw]"
            >
              <aside className="right-dock-shell issue-base-card issue-fade">
                <RightDock tab={visibleRightPanel} onClose={() => setRightPanel(null)} />
              </aside>
            </ResizableColumn>
          )}
          {workspaceActive && (
            <RightRail
              issue={selectedIssue}
              rightPanel={visibleRightPanel}
              onPanelChange={setRightPanel}
              onColorChange={changeIssueColor}
            />
          )}
        </div>
        <StatusStrip />
      </div>
      {/* The utility tier (POD-365): an inset sheet over a live shell. The mode
          underneath stays mounted, so closing is instant and the chrome never
          blinks out of existence. */}
      {view === 'settings' && <SettingsView onClose={closeOverlay} />}
      {view === 'usage' && <UsageView onClose={closeOverlay} />}
      <AutoContinueDialog />
      <ApprovalDialog />
      {commandPaletteEnabled && <CommandPalette />}
      {/* Ref linkify (#474): keep the known-prefix set fresh and host the single
          floating miniview. Both render nothing until there's something to show. */}
      <RefPrefixSync />
      <RefMiniviewHost />
      {/* The issue peek drawer (POD-95): a chat ref's "open" — slides in OVER
          the right edge (dock + rail included), above the normal UI. */}
      <IssuePeekOverlay />
    </>
  )
}
