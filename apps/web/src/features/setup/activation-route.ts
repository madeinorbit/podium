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
  | 'server-connected'
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
    value === 'server-connected' ||
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
 * condition that holds until the server says setup is finished.
 *
 * And none of it applies to someone who does not set this server up
 * (POD-6882). Setup asks where the server runs and adds its first machine: the
 * installer's questions. A member who joined an existing workspace sees only
 * what is shared with them, so "no repos, no sessions" is their normal first
 * view, not a server waiting to be set up. `setsUpServer` is the server's own
 * answer (`/auth/admin/viewer`), never inferred from what this member can see.
 */
export function isActivationEligible({
  loaded,
  setsUpServer,
  setupFinished,
  repoCount,
  setupInProgress,
  hasActivationCheckpoint,
  hasVpsCheckpoint,
}: {
  loaded: boolean
  setsUpServer: boolean
  setupFinished: boolean
  repoCount: number
  setupInProgress: boolean
  hasActivationCheckpoint: boolean
  hasVpsCheckpoint: boolean
}): boolean {
  // The setup step in the URL is authoritative: the first-task step starts a
  // session before setup finishes. The server's completion answer retires a
  // saved flag alone, including one written by a build that read placeholder
  // zero counts. This decision never needs the sessions on the device.
  return (
    loaded &&
    setsUpServer &&
    ((!setupFinished && (repoCount === 0 || setupInProgress)) ||
      hasActivationCheckpoint ||
      hasVpsCheckpoint)
  )
}

/**
 * Setup state this device should retire: a saved setup flag, with no setup step
 * in the URL, on an instance whose server says setup is finished; or any setup flag or
 * step held by someone who does not set this server up (POD-6882), such as a
 * member who was shown the wizard by an earlier build and pressed into it.
 */
export function hasStaleActivation({
  loaded,
  setsUpServer,
  setupFinished,
  setupInProgress,
  hasActivationCheckpoint,
}: {
  loaded: boolean
  setsUpServer: boolean
  setupFinished: boolean
  setupInProgress: boolean
  hasActivationCheckpoint: boolean
}): boolean {
  if (!loaded) return false
  if (!setsUpServer) return setupInProgress || hasActivationCheckpoint
  return setupFinished && setupInProgress && !hasActivationCheckpoint
}

/**
 * A native desktop that has just connected to a brand-new remote authority has already made its
 * topology choice. Continue at the connection confirmation instead of showing the server-choice
 * screen again — and land there rather than in project intake, so the step the restart arrives on
 * says the connection worked and project intake has something behind it to close back to
 * (POD-1323).
 */
/**
 * Whether this desktop's window shows a REMOTE server: a client, or a machine that joined one
 * (POD-5983). Either way the topology question is answered — a joined machine landing on "Where
 * should Podium run?" again was offered to set the server up a second time.
 */
export function showsRemoteServer(launchMode: string | undefined): boolean {
  return launchMode === 'client' || launchMode === 'daemon'
}

export function shouldStartRemoteClientAtHandoff({
  launchMode,
  loaded,
  setsUpServer,
  repoCount,
  setupFinished,
  route,
  hasActivationCheckpoint,
  hasVpsCheckpoint,
}: {
  launchMode: string | undefined
  loaded: boolean
  setsUpServer: boolean
  repoCount: number
  setupFinished: boolean
  route: ActivationRoute
  hasActivationCheckpoint: boolean
  hasVpsCheckpoint: boolean
}): boolean {
  return (
    showsRemoteServer(launchMode) &&
    loaded &&
    setsUpServer &&
    repoCount === 0 &&
    !setupFinished &&
    route === 'welcome' &&
    !hasActivationCheckpoint &&
    !hasVpsCheckpoint
  )
}

/**
 * A BROWSER is already looking at a running server, so "Where should Podium run?" has been
 * answered before the page could load: by `podium setup` in a terminal, or by whoever put
 * the server there (POD-3274). That screen is the desktop app's question — run here, or on
 * a VPS — and in a tab it asked again what the terminal had just settled. A fresh browser
 * starts at project intake instead; Back still reaches the welcome screen.
 */
export function shouldStartBrowserAtProjectIntake({
  nativeShell,
  loaded,
  setsUpServer,
  repoCount,
  setupFinished,
  route,
  hasActivationCheckpoint,
  hasVpsCheckpoint,
}: {
  nativeShell: boolean
  loaded: boolean
  setsUpServer: boolean
  repoCount: number
  setupFinished: boolean
  route: ActivationRoute
  hasActivationCheckpoint: boolean
  hasVpsCheckpoint: boolean
}): boolean {
  return (
    !nativeShell &&
    loaded &&
    setsUpServer &&
    repoCount === 0 &&
    !setupFinished &&
    route === 'welcome' &&
    !hasActivationCheckpoint &&
    !hasVpsCheckpoint
  )
}

/**
 * Where closing project intake goes. On a desktop that has handed itself to a
 * remote server, the step behind intake is the confirmation that the handoff
 * landed; `welcome` is a topology question that desktop has already answered,
 * and returning to it read as the whole wizard rewinding (POD-1323).
 */
export function projectIntakeReturnRoute(launchMode: string | undefined): ActivationRoute {
  return showsRemoteServer(launchMode) ? 'server-connected' : 'welcome'
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
