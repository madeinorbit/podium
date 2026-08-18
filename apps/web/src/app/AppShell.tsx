import { shallowEqual } from '@podium/client-core/store'
import { ChevronLeft, ChevronRight } from 'lucide-react'
import { useReducedMotion } from 'motion/react'
import type { CSSProperties, JSX, ReactNode } from 'react'
import { lazy, Suspense, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { flushSync } from 'react-dom'
import { toast } from 'sonner'
import { RefMiniviewHost, RefPrefixSync } from '@/components/RefMiniview'
import { Toaster } from '@/components/ui/sonner'
import { TooltipProvider } from '@/components/ui/tooltip'
import { IssueExplorerProvider } from '@/features/issues/explorer/explorer-context'
import { recoverFromWireSkew } from '@/features/setup/version-guard'
import { DockShellLifecycle } from '@/features/terminal/dock-shell-lifecycle'
import { LoadingScreen } from './LoadingScreen'
import { SyncLoader } from './SyncLoader'
import {
  hasActivationState,
  isActivationEligible,
  shouldStartRemoteClientAtProjects,
} from '@/features/setup/activation-route'
import { restartPodiumShell } from '@/features/setup/restart-shell'
import { useActivationRoute } from '@/features/setup/use-activation-route'
import { useConfirmedVpsActivation } from '@/features/setup/use-vps-activation'
import { vpsIntroState } from '@/features/setup/vps-activation'
import { UpdatesProvider } from '@/features/updates/updates-context'
import { SidebarRail } from '@/features/worklist/SidebarRail'
import { SidebarUnified } from '@/features/worklist/SidebarUnified'
import { ResizableAside, ResizableColumn } from '@/features/worklist/sidebar-common'
import { ConfirmProvider } from '@/lib/hooks/use-confirm'
import { effectiveIssueColorHex, FLOW_CSS } from '@/lib/issueColors'
import { nativeDesktopBridge } from '@/lib/nativeDesktop'
import type { KernelAssembly } from '@/lib/kernelReplica'
import type { SyncProgressStore } from '@/lib/sync-progress'
import { useFeature } from '@/lib/use-feature'
import { useKernelReplica } from '@/lib/use-kernel-replica'
import { usePersistedUiState, usePersistedUiValue } from '@/lib/use-persisted-ui-state'
import { AppErrorPage } from './AppErrorPage'
import { AppSheet } from './AppSheet'
import { BrowserOpenOverlay } from './BrowserOpenOverlay'
import { CommandPaletteBoundary } from './CommandPaletteBoundary'
import { DesktopMenuHost } from './DesktopMenuHost'
import { DensityProvider } from './density'
import { ErrorBoundary } from './ErrorBoundary'
import { FoldedFlightDeckBar } from './FoldedFlightDeckBar'
import { OperatorFocusProvider } from './operator-focus'
import { RightDock } from './RightDock'
import { RightRail } from './RightRail'
import { MainViewOutlet } from './routes'
import { StatusStrip } from './StatusStrip'
import {
  CLOSE_RIGHT_PANEL,
  isOverlayView,
  nextBaseView,
  OPEN_RIGHT_PANEL_EVENT,
  RIGHT_PANEL_KEY,
  type RightPanelTab,
  readBooleanState,
  readFlightDeckCollapsed,
  readRightPanel,
  rightPanelAllowed,
  SIDEBAR_COLLAPSED_KEY,
  SUPERAGENT_MODE_KEY,
} from './shell-state'
import { describeWireSkew, reportSkew } from './skew-notice'
import { type MainView, StoreProvider, useReplicaIssues, useStoreSelector } from './store'
import { ToolbarSlotProvider } from './ToolbarSlot'
import { TopBar } from './TopBar'
import { ThemeUiStateMirror } from './theme'
import { makeTrpc, serverConfig } from './trpc'
import { Workspace } from './Workspace'

const SettingsView = lazy(() =>
  import('@/features/settings/SettingsView').then((module) => ({ default: module.SettingsView })),
)
const UsageView = lazy(() =>
  import('@/features/usage/UsageView').then((module) => ({ default: module.UsageView })),
)
// FlightDeck already unmounts when folded. Deferring its module in exactly that
// state changes no subscriptions or retained component state.
const FlightDeck = lazy(() =>
  import('./FlightDeck').then((module) => ({ default: module.FlightDeck })),
)
const OnboardingWizard = lazy(() =>
  import('@/features/setup/OnboardingWizard').then((module) => ({
    default: module.OnboardingWizard,
  })),
)
const ApprovalDialog = lazy(() =>
  import('./ApprovalDialog').then((module) => ({ default: module.ApprovalDialog })),
)
const AutoContinueDialog = lazy(() =>
  import('./AutoContinueDialog').then((module) => ({ default: module.AutoContinueDialog })),
)
function RouteFallback(): JSX.Element {
  return <div className="flex min-h-0 min-w-0 flex-1" aria-hidden="true" />
}

function SheetFallback({
  label,
  title,
  onClose,
  className,
}: {
  label: string
  title: string
  onClose: () => void
  className?: string
}): JSX.Element {
  return (
    <AppSheet label={label} title={title} onClose={onClose} className={className}>
      <div className="min-h-0 flex-1" aria-hidden="true" />
    </AppSheet>
  )
}

/**
 * Attach the engine's hub to the kernel assembly (POD-1223).
 *
 * A re-bootstrap is a reconnect, so `PushedBootstrapSource` needs the hub — and
 * the hub is built by the engine FROM the assembly, so it cannot be handed over
 * at construction. This runs inside the provider, where the hub exists.
 */
function KernelHubAttach({
  assembly,
  httpOrigin,
}: {
  assembly: KernelAssembly
  httpOrigin: string
}): null {
  const hub = useStoreSelector((s) => s.hub)
  useEffect(() => {
    assembly.attachHub(hub)
  }, [assembly, hub])
  // The transport's ground truth about build skew (POD-1610): rows or whole
  // frames this build could not read. Routed to the module-level notice rather
  // than to local state so the banner can live OUTSIDE this subtree — the failure
  // it reports is one where this subtree is the thing that did not come up.
  //
  // AND, since POD-2253, it is more than a report. A banner asks the tab to
  // reload; refused frames mean the tab may no longer be able to do anything it
  // is asked. So the same evidence re-runs the version handshake, which forces
  // the takeover when the server really is serving a different build — and does
  // nothing at all when it is not.
  useEffect(
    () =>
      hub.onWireSkew((skew) => {
        reportSkew(describeWireSkew(skew))
        void recoverFromWireSkew(httpOrigin, skew)
      }),
    [hub, httpOrigin],
  )
  return null
}

export function AppShell(): JSX.Element {
  const [config] = useState(() => serverConfig(window.location))
  const [appError, setAppError] = useState<string | null>(null)
  // One tRPC client for the gate, memoized on the origin so the gate's effect
  // does not re-run (and re-open IndexedDB) on every render.
  const [gateTrpc] = useState(() => makeTrpc(config.httpOrigin))
  const kernel = useKernelReplica({ trpc: gateTrpc, httpOrigin: config.httpOrigin })

  // Queued offline writes the boot migration could not simply carry across
  // (POD-1232). Shown once, as a toast rather than a console line, because the
  // work is the user's and the two outcomes it reports — parked for review, or
  // kept on disk unsent — are things only they can act on.
  const migrationNotice = kernel.status === 'kernel' ? kernel.notice : undefined
  useEffect(() => {
    if (migrationNotice !== undefined) toast(migrationNotice)
  }, [migrationNotice])

  // The store must not mount until its private replica is open. The engine reads
  // rows synchronously at construction, so there is no usable fallback assembly.
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
        <AppErrorPage title="Podium could not open its private replica" message={kernel.failure} />
      </TooltipProvider>
    )
  }

  return (
    <TooltipProvider>
      {/* The update surface wraps the whole shell (POD-2102): its panel renders
          here in the corner, and its indicator renders far below in the status
          strip. One provider so the two are the same state, never two pictures
          of one update. */}
      <UpdatesProvider httpOrigin={config.httpOrigin}>
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
              <KernelHubAttach assembly={kernel.assembly} httpOrigin={config.httpOrigin} />
              <RoutedDensityProvider>
                <ThemeUiStateMirror />
                <BrowserOpenOverlay />
                <ConfirmProvider>
                  {/* Above both TopBar and the view outlet: the command bar's centre
                    is a portal target the active mode fills (POD-365). */}
                  <ToolbarSlotProvider>
                    <AppBody syncProgress={kernel.assembly.progress} />
                  </ToolbarSlotProvider>
                </ConfirmProvider>
              </RoutedDensityProvider>
            </StoreProvider>
          </ErrorBoundary>
        )}
      </UpdatesProvider>
      {/* Clear of the command bar, not through it: 24px put a two-line toast
          straight across the bar's controls, which is where the operator is
          working. --topbar-h plus the bar's own 10px rhythm gap (POD-1159).
          The safe-area term stays — it is what makes the toast tappable in
          standalone PWA mode on a notched phone. */}
      <Toaster
        position="top-center"
        offset={{ top: 'calc(env(safe-area-inset-top, 0px) + var(--topbar-h) + 10px)' }}
        mobileOffset={{ top: 'calc(env(safe-area-inset-top, 0px) + var(--topbar-h) + 8px)' }}
      />
    </TooltipProvider>
  )
}

