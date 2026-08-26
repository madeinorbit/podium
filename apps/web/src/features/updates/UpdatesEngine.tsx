/**
 * THE UPDATE SURFACE'S ONE OWNER (POD-2102).
 *
 * The panel lives in the bottom-right corner and the indicator lives in the
 * status strip at the bottom edge — two very different places in the tree, one
 * state. That state is here: what the server says (`useUpdateState`), whether
 * the panel is expanded, and the action dispatcher both of them share.
 *
 * COLLAPSE IS PER-TAB UI STATE and is deliberately not persisted. Losing it on
 * reload is fine — the indicator comes back from server truth on the next poll,
 * so nothing about an update can be lost by hiding it (§6.1). That is the whole
 * difference from `dismissed`-as-component-state, which lost the update itself.
 *
 * WHY THIS IS A SEPARATE MODULE FROM `updates-context.tsx` (POD-2190). Everything
 * below — the view model, the poller, the renderer — is 99 KB of source that is
 * useless until a poll has come back saying there is something to show, and a
 * poll cannot come back before the app has painted. It was nevertheless in the
 * EAGER graph, because the provider that mounts it is mounted by the app shell,
 * and that is what put the web bundle over its size budget. So the provider is
 * now a loader for this file, and this file arrives a beat after first paint.
 *
 * It is still fetched IMMEDIATELY on mount, not on demand, and that distinction
 * is the safety property. Waiting for a user to click would mean fetching a
 * hashed chunk at the exact moment an update is replacing the dist that serves
 * it — a 404 precisely when the update needs a UI. Fetching at mount puts the
 * request in the same window as every other boot request, long before any update
 * can be offered.
 */
import type { JSX } from 'react'
import { useCallback, useEffect, useLayoutEffect, useMemo, useState } from 'react'
import { useRegisterSW } from '@/app/pwa-register'
import { serverConfig } from '@/app/trpc'
import { registerUpdatePanelOpener } from './open-panel'
import { DONE_COLLAPSE_MS } from './operation-view'
import { ReleaseProposalCard } from './ReleaseProposalCard'
import { startReloadHandshake } from './reload-handshake'
import { UpdatePanel } from './UpdatePanel'
import { publishUpdates, resetUpdates, type UpdatesContextValue } from './updates-panel-context'
import { type PanelActionKind, useUpdateState } from './use-update-state'

const UPDATE_CHECK_MS = 60_000

export interface UpdatesEngineProps {
  httpOrigin?: string
}

