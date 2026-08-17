import { ONBOARDING_ACTIVE_KEY } from '@podium/client-core/ui-state'
import { useCallback, useEffect, useRef, useState } from 'react'
import { usePersistedUiState } from '@/lib/use-persisted-ui-state'
import {
  activationUrl,
  DEFAULT_ACTIVATION_STATE,
  type ActivationRoute,
  type ActivationState,
  readActivationState,
} from './activation-route'

export type ActivationNavigation = {
  state: ActivationState
  /**
   * Whether setup has been entered and not yet finished, from durable state
   * rather than from the URL. The URL is the exact step; this is the fact that
   * there IS a step, and it survives a reload that lost the query string.
   */
  setupInProgress: boolean
  /** Visit a step and make it the exact route restored by reload/back/forward. */
  navigate: (route: ActivationRoute) => void
  /** Replace a stale step from durable state without adding a history entry. */
  reconcile: (route: ActivationRoute) => void
  /** Retire setup URL state once real setup has completed. */
  clear: () => void
}

const readSetupInProgress = (raw: string | null): boolean => raw === '1'
const writeSetupInProgress = (value: boolean): string | null => (value ? '1' : null)

/**
 * Browser-history persistence for the setup layer, plus the one durable bit that
 * says setup is underway. Query params are used deliberately: the main router
 * preserves foreign params across every shell mode, so a reload restores the
 * exact step without setup becoming a second competing application router.
 *
 * The durable flag is what the URL cannot be trusted for (POD-1200). A step is
 * only ever visited by choosing something, so entering any step marks setup as
 * underway, and only {@link ActivationNavigation.clear} — finishing — retires
 * it. Setup therefore ends by being finished, never by the shell noticing that
 * the first step happened to create a repo.
 */
export function useActivationRoute(): ActivationNavigation {
  const [state, setState] = useState<ActivationState>(() =>
    readActivationState(window.location.search),
  )
  const [setupInProgress, setSetupInProgress] = usePersistedUiState(
    ONBOARDING_ACTIVE_KEY,
    readSetupInProgress,
    writeSetupInProgress,
  )
  const stateRef = useRef(state)
  stateRef.current = state
  // The setter identity is not part of `commit`'s contract: a stale closure over
  // it would still write the same key, but callers memoize on `navigate`, so the
  // dependency has to be read through a ref to keep that identity stable.
  const markInProgress = useRef(setSetupInProgress)
  markInProgress.current = setSetupInProgress

  const commit = useCallback((next: ActivationState, replace = false): void => {
    const nextUrl = activationUrl(window.location, next)
    const currentUrl = `${window.location.pathname}${window.location.search}${window.location.hash}`
    if (nextUrl !== currentUrl) {
      window.history[replace ? 'replaceState' : 'pushState'](null, '', nextUrl)
    }
    markInProgress.current(true)
    stateRef.current = next
    setState(next)
  }, [])

  useEffect(() => {
    const onPopState = (): void => {
      const next = readActivationState(window.location.search)
      stateRef.current = next
      setState(next)
    }
    window.addEventListener('popstate', onPopState)
    return () => window.removeEventListener('popstate', onPopState)
  }, [])

  const navigate = useCallback((route: ActivationRoute) => commit({ route }), [commit])
  const reconcile = useCallback((route: ActivationRoute) => commit({ route }, true), [commit])
  const clear = useCallback(() => {
    const nextUrl = activationUrl(window.location, null)
    const currentUrl = `${window.location.pathname}${window.location.search}${window.location.hash}`
    if (nextUrl !== currentUrl) window.history.replaceState(null, '', nextUrl)
    markInProgress.current(false)
    stateRef.current = DEFAULT_ACTIVATION_STATE
    setState(DEFAULT_ACTIVATION_STATE)
  }, [])

  return { state, setupInProgress, navigate, reconcile, clear }
}
