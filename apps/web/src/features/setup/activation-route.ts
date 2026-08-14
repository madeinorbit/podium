export const ACTIVATION_ROUTE_PARAM = 'activation'
export const ACTIVATION_MODE_PARAM = 'activationMode'

/**
 * Routes inside first-run activation. Keep this separate from the application
 * router: activation is a resumable surface layered into the real shell, not a
 * replacement application mode. A guided VPS route can extend this union
 * without coupling its steps to AppShell.
 */
export type ActivationRoute =
  | 'welcome'
  | 'local-project'
  | 'agent'
  | 'first-task'
  | 'existing-podium'
  | 'existing-client'
  | 'existing-machine'
  | 'vps-intro'

export type ActivationState = {
  route: ActivationRoute
  mode: 'active' | 'exploring'
}

export const DEFAULT_ACTIVATION_STATE: ActivationState = {
  route: 'welcome',
  mode: 'active',
}

function isActivationRoute(value: string | null): value is ActivationRoute {
  return (
    value === 'welcome' ||
    value === 'local-project' ||
    value === 'agent' ||
    value === 'first-task' ||
    value === 'existing-podium' ||
    value === 'existing-client' ||
    value === 'existing-machine' ||
    value === 'vps-intro'
  )
}

/** Parse defensively so stale or future route names return to the welcome step. */
export function readActivationState(search: string): ActivationState {
  const params = new URLSearchParams(search)
  const route = params.get(ACTIVATION_ROUTE_PARAM)
  return {
    route: isActivationRoute(route) ? route : DEFAULT_ACTIVATION_STATE.route,
    mode:
      params.get(ACTIVATION_MODE_PARAM) === 'exploring'
        ? 'exploring'
        : DEFAULT_ACTIVATION_STATE.mode,
  }
}

/** Whether activation has written anything that should be retired after setup. */
export function hasActivationState(search: string): boolean {
  const params = new URLSearchParams(search)
  return params.has(ACTIVATION_ROUTE_PARAM) || params.has(ACTIVATION_MODE_PARAM)
}

/** A durable VPS handoff remains activation even after the user creates work while exploring. */
export function isActivationEligible({
  loaded,
  repoCount,
  sessionCount,
  hasActivationCheckpoint,
  hasVpsCheckpoint,
}: {
  loaded: boolean
  repoCount: number
  sessionCount: number
  hasActivationCheckpoint: boolean
  hasVpsCheckpoint: boolean
}): boolean {
  return (
    loaded &&
    ((repoCount === 0 && sessionCount === 0) || hasActivationCheckpoint || hasVpsCheckpoint)
  )
}

/**
 * A native desktop that has just connected to a brand-new remote authority has already made its
 * topology choice. Continue at project intake instead of showing the server-choice screen again.
 */
export function shouldStartRemoteClientAtProjects({
  launchMode,
  loaded,
  repoCount,
  sessionCount,
  route,
  hasActivationCheckpoint,
  hasVpsCheckpoint,
}: {
  launchMode: string | undefined
  loaded: boolean
  repoCount: number
  sessionCount: number
  route: ActivationRoute
  hasActivationCheckpoint: boolean
  hasVpsCheckpoint: boolean
}): boolean {
  return (
    launchMode === 'client' &&
    loaded &&
    repoCount === 0 &&
    sessionCount === 0 &&
    route === 'welcome' &&
    !hasActivationCheckpoint &&
    !hasVpsCheckpoint
  )
}

/**
 * Persist activation in the URL while preserving the app router's own query
 * state (`server`, `e2e`, workspace selection, and future foreign params).
 * The default welcome route stays implicit; every non-default route is exact.
 */
export function activationUrl(
  location: Pick<Location, 'pathname' | 'search' | 'hash'>,
  state: ActivationState | null,
): string {
  const params = new URLSearchParams(location.search)
  params.delete(ACTIVATION_ROUTE_PARAM)
  params.delete(ACTIVATION_MODE_PARAM)

  if (state) {
    if (state.route !== DEFAULT_ACTIVATION_STATE.route || state.mode === 'exploring') {
      params.set(ACTIVATION_ROUTE_PARAM, state.route)
    }
    if (state.mode === 'exploring') params.set(ACTIVATION_MODE_PARAM, state.mode)
  }

  const search = params.toString()
  return `${location.pathname}${search ? `?${search}` : ''}${location.hash}`
}