export function UpdatesEngine({ httpOrigin }: UpdatesEngineProps): JSX.Element | null {
  const [registration, setRegistration] = useState<ServiceWorkerRegistration | null>(null)
  const {
    needRefresh: [needRefresh, setNeedRefresh],
  } = useRegisterSW({
    onRegisteredSW(_swUrl, next) {
      if (next) setRegistration(next)
    },
  })

  useEffect(() => {
    if (!registration) return
    const timer = window.setInterval(() => void registration.update(), UPDATE_CHECK_MS)
    return () => window.clearInterval(timer)
  }, [registration])

  // The decisive check for an installed PWA: the moment it returns to the
  // foreground, ask the service worker whether a new build shipped while hidden.
  useEffect(() => {
    const onVisible = (): void => {
      if (document.visibilityState === 'visible') void registration?.update()
    }
    document.addEventListener('visibilitychange', onVisible)
    return () => document.removeEventListener('visibilitychange', onVisible)
  }, [registration])

  /**
   * Reloading is a STEP THE USER TAKES (§6.2.3), so it is the panel's primary
   * action rather than something that happens to them. Take over the new worker
   * first, then reload only once the replacement is safe to navigate through.
   * A page with no waiting worker is an ordinary refresh and reloads directly.
   *
   * The handshake logs whether takeover completed or exceeded its diagnostic
   * budget, preserving the path instrumentation introduced for POD-2762.
   */
  const reload = useCallback(async () => {
    const serviceWorker = typeof navigator === 'undefined' ? undefined : navigator.serviceWorker
    const currentRegistration = registration ?? (await serviceWorker?.getRegistration())
    startReloadHandshake({
      serviceWorker,
      waitingWorker: currentRegistration?.waiting,
      reload: () => window.location.reload(),
    })
  }, [registration])

  const resolvedOrigin = httpOrigin ?? serverConfig(window.location).httpOrigin
  const {
    view,
    pending,
    run,
    checkNow,
    acknowledge,
    proposal,
    proposalPending,
    proposalError,
    fleet,
    approveProposal,
  } = useUpdateState({
    httpOrigin: resolvedOrigin,
    needRefresh,
    reload,
  })

  /**
   * The ONLY piece of panel state, and it is per-tab UI state: has the user
   * collapsed the current situation? Everything else — whether there is
   * anything to show at all, what it says, what to press — is server truth.
   */
  const [collapsed, setCollapsed] = useState(false)

  // A NEW SITUATION UNCOLLAPSES. The user hid a running update, it then failed
  // or came to need them — that is a different question than the one they hid,
  // and it must not stay hidden behind a dot they may never look at.
  //
  // Adjusted during render rather than in an effect: React's own answer for
  // "state derived from a prop that changed", and it repaints once instead of
  // showing the collapsed panel for a frame first.
  const activeProposal = view.state === 'none' ? proposal : null
  const runningVersions = [
    ...new Set(
      (fleet.allMachines ?? fleet.machines ?? [])
        .filter(
          (machine) =>
            machine.installKind !== 'source' &&
            machine.version.length > 0 &&
            machine.version !== 'unknown',
        )
        .map((machine) => machine.version),
    ),
  ]
  const showingProposal = activeProposal != null
  const situation = activeProposal
    ? `proposal:${activeProposal.headSha}:${activeProposal.state}`
    : `${view.state}:${view.operationId ?? view.version ?? ''}`
  const [lastSituation, setLastSituation] = useState(situation)
  if (situation !== lastSituation) {
    setLastSituation(situation)
    setCollapsed(false)
  }

  // "Auto-collapses after a few seconds" (§6.2.4). The success announcement is
  // worth a moment and nothing more; the operation is in history either way.
  // Keyed on the situation so a SECOND finished update re-arms the timer.
  const doneKey = view.state === 'done' ? situation : null
  useEffect(() => {
    if (doneKey === null) return
    const timer = window.setTimeout(() => {
      setCollapsed(true)
      // "the indicator clears" (§6.2.4) — a finished update is not a standing
      // fact about the toolbar.
      acknowledge()
    }, DONE_COLLAPSE_MS)
    return () => window.clearTimeout(timer)
  }, [acknowledge, doneKey])

  const open = (view.state !== 'none' || showingProposal) && !collapsed

  const hide = useCallback(() => {
    setCollapsed(true)
    // The service worker's "a new build is ready" is a fact about THIS tab, and
    // the user has now been told. The operation keeps it alive if it matters.
    setNeedRefresh(false)
    // Hiding a terminal outcome is the user saying they have seen it, so it
    // does not come back on the next poll (or the next reload).
    if (view.state === 'failed' || view.state === 'done') acknowledge()
  }, [acknowledge, setNeedRefresh, view.state])

  const toggle = useCallback(() => setCollapsed((current) => !current), [])
  const show = useCallback(() => setCollapsed(false), [])

  // The skew banner and anything else outside this tree open the panel through
  // the module-level channel, because they are mounted where context is not.
  useEffect(() => registerUpdatePanelOpener(show), [show])

  const onCheckNow = useCallback(() => {
    setCollapsed(false)
    void checkNow()
  }, [checkNow])

  // The macOS "Check for Updates…" menu item, and anything else that wants the
  // panel: one global hook, unchanged in name so older shells keep working.
  useEffect(() => {
    const g = globalThis as { __PODIUM_CHECK_UPDATES__?: () => void }
    g.__PODIUM_CHECK_UPDATES__ = onCheckNow
    return () => {
      if (g.__PODIUM_CHECK_UPDATES__ === onCheckNow) delete g.__PODIUM_CHECK_UPDATES__
    }
  }, [onCheckNow])

  const onAction = useCallback(
    (kind: PanelActionKind) => {
      if (kind === 'check') void checkNow()
      else void run(kind)
    },
    [checkNow, run],
  )

  const surface = useMemo<UpdatesContextValue>(
    () => ({
      indicator: showingProposal
        ? activeProposal.state === 'failed'
          ? 'attention'
          : activeProposal.state === 'building'
            ? 'animating'
            : 'idle-dot'
        : view.indicator,
      indicatorLabel: showingProposal
        ? activeProposal.state === 'building'
          ? 'Development release is building'
          : activeProposal.state === 'failed'
            ? 'Development release build failed'
            : 'Development release awaits approval'
        : view.indicatorLabel,
      open,
      toggle,
      show,
      checkNow: onCheckNow,
    }),
    [
      activeProposal,
      onCheckNow,
      open,
      show,
      showingProposal,
      toggle,
      view.indicator,
      view.indicatorLabel,
    ],
  )

  /**
   * Published in a LAYOUT effect, not a passive one: the strip's cell and this
   * panel are two halves of one picture, and a passive effect would let the
   * browser paint the panel for a frame with no indicator beside it. The cost is
   * one extra pre-paint render of the strip whenever the indicator changes,
   * which is a handful of times in an update's whole life.
   */
  useLayoutEffect(() => {
    publishUpdates(surface)
  }, [surface])
  useEffect(() => resetUpdates, [])

  if (!open) return null
  if (activeProposal) {
    return (
      <ReleaseProposalCard
        proposal={activeProposal}
        pending={proposalPending}
        runningVersions={runningVersions}
        {...(proposalError ? { error: proposalError } : {})}
        onApprove={() => void approveProposal()}
        onHide={hide}
      />
    )
  }
  return <UpdatePanel view={view} pending={pending} onAction={onAction} onHide={hide} />
}
