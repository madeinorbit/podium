import { shallowEqual } from '@podium/client-core/store'
import { selectedMissionRoot } from '@podium/client-core/viewmodels'
import { ChevronLeft } from 'lucide-react'
import type { CSSProperties, JSX, ReactNode } from 'react'
import { lazy, Suspense, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { flushSync } from 'react-dom'
import { toast } from 'sonner'
import { Toaster } from '@/components/ui/sonner'
import { TooltipProvider } from '@/components/ui/tooltip'
import { WaitingForServer } from '@/components/WaitingForServer'
import { IssueExplorerProvider } from '@/features/issues/explorer/explorer-context'
import {
  hasActivationState,
  isActivationEligible,
  shouldStartRemoteClientAtHandoff,
} from '@/features/setup/activation-route'
import { restartPodiumShell } from '@/features/setup/restart-shell'
import { SetupGate } from '@/features/setup/SetupGate'
import { useActivationRoute } from '@/features/setup/use-activation-route'
import { useConfirmedVpsActivation } from '@/features/setup/use-vps-activation'
import { checkServedAssets, recoverFromWireSkew } from '@/features/setup/version-guard'
import { vpsIntroState } from '@/features/setup/vps-activation'
import { loadAgentPanel } from '@/features/terminal/AgentPanelLazy'
import { DockShellLifecycle } from '@/features/terminal/dock-shell-lifecycle'
import { UpdatesProvider } from '@/features/updates/updates-context'
import { CollapsedSidebar } from '@/features/worklist/CollapsedSidebar'
import { SidebarUnified } from '@/features/worklist/SidebarUnified'
import {
  COLUMN_FOLD_EASE,
  COLUMN_FOLD_MS,
  ResizableAside,
  ResizableColumn,
  SIDEBAR_RAIL_WIDTH,
  SIDEBAR_WIDTH_DEFAULT,
  SIDEBAR_WIDTH_KEY,
  SIDEBAR_WIDTH_MAX,
  SIDEBAR_WIDTH_MIN,
} from '@/features/worklist/sidebar-common'
import { useColumnFold } from '@/features/worklist/use-column-fold'
import { throughRestarts } from '@/lib/chunk-recovery'
import { ConfirmProvider } from '@/lib/hooks/use-confirm'
import { effectiveIssueColorHex, FLOW_CSS } from '@/lib/issueColors'
import type { KernelAssembly } from '@/lib/kernelReplica'
import { nativeDesktopBridge } from '@/lib/nativeDesktop'
import { onReconnect } from '@/lib/on-reconnect'
import { prefetchAfterFirstPaint } from '@/lib/prefetch-after-first-paint'
import type { SyncProgressStore } from '@/lib/sync-progress'
import { useFeature } from '@/lib/use-feature'
import { useFileDropGuard } from '@/lib/use-file-drop-guard'
import { type AuthBootstrap, useKernelReplica } from '@/lib/use-kernel-replica'
import { usePersistedUiState, usePersistedUiValue } from '@/lib/use-persisted-ui-state'
import { useReducedMotion } from '@/lib/use-reduced-motion'
import { AppErrorPage } from './AppErrorPage'
import { AppSheet } from './AppSheet'
import { BrowserOpenOverlay } from './BrowserOpenOverlay'
import { CommandPaletteBoundary } from './CommandPaletteBoundary'
import { DesktopMenuHost } from './DesktopMenuHost'
import { DensityProvider } from './density'
import { ErrorBoundary } from './ErrorBoundary'
import { FoldedFlightDeckBar } from './FoldedFlightDeckBar'
import { LoadingScreen } from './LoadingScreen'
import { OperatorFocusProvider } from './operator-focus'
import { ReplicaFailureScreen } from './ReplicaFailureScreen'
import { RightDock } from './RightDock'
import { RightRail } from './RightRail'
import { MainViewOutlet } from './routes'
import { StatusStrip } from './StatusStrip'
import { SyncLoader } from './SyncLoader'
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

/**
 * EVERY LAZY SURFACE GOES THROUGH `throughRestarts` (POD-2762).
 *
 * The incident was Settings, and nothing about it was about Settings: any chunk
 * fetched after first paint can be asked for during the seconds a server is
 * handing over, and every one of them took the interface down when it was. So
 * the wrapper goes on all of them rather than on the one that happened to be
 * clicked, and it is deliberately shaped to leave these declarations reading
 * the way they always did.
 */
// The app lands on the work list. Loading Workspace here used to pull the chat,
// terminal and editor stack into first paint before a workspace was selected.
const Workspace = lazy(() =>
  throughRestarts(() => import('./Workspace')).then((module) => ({ default: module.Workspace })),
)
const SettingsView = lazy(() =>
  throughRestarts(() => import('@/features/settings/SettingsView')).then((module) => ({
    default: module.SettingsView,
  })),
)
const UsageView = lazy(() =>
  throughRestarts(() => import('@/features/usage/UsageView')).then((module) => ({
    default: module.UsageView,
  })),
)
// FlightDeck already unmounts when folded. Deferring its module in exactly that
// state changes no subscriptions or retained component state.
const FlightDeck = lazy(() =>
  throughRestarts(() => import('./FlightDeck')).then((module) => ({ default: module.FlightDeck })),
)
const OnboardingWizard = lazy(() =>
  throughRestarts(() => import('@/features/setup/OnboardingWizard')).then((module) => ({
    default: module.OnboardingWizard,
  })),
)
const ApprovalDialog = lazy(() =>
  throughRestarts(() => import('./ApprovalDialog')).then((module) => ({
    default: module.ApprovalDialog,
  })),
)
const AutoContinueDialog = lazy(() =>
  throughRestarts(() => import('./AutoContinueDialog')).then((module) => ({
    default: module.AutoContinueDialog,
  })),
)
/**
 * THE HOVER PREVIEW IS A GESTURE SURFACE, and it was the eager graph's single
 * largest leaf that no first paint can reach (POD-2730).
 *
 * `RefMiniviewHost` renders `null` until a ref is hovered — its own call site
 * below says so — and `RefPrefixSync` renders `null` always. Neither can put a
 * pixel on the first frame. Between them they were dragging 134,542 bytes of
 * eager source in, and only 34,904 of that is this app's code: the card mounts
 * a `<Select>`, and `@base-ui/react`'s select is 27 modules and ~90 KB that
 * nothing else on the first paint uses.
 *
 * Deferred the way every other gesture surface here is (see
 * INTERACTION_ONLY_MODULES in scripts/web-bundle-budget.ts, which now fails the
 * build by name if this comes back eager). The first hover pays one chunk
 * fetch; `prefetchAfterFirstPaint` below spends the idle time after the shell
 * mounts so that in practice it has already arrived.
 */
const RefMiniviewHost = lazy(() =>
  throughRestarts(() => import('@/components/RefMiniview')).then((module) => ({
    default: module.RefMiniviewHost,
  })),
)
const RefPrefixSync = lazy(() =>
  throughRestarts(() => import('@/components/RefMiniview')).then((module) => ({
    default: module.RefPrefixSync,
  })),
)
function RouteFallback(): JSX.Element {
  return <WaitingForServer className="flex min-h-0 min-w-0 flex-1" />
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
      {/* The sheet chrome is already up, so this is the one place the operator
          is looking when a restart eats the chunk behind it (POD-2762). */}
      <WaitingForServer className="flex min-h-0 flex-1" />
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
  /**
   * THE MOMENT THE ASSETS CAN HAVE MOVED (POD-2721).
   *
   * A server cannot swap the website it serves without going away and coming
   * back, so a socket that dropped and reconnected is the exact — and only —
   * instant worth re-asking "am I still the app you are serving?". That makes
   * this free: no polling, no timer, one `/version` read per genuine outage.
   *
   * It is also the answer to the awkward part of this problem, which is that a
   * page cannot ask the server what to do when the server it was talking to has
   * just been replaced. It does not have to. It only has to notice that what it
   * reconnected TO is not what it was loaded FROM, and the reconnect is where
   * that becomes askable again.
   *
   * The "down and back, never merely `ok`" rule is the subtle half, so it lives
   * in `onReconnect` where it is tested against the sequence the sandbox
   * actually logged — a socket that closed and was back inside two seconds.
   */
  useEffect(
    () =>
      onReconnect(hub.onConnectionHealth.bind(hub), () => {
        void checkServedAssets(httpOrigin)
      }),
    [hub, httpOrigin],
  )
  return null
}

export function AppShell({ auth }: { auth: AuthBootstrap }): JSX.Element {
  // Whole-window, and mounted at the top so it also covers the boot and error
  // screens — a drag released over a loading app would navigate it away too.
  useFileDropGuard()
  const [config] = useState(() => serverConfig(window.location))
  const [appError, setAppError] = useState<string | null>(null)
  // One tRPC client for the gate, memoized on the origin so the gate's effect
  // does not re-run (and re-open IndexedDB) on every render.
  const [gateTrpc] = useState(() => makeTrpc(config.httpOrigin))
  const kernel = useKernelReplica({
    trpc: gateTrpc,
    auth,
    httpOrigin: config.httpOrigin,
  })

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
  let shell: JSX.Element
  if (kernel.status === 'resolving') {
    shell = (
      <TooltipProvider>
        <LoadingScreen />
      </TooltipProvider>
    )
  } else if (kernel.status === 'failed') {
    // Not one screen: the gate's failure is a category, and a browser with no
    // session gets the sign-in screen rather than an error about a replica it was
    // never going to be allowed to open (POD-1304).
    shell = (
      <TooltipProvider>
        <ReplicaFailureScreen
          cause={kernel.cause}
          detail={kernel.failure}
          httpOrigin={config.httpOrigin}
        />
      </TooltipProvider>
    )
  } else {
    shell = (
      <TooltipProvider>
        {/* The update surface wraps the whole shell (POD-2102): its panel renders
          here in the corner, and its indicator renders far below in the status
          strip. One provider so the two are the same state, never two pictures
          of one update. */}
        <UpdatesProvider httpOrigin={config.httpOrigin}>
          {appError ? (
            <AppErrorPage
              title={'Podium lost its\nline to the server.'}
              eyebrow="Connection / dropped"
              message="Your board is open on the host and your agents are still running there; this window just cannot reach it. The exact fault is below."
              detail={appError}
              trace={{ from: 'this browser', to: 'server' }}
              fields={[{ label: 'Server', value: config.httpOrigin }]}
              retryLabel="Reconnect"
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

  // Setup/version and the private replica both depend on auth, but not on each
  // other. Mount the setup gate beside the replica effect and keep the shell
  // itself behind the setup decision. An unreachable auth bootstrap is also
  // recovered inside the replica effect, so that check stays parallel too.
  return <SetupGate>{shell}</SetupGate>
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
  const flightDeckMissionId = selectedMissionRoot(issues, sessions, selectedIssueId)?.id ?? 'empty'
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
    shouldStartRemoteClientAtHandoff({
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
    if (shouldContinueRemoteActivation) reconcileActivation('server-connected')
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
      // The left column's curve, since POD-1672 gave the shell's folds one that
      // is not the drawer's (`COLUMN_FOLD_EASE`). Two columns of one shell decelerating
      // differently is how a window stops feeling like a single object.
      duration: COLUMN_FOLD_MS,
      easing: COLUMN_FOLD_EASE,
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

  // THE LEFT FOLD (POD-1584). The work list and the identity rail are separate
  // subtrees, so flipping `sidebarCollapsed` swapped one for the other in a
  // single frame and ~250px of window arrived or vanished with no gesture
  // attached to it. Every other column in this shell folds; the left one — the
  // one an operator opens and shuts most — read as a glitch.
  //
  // The mechanics are the flight deck's above, lifted into a hook so the
  // gesture has somewhere to be tested and the harness can drive the shipping
  // code rather than a copy of it. See `use-column-fold.ts`.
  const persistedSidebarWidth = (): number => {
    const stored = Number(uiState.get(SIDEBAR_WIDTH_KEY))
    return Number.isFinite(stored) && stored >= SIDEBAR_WIDTH_MIN && stored <= SIDEBAR_WIDTH_MAX
      ? stored
      : SIDEBAR_WIDTH_DEFAULT
  }
  const sidebarFold = useColumnFold({
    foldedWidth: SIDEBAR_RAIL_WIDTH,
    openWidth: persistedSidebarWidth,
    onFold: setSidebarCollapsed,
  })
  const setRightPanel = (panel: RightPanelTab | null): void => {
    if (!panelAllowed(panel)) return
    setRightPanelStored(panel)
    setSuperOpen(panel === 'superagent')
  }
  const lastRightPanel = useRef<RightPanelTab>('issue')
  if (visibleRightPanel) lastRightPanel.current = visibleRightPanel
  const toggleLeftSidebar = (): void => sidebarFold.fold(!sidebarCollapsed)
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
  /**
   * The surfaces POD-2730 moved out of the eager graph that the operator is
   * LIKELY to reach, warmed on the first idle after the shell paints. Deferring
   * them is about what the browser must parse before it can render; it is not an
   * argument for making the operator wait for a chunk later. See
   * prefetchAfterFirstPaint.
   *
   * SETTINGS JOINED THEM ON DIFFERENT GROUNDS (POD-2762). The other two are
   * warmed because a hitch would be felt; this one is warmed because of WHEN it
   * is reached. Settings is where a person goes to look at an update — which is
   * to say, the surface most likely to be opened during the exact seconds its
   * chunk cannot be fetched. Warming it moves that fetch into the quiet minutes
   * beforehand.
   *
   * It is a COMPLEMENT AND NOT A SUBSTITUTE, and the distinction is the reason
   * this is only one line of this issue: it narrows the window, it does not
   * close it. A tab opened mid-handover never gets a quiet minute, and every
   * other lazy surface still has the same exposure. `throughRestarts` is what
   * addresses the class; this just makes the common case commoner.
   */
  useEffect(() => {
    const cancels = [
      prefetchAfterFirstPaint(loadAgentPanel),
      prefetchAfterFirstPaint(() => import('@/components/RefMiniview')),
      prefetchAfterFirstPaint(() => import('@/features/settings/SettingsView')),
    ]
    return () => {
      for (const cancel of cancels) cancel()
    }
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
            {/* THE OPEN COLUMN STAYS MOUNTED FOR THE WHOLE FOLD, both ways
                (POD-1584). Swapping the rail in on the press instead would
                leave a 58px rail sitting in a wrapper still 300px wide, with a
                quarter of the window's worth of empty ground closing beside it
                — the fold has to CLIP a column, not slide a gap shut. Clipping
                this one ends the collapse on its leftmost 58px, which is the
                identity-tile gutter the rail already is, so the cut at the end
                lands on matching pixels. */}
            <div
              ref={sidebarFold.ref}
              className="sidebar-shell"
              data-sidebar-shell={sidebarCollapsed ? 'folded' : 'open'}
              data-sidebar-folding={sidebarFold.folding ? 'true' : undefined}
              style={{ width: sidebarFold.width ?? undefined }}
            >
              {sidebarCollapsed && !sidebarFold.folding ? (
                <CollapsedSidebar onExpand={() => sidebarFold.fold(false)} />
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
                    onClick={() => sidebarFold.fold(true)}
                  >
                    <ChevronLeft size={12} aria-hidden="true" />
                  </button>
                </div>
              )}
              {/* THE GHOST OF THE FOLDED COLUMN (POD-1658). Rendered only while
                  the fold runs, pinned over the clip, and dissolved in or out by
                  the hook. It is what the swap at the end of the gesture happens
                  UNDERNEATH: by then this is already an opaque rail sitting on
                  the pixels the real one is about to occupy, so the frame where
                  the work list becomes the rail has nothing visible in it. Inert
                  and aria-hidden — there are briefly two rails in the tree and
                  only one of them is the column. */}
              {sidebarFold.folding && (
                <div ref={sidebarFold.ghostRef} className="sidebar-fold-ghost" aria-hidden="true">
                  {/* The lid and what is on it are two layers (POD-1672). The
                      ghost holds still and carries the opacity and the blur —
                      it is what covers the clip, and a cover that moves is a
                      gap. This node carries the slide that makes the rail
                      ARRIVE instead of appear. */}
                  <div ref={sidebarFold.ghostContentRef} className="sidebar-fold-ghost-inner">
                    <CollapsedSidebar />
                  </div>
                </div>
              )}
            </div>
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
                      {/* The arrival latch and the scrolling node both belong
                          to one mission; carrying either into the next one
                          turns its existing sessions into late arrivals. */}
                      <FlightDeck key={flightDeckMissionId} onCollapse={collapseFlightDeck} />
                    </Suspense>
                  </ResizableColumn>
                )}
              </div>
            )}
            <MainViewOutlet
              workspace={
                <Suspense fallback={<RouteFallback />}>
                  <Workspace />
                </Suspense>
              }
              view={baseView}
            />
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
          floating miniview. Both render nothing until there's something to show —
          which is why both are lazy (POD-2730). `fallback={null}` is the same
          nothing they render once loaded, so the boundary is invisible. */}
        <Suspense fallback={null}>
          <RefPrefixSync />
          <RefMiniviewHost />
        </Suspense>
      </IssueExplorerProvider>
    </OperatorFocusProvider>
  )
}
