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
 */
import type { JSX, ReactNode } from 'react'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { useRegisterSW } from '@/app/pwa-register'
import { serverConfig } from '@/app/trpc'
import { registerUpdatePanelOpener } from './open-panel'
import { DONE_COLLAPSE_MS } from './operation-view'
import { UpdatePanel } from './UpdatePanel'
import { UpdatesContext, type UpdatesContextValue } from './updates-panel-context'
import { type PanelActionKind, useUpdateState } from './use-update-state'

const UPDATE_CHECK_MS = 60_000

export interface UpdatesProviderProps {
  httpOrigin?: string
  children?: ReactNode
}

export function UpdatesProvider({ httpOrigin, children }: UpdatesProviderProps): JSX.Element {
  const [registration, setRegistration] = useState<ServiceWorkerRegistration | null>(null)
  const {
    needRefresh: [needRefresh, setNeedRefresh],
    updateServiceWorker,
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
   * first, then reload on controllerchange; the timeout is still needed for a
   * normal browser tab the new worker never claims.
   */
  const reload = useCallback(() => {
    navigator.serviceWorker?.addEventListener('controllerchange', () => window.location.reload(), {
      once: true,
    })
    void updateServiceWorker(true)
    window.setTimeout(() => window.location.reload(), 2_000)
  }, [updateServiceWorker])

  const resolvedOrigin = httpOrigin ?? serverConfig(window.location).httpOrigin
  const { view, pending, run, checkNow, acknowledge } = useUpdateState({
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
  const situation = `${view.state}:${view.operationId ?? view.version ?? ''}`
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

  const open = view.state !== 'none' && !collapsed

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
      void run(kind)
    },
    [run],
  )

  const value = useMemo<UpdatesContextValue>(
    () => ({
      indicator: view.indicator,
      indicatorLabel: view.indicatorLabel,
      open,
      toggle,
      show,
      checkNow: onCheckNow,
    }),
    [onCheckNow, open, show, toggle, view.indicator, view.indicatorLabel],
  )

  return (
    <UpdatesContext.Provider value={value}>
      {open && <UpdatePanel view={view} pending={pending} onAction={onAction} onHide={hide} />}
      {children}
    </UpdatesContext.Provider>
  )
}