function RoutedDensityProvider({ children }: { children: ReactNode }): JSX.Element {
  const uiState = useStoreSelector((s) => s.uiState)
  const densityEnabled = useFeature('shell-density')
  return (
    <DensityProvider uiState={uiState} densityEnabled={densityEnabled}>
      {children}
    </DensityProvider>
  )
}

/** Module-scope so the setter keeps a stable identity across renders — an inline
 *  arrow would hand `RightRail` a new callback every render (POD-540). */
const writeRightPanel = (panel: RightPanelTab | null): string => panel ?? ''

function AppBody({ syncProgress }: { syncProgress: SyncProgressStore }): JSX.Element {
  const {
    repos,
    reposLoaded,
    selectedIssueId,
    setSelectedIssueId,
    superOpen,
    setSuperOpen,
    paletteOpen,
    setPaletteOpen,
    uiState,
  } = useStoreSelector(
    (s) => ({
      repos: s.repos,
      reposLoaded: s.reposLoaded,
      selectedIssueId: s.selectedIssueId,
      setSelectedIssueId: s.setSelectedIssueId,
      superOpen: s.superOpen,
      setSuperOpen: s.setSuperOpen,
      paletteOpen: s.paletteOpen,
      setPaletteOpen: s.setPaletteOpen,
      uiState: s.uiState,
    }),
    shallowEqual,
  )
  const view = useStoreSelector((s) => s.view)
  const setView = useStoreSelector((s) => s.setView)
  const sync = useSyncExternalStore(syncProgress.subscribe, syncProgress.getSnapshot)
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
  const trpc = useStoreSelector((s) => s.trpc)
  const {
    state: activationState,
    setupInProgress,
    navigate: navigateActivation,
    reconcile: reconcileActivation,
    clear: clearActivation,
  } = useActivationRoute()
  const vpsActivation = useConfirmedVpsActivation(trpc)
  const hasActivationCheckpoint = hasActivationState(window.location.search)
  const shouldContinueRemoteActivation =
    vpsActivation.ready &&
    shouldStartRemoteClientAtProjects({
      launchMode: nativeDesktopBridge()?.launchMode,
      loaded: reposLoaded,
      repoCount: repos.length,
      sessionCount: sessions.length,
      route: activationState.route,
      hasActivationCheckpoint,
      hasVpsCheckpoint: vpsActivation.state !== null,
    })
  const activationEligible = isActivationEligible({
    loaded: reposLoaded,
    repoCount: repos.length,
    sessionCount: sessions.length,
    setupInProgress,
    hasActivationCheckpoint,
    hasVpsCheckpoint: vpsActivation.state !== null,
  })
  // Setup owns the window outright (POD-1174). There is no exploring mode and no
  // other view to be in: while this is true the shell below simply does not
  // render, so nothing else can be reached until setup finishes.
  const activationVisible = activationEligible

  // The update prompt lives above this subtree (it owns the service worker and
  // must survive the error screens), so setup cannot simply not render it. It
  // still has no business here: on a phone its card covers a whole choice, and
  // it offers to update machines to someone who has not chosen a machine yet.
  useEffect(() => {
    if (!activationVisible) return
    const root = document.documentElement
    root.dataset.setupOnly = 'true'
    return () => {
      delete root.dataset.setupOnly
    }
  }, [activationVisible])

  // Handing the window back is the one moment the shell appears out of nothing.
  // Fade the command bar's contents in over that hand-off instead of snapping a
  // full instrument panel onto a screen that held one sentence a moment ago.
  const [revealingChrome, setRevealingChrome] = useState(false)
  const wasActivating = useRef(false)
  useEffect(() => {
    if (activationVisible) {
      wasActivating.current = true
      return
    }
    if (!wasActivating.current) return
    wasActivating.current = false
    setRevealingChrome(true)
    const timer = setTimeout(() => setRevealingChrome(false), 1_200)
    return () => clearTimeout(timer)
  }, [activationVisible])

  useEffect(() => {
    if (shouldContinueRemoteActivation) reconcileActivation('local-project')
  }, [reconcileActivation, shouldContinueRemoteActivation])

  // A durable setup checkpoint may arrive after the URL; reconstruct the route it names.
  useEffect(() => {
    if (
      activationEligible &&
      vpsActivation.ready &&
      vpsActivation.state &&
      activationState.route !== vpsActivation.state.route
    ) {
      reconcileActivation(vpsActivation.state.route)
    }
  }, [
    activationEligible,
    activationState.route,
    reconcileActivation,
    vpsActivation.ready,
    vpsActivation.state,
  ])

  const enterVpsActivation = async (): Promise<void> => {
    // A fresh install needs the topology explanation before Podium starts minting
    // credentials or waiting for another machine. Pairing follows from this overview.
    // Back from the install screen returns to the question that led here.
    const next = vpsIntroState('vps-choice')
    await vpsActivation.persist(next)
    navigateActivation(next.route)
  }

  const completeActivation = (): void => {
    clearActivation()
    if (vpsActivation.state) void vpsActivation.clear().catch(() => {})
    setSelectedIssueId(null)
    setView('workspace')
  }
  // SUBSCRIBED, not seeded — the same bug as the two below, on the worklist
  // column (POD-540 handoff patch 1c). `sidebar.collapsed` is per-user
  // REPLICATED, so a `useState` initializer read it before the replica had the
  // row and never ran again: a collapsed sidebar came back expanded on every
  // reload. Its WIDTH survived, which is what made the asymmetry legible —
  // that key is device-local and already in the cache at mount.
  const [sidebarCollapsed, setSidebarCollapsed] = usePersistedUiState(
    SIDEBAR_COLLAPSED_KEY,
    readBooleanState,
    String,
  )
  // SUBSCRIBED, not seeded into local state. This key is per-user REPLICATED
  // layout, and a `useState` initializer reads it on the first render — before
  // the replica has the row — then never runs again, so a stored "folded" is
  // read as null and the column boots open forever after. Device-local keys do
  // not have this problem (they are in the local cache at mount), which is why
  // the column's WIDTH persisted while its mode did not. Goes through the one
  // shared subscribe hook every replicated key now uses.
  const flightDeckCollapsed = usePersistedUiValue(SUPERAGENT_MODE_KEY, readFlightDeckCollapsed)
  const reduceMotion = useReducedMotion()
  const flightDeckShellRef = useRef<HTMLDivElement>(null)
  const flightDeckOpenWidth = useRef(0)
  const flightDeckAnimation = useRef<Animation | null>(null)
  const [flightDeckWidth, setFlightDeckWidth] = useState<number | null>(null)
  useEffect(() => () => flightDeckAnimation.current?.cancel(), [])
  // SUBSCRIBED, not seeded — same reason as `flightDeckCollapsed` above: this
  // key is per-user REPLICATED, so a `useState` initializer reads it before the
  // replica has the row and never runs again. That is why opening the
  // Superagent, reloading, and finding the dock closed was reproducible
  // (POD-540 handoff patch 1e).
  const [rightPanel, setRightPanelStored] = usePersistedUiState<RightPanelTab | null>(
    RIGHT_PANEL_KEY,
    readRightPanel,
    writeRightPanel,
  )
  const commandPaletteEnabled = useFeature('command-palette')
  const gitPanelEnabled = useFeature('git-panel')
  const messagesPanelEnabled = useFeature('messages-panel')
  const mergeQueueEnabled = useFeature('merge-queue')
  const shippingEnabled = useFeature('shipping')
  const panelAllowed = (panel: RightPanelTab | null): boolean =>
    rightPanelAllowed(panel, {
      git: gitPanelEnabled,
      messages: messagesPanelEnabled,
      mergeQueue: mergeQueueEnabled,
      shipping: shippingEnabled,
    })
  const visibleRightPanel = panelAllowed(rightPanel) ? rightPanel : null
  // What the dock RENDERS, which outlives what the rail says is open: the panel
  // has to still be there to slide back out under the rail. The column tells us
  // when that exit is over, so the closed dock holds no live panel (POD-769).
  const [dockPanel, setDockPanel] = useState<RightPanelTab | null>(visibleRightPanel)
  useEffect(() => {
    if (visibleRightPanel) setDockPanel(visibleRightPanel)
  }, [visibleRightPanel])

  const setFlightDeckCollapsed = (collapsed: boolean): void => {
    uiState.set(SUPERAGENT_MODE_KEY, collapsed ? 'folded' : 'open')
  }
  const persistedFlightDeckWidth = (): number => {
    const stored = Number(uiState.get('podium:superagent:width'))
    return Number.isFinite(stored) && stored >= 300 && stored <= 620 ? stored : 366
  }
  const animateFlightDeckWidth = (from: number, to: number, onFinish?: () => void): void => {
    const shell = flightDeckShellRef.current
    if (!shell) {
      onFinish?.()
      return
    }
    flightDeckAnimation.current?.cancel()
    const animation = shell.animate([{ width: `${from}px` }, { width: `${to}px` }], {
      duration: 280,
      easing: 'cubic-bezier(0.22, 1, 0.36, 1)',
      fill: 'both',
    })
    flightDeckAnimation.current = animation
    animation.onfinish = () => {
      animation.cancel()
      if (flightDeckAnimation.current === animation) flightDeckAnimation.current = null
      onFinish?.()
    }
  }
  const collapseFlightDeck = (): void => {
    const measured = Math.round(
      flightDeckShellRef.current?.getBoundingClientRect().width ?? persistedFlightDeckWidth(),
    )
    flightDeckOpenWidth.current = measured
    if (reduceMotion) {
      flightDeckAnimation.current?.cancel()
      flightDeckAnimation.current = null
      setFlightDeckWidth(44)
      setFlightDeckCollapsed(true)
      return
    }

    // Commit the child swap before this event can paint, then let WAAPI hold
    // the measured starting width over React's 44px end state. The wrapper is
    // persistent, so the same DOM node carries the whole transition.
    flushSync(() => {
      setFlightDeckCollapsed(true)
      setFlightDeckWidth(44)
    })
    animateFlightDeckWidth(measured, 44)
  }
  const expandFlightDeck = (): void => {
    if (reduceMotion) {
      flightDeckAnimation.current?.cancel()
      flightDeckAnimation.current = null
      setFlightDeckCollapsed(false)
      setFlightDeckWidth(null)
      return
    }
    const target = flightDeckOpenWidth.current || persistedFlightDeckWidth()
    flushSync(() => {
      setFlightDeckCollapsed(false)
      setFlightDeckWidth(target)
    })
    animateFlightDeckWidth(44, target, () => setFlightDeckWidth(null))
  }
  const setRightPanel = (panel: RightPanelTab | null): void => {
    if (!panelAllowed(panel)) return
    setRightPanelStored(panel)
    setSuperOpen(panel === 'superagent')
  }
  const lastRightPanel = useRef<RightPanelTab>('issue')
  if (visibleRightPanel) lastRightPanel.current = visibleRightPanel
  const toggleLeftSidebar = (): void => setSidebarCollapsed(!sidebarCollapsed)
  const toggleFlightDeck = (): void => {
    if (flightDeckCollapsed) expandFlightDeck()
    else collapseFlightDeck()
  }
  const toggleRightSidebar = (): void => {
    if (visibleRightPanel) setRightPanel(null)
    else setRightPanel(lastRightPanel.current)
  }

  // Existing concierge/palette surfaces still drive `superOpen`. Its visual
  // destination is now the right dock instead of a separate center column, so
  // the shell mirrors the store into the dock panel — but only on CHANGES.
  // Reacting to the initial value would slam a persisted `superagent` panel
  // shut on every load, because the store boots with superOpen=false.
  const lastSuperOpen = useRef(superOpen)
  // biome-ignore lint/correctness/useExhaustiveDependencies: mount-only — seed the store from the persisted panel.
  useEffect(() => {
    if (rightPanel === 'superagent') setSuperOpen(true)
  }, [])
  useEffect(() => {
    if (superOpen === lastSuperOpen.current) return
    lastSuperOpen.current = superOpen
    if (superOpen) {
      setRightPanelStored('superagent')
      return
    }
    // superOpen going false only CLOSES the Superagent. Clearing the panel
    // unconditionally would fight `setRightPanel`, which drives superOpen false
    // whenever you pick a different panel: the click that opened Task would set
    // superOpen false, and this effect would then close Task right back again.
    if (rightPanel !== 'superagent') return
    setRightPanelStored(null)
  }, [superOpen, rightPanel, setRightPanelStored])

  // Deep surfaces (the pane header's git stamp [POD-98]) ask for a dock panel
  // via a window event — the panel state is AppShell-local. A request for a
  // feature-gated panel falls back to the Task panel (its Git section is the
  // next-best detail view).
  useEffect(() => {
    const onOpenPanel = (event: Event): void => {
      const detail = (event as CustomEvent).detail
      if (detail === CLOSE_RIGHT_PANEL) {
        setRightPanel(null)
        return
      }
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

  const menuHost = (
    <DesktopMenuHost
      openSettings={() => setView('settings')}
      toggleLeftSidebar={toggleLeftSidebar}
      toggleFlightDeck={toggleFlightDeck}
      toggleRightSidebar={toggleRightSidebar}
    />
  )

  // THE FIRST-SYNC GATE (POD-1249). `reposLoaded` alone is the wrong condition
  // on a cold replica: it flips when the discovery tRPC call answers, which is
  // unrelated to the feed bootstrap — the old gate dropped the loader while the
  // whole world was still downloading and left a fully-chromed empty shell. A
  // cold launch therefore also waits for the bootstrap to INSTALL, and shows the
  // detailed sync screen instead of the splash; warm launches keep the splash
  // for the enrichment beat exactly as before.
  const firstSyncPending = sync.firstSync && sync.phase !== 'ready'
  if (!reposLoaded || firstSyncPending) {
    return (
      <>
        {menuHost}
        {sync.firstSync ? (
          <SyncLoader
            store={syncProgress}
            reposLoaded={reposLoaded}
            repoCount={repos.length}
            worktreeCount={repos.reduce((n, repo) => n + repo.worktrees.length, 0)}
          />
        ) : (
          <LoadingScreen />
        )}
      </>
    )
  }

  // SETUP OWNS THE WINDOW (POD-1174). No work sidebar, Flight Deck, dock, rail
  // or status strip, and a command bar with nothing in it but its drag region
  // and the platform window buttons. Every instrument in this shell reports on
  // work that cannot exist yet, and the one escape hatch we did offer landed
  // people in an empty product they reasonably read as broken.
  if (activationVisible) {
    return (
      <>
        {menuHost}
        <div className="desktop-shell" data-setup-only="true">
          <TopBar chromeless />
          <div className="desktop-shell-row">
            <Suspense fallback={<RouteFallback />}>
              <OnboardingWizard
                route={activationState.route}
                onRouteChange={navigateActivation}
                onComplete={completeActivation}
                onConnectionConfigured={async () => {
                  // The saved topology survives a restart; the old setup URL must not.
                  // Retire it synchronously before Tauri or reload can terminate this page.
                  clearActivation()
                  return restartPodiumShell()
                }}
                onEnterVps={enterVpsActivation}
                trpc={trpc}
                vps={vpsActivation}
              />
            </Suspense>
          </div>
        </div>
      </>
    )
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
  const issueAccent = effectiveHex ?? FLOW_CSS
  const issueStyle = { '--issue': issueAccent } as CSSProperties

  return (
    <OperatorFocusProvider missionId={selectedIssueId}>
      {/* The issue explorer's stack lives ABOVE the dock (POD-743): the panel
          unmounts when the dock closes, and closing it must cost the operator
          nothing — reopen and the same task, trail, tab and query are there.
          It also keeps tracking the shell's target while closed. */}
      <IssueExplorerProvider>
        {menuHost}
        <DockShellLifecycle />
        <div
          className="desktop-shell issue-scope"
          data-issue-colored={effectiveHex ? 'true' : 'false'}
          style={issueStyle}
        >
          <TopBar revealing={revealingChrome} />
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
                  {/* 15px, not 13: the control is the column's whole header
                      band now (POD-1178), and a 13px glyph read as a speck
                      parked in the middle of it. */}
                  <ChevronRight size={15} aria-hidden="true" />
                </button>
                <SidebarRail />
              </aside>
            ) : (
              <div className="relative z-10 flex min-w-0 flex-[0_1_auto]">
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
            {workspaceActive && (
              <div
                ref={flightDeckShellRef}
                className="flex min-h-0 min-w-0 flex-[0_1_auto] overflow-hidden"
                data-flight-deck-shell={flightDeckCollapsed ? 'folded' : 'open'}
                style={{ width: flightDeckWidth ?? (flightDeckCollapsed ? 44 : undefined) }}
              >
                {flightDeckCollapsed ? (
                  <FoldedFlightDeckBar onExpand={expandFlightDeck} />
                ) : (
                  <ResizableColumn
                    storageKey="podium:superagent:width"
                    min={300}
                    max={620}
                    defaultWidth={366}
                    handleLabel="Resize Flight Deck"
                    className="max-w-[45vw]"
                  >
                    <Suspense fallback={<RouteFallback />}>
                      <FlightDeck onCollapse={collapseFlightDeck} />
                    </Suspense>
                  </ResizableColumn>
                )}
              </div>
            )}
            <MainViewOutlet workspace={<Workspace />} view={baseView} />
            {workspaceActive && (
              <ResizableColumn
                storageKey="podium:rightdock:width"
                min={280}
                max={860}
                defaultWidth={316}
                handleLabel="Resize right dock"
                handleSide="left"
                collapsed={!visibleRightPanel}
                onCollapsed={() => setDockPanel(null)}
                className="max-w-[45vw]"
              >
                {/* No issue tint: the dock is a dark default surface (POD-516
                  item 9) — see `.right-dock-shell` in styles.css. */}
                {dockPanel && (
                  <aside className="right-dock-shell">
                    <RightDock tab={dockPanel} onClose={() => setRightPanel(null)} />
                  </aside>
                )}
              </ResizableColumn>
            )}
            {workspaceActive && (
              <RightRail rightPanel={visibleRightPanel} onPanelChange={setRightPanel} />
            )}
          </div>
          <StatusStrip />
        </div>
        {/* The utility tier (POD-365): an inset sheet over a live shell. The mode
          underneath stays mounted, so closing is instant and the chrome never
          blinks out of existence. */}
        {view === 'settings' && (
          <Suspense
            fallback={
              <SheetFallback
                label="Settings"
                title="Settings"
                className="app-sheet-settings app-sheet-fit"
                onClose={closeOverlay}
              />
            }
          >
            <SettingsView onClose={closeOverlay} />
          </Suspense>
        )}
        {view === 'usage' && (
          <Suspense
            fallback={
              <SheetFallback
                label="Usage & analytics"
                title="Usage & analytics"
                className="app-sheet-fit"
                onClose={closeOverlay}
              />
            }
          >
            <UsageView onClose={closeOverlay} />
          </Suspense>
        )}
        <Suspense fallback={null}>
          <AutoContinueDialog />
          <ApprovalDialog />
        </Suspense>
        {commandPaletteEnabled && <CommandPaletteBoundary />}
        {/* Ref linkify (#474): keep the known-prefix set fresh and host the single
          floating miniview. Both render nothing until there's something to show. */}
        <RefPrefixSync />
        <RefMiniviewHost />
      </IssueExplorerProvider>
    </OperatorFocusProvider>
  )
}
