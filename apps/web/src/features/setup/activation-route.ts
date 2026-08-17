export const ACTIVATION_ROUTE_PARAM = 'activation'
/**
 * Retired with the Explore/Resume escape hatch (POD-1174). Setup can no longer
 * be paused, so nothing writes this param — but a URL saved before the change
 * still carries it, and it is still swept out of every URL activation writes.
 */
export const ACTIVATION_MODE_PARAM = 'activationMode'

/**
 * Routes inside first-run setup. Keep this separate from the application
 * router: setup owns the whole window until it finishes, and then hands the
 * shell back. A guided VPS route can extend this union without coupling its
 * steps to AppShell.
 */
export type ActivationRoute =
  | 'welcome'
  | 'local-project'
  | 'agent'
  | 'first-task'
  | 'vps-choice'
  | 'existing-podium'
  | 'existing-client'
  | 'existing-machine'
  | 'vps-intro'

export type ActivationState = {
  route: ActivationRoute
}

export const DEFAULT_ACTIVATION_STATE: ActivationState = {
  route: 'welcome',
}

function isActivationRoute(value: string | null): value is ActivationRoute {
  return (
    value === 'welcome' ||
    value === 'local-project' ||
    value === 'agent' ||
    value === 'first-task' ||
    value === 'vps-choice' ||
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
  return { route: isActivationRoute(route) ? route : DEFAULT_ACTIVATION_STATE.route }
}

/** Whether activation has written anything that should be retired after setup. */
export function hasActivationState(search: string): boolean {
  const params = new URLSearchParams(search)
  return params.has(ACTIVATION_ROUTE_PARAM) || params.has(ACTIVATION_MODE_PARAM)
}

/**
 * A durable VPS handoff remains setup even after a restart has created work.
 *
 * So does setup that is simply UNDERWAY (POD-1200). "Nothing exists yet" is how
 * setup starts, but it is not what keeps setup open: the first thing setup does
 * is add a repo, which retires that condition while the user is still three
 * steps from the end. Once the wizard has been entered, `setupInProgress` is the
 * condition that holds — and only finishing it, which clears the flag, lets the
 * shell through.
 */
export function isActivationEligible({
  loaded,
  repoCount,
  sessionCount,
  setupInProgress,
  hasActivationCheckpoint,
  hasVpsCheckpoint,
}: {
  loaded: boolean
  repoCount: number
  sessionCount: number
  setupInProgress: boolean
  hasActivationCheckpoint: boolean
  hasVpsCheckpoint: boolean
}): boolean {
  return (
    loaded &&
    ((repoCount === 0 && sessionCount === 0) ||
      setupInProgress ||
      hasActivationCheckpoint ||
      hasVpsCheckpoint)
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
 * Persist the setup step in the URL while preserving the app router's own query
 * state (`server`, `e2e`, workspace selection, and future foreign params).
 *
 * EVERY route is written, `welcome` included (POD-1200). It used to stay
 * implicit as the default, which made the first step the one step that erased
 * the checkpoint {@link isActivationEligible} reads: stepping back to welcome
 * after the project step had added a repo left setup with no reason to be on
 * screen, and the half-configured shell appeared underneath it. The param is
 * removed in exactly one place now — `state: null`, meaning setup is over.
 */
export function activationUrl(
  location: Pick<Location, 'pathname' | 'search' | 'hash'>,
  state: ActivationState | null,
): string {
  const params = new URLSearchParams(location.search)
  params.delete(ACTIVATION_ROUTE_PARAM)
  params.delete(ACTIVATION_MODE_PARAM)

  if (state) {
    params.set(ACTIVATION_ROUTE_PARAM, state.route)
  }

  const search = params.toString()
  return `${location.pathname}${search ? `?${search}` : ''}${location.hash}`
}
