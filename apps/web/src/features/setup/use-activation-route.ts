import { useCallback, useEffect, useRef, useState } from 'react'
import {
  activationUrl,
  DEFAULT_ACTIVATION_STATE,
  type ActivationRoute,
  type ActivationState,
  readActivationState,
} from './activation-route'

export type ActivationNavigation = {
  state: ActivationState
  /** Visit a step and make it the exact route restored by reload/back/forward. */
  navigate: (route: ActivationRoute) => void
  /** Leave activation without completing it or discarding its current route. */
  explore: () => void
  /** Return to the route held while the user explored. */
  resume: () => void
  /** Retire activation URL state once real setup has completed. */
  clear: () => void
}

/**
 * Browser-history persistence for the activation layer. Query params are used
 * deliberately: the main router preserves foreign params across every shell
 * mode, so users can explore and reload without activation becoming a second
 * competing application router.
 */
export function useActivationRoute(): ActivationNavigation {
  const [state, setState] = useState<ActivationState>(() =>
    readActivationState(window.location.search),
  )
  const stateRef = useRef(state)
  stateRef.current = state

  const commit = useCallback((next: ActivationState, replace = false): void => {
    const nextUrl = activationUrl(window.location, next)
    const currentUrl = `${window.location.pathname}${window.location.search}${window.location.hash}`
    if (nextUrl !== currentUrl) {
      window.history[replace ? 'replaceState' : 'pushState'](null, '', nextUrl)
    }
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

  const navigate = useCallback(
    (route: ActivationRoute) => commit({ route, mode: 'active' }),
    [commit],
  )
  const explore = useCallback(
    () => commit({ route: stateRef.current.route, mode: 'exploring' }),
    [commit],
  )
  const resume = useCallback(
    () => commit({ route: stateRef.current.route, mode: 'active' }),
    [commit],
  )
  const clear = useCallback(() => {
    const nextUrl = activationUrl(window.location, null)
    const currentUrl = `${window.location.pathname}${window.location.search}${window.location.hash}`
    if (nextUrl !== currentUrl) window.history.replaceState(null, '', nextUrl)
    stateRef.current = DEFAULT_ACTIVATION_STATE
    setState(DEFAULT_ACTIVATION_STATE)
  }, [])

  return { state, navigate, explore, resume, clear }
}
