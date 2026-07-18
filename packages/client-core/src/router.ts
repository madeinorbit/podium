/**
 * Hand-rolled History-API router (issue #15 Phase 4): the main surface is a
 * real URL instead of a persisted view string. One route table serves both
 * shells (AppShell / MobileApp — mobile chrome is a rendering concern, not a
 * navigation concern).
 *
 * Deep-linkable routes:
 *   /                       issues (a persisted-view restore may replace this)
 *   /workspace[?wt=&pane=]  the worktree workspace, pane state in the query
 *   /issues                 the issues board
 *   /issues/:id             the board with an issue page open
 *   /settings[/:tab]        settings, optionally on a specific tab
 *   /usage  /automations  /specs  /workflows    the respective views
 *
 * Unknown URLs fall back to issues (replaceState, so back doesn't bounce).
 * Foreign query params (`?server=`, `?e2e`) are preserved across navigation.
 */

/** Main-area surface. (Formerly defined by store.tsx — the router owns it now.) */
export type MainView =
  | 'workspace'
  | 'settings'
  | 'usage'
  | 'issues'
  | 'automations'
  | 'specs'
  | 'workflows'

export interface RouteState {
  view: MainView
  /** Issue whose page is open (issues view), or null. */
  issueId: string | null
  /** Settings deep-link tab, or null. */
  settingsTab: string | null
  /** Workspace pane state (query-encoded so a workspace URL is shareable). */
  worktree: string | null
  pane: string | null
}

export function routeDefaults(view: MainView): RouteState {
  return { view, issueId: null, settingsTab: null, worktree: null, pane: null }
}

/** Query params owned by the router — everything else is preserved verbatim. */
const ROUTE_PARAMS = ['wt', 'pane'] as const

function decode(seg: string): string {
  try {
    return decodeURIComponent(seg)
  } catch {
    return seg
  }
}

/** URL → route. Returns null for an unknown path (caller falls back to issues). */
export function parseRoute(pathname: string, search: string): RouteState | null {
  const params = new URLSearchParams(search)
  const segs = pathname.split('/').filter(Boolean).map(decode)
  const base: Omit<RouteState, 'view'> = {
    issueId: null,
    settingsTab: null,
    worktree: params.get('wt'),
    pane: params.get('pane'),
  }
  if (segs.length === 0) return { view: 'issues', ...base }
  const [head, second, ...rest] = segs
  if (rest.length > 0) return null
  switch (head) {
    case 'workspace':
      return second === undefined ? { view: 'workspace', ...base } : null
    case 'issues':
      return { view: 'issues', ...base, issueId: second ?? null }
    case 'settings':
      return { view: 'settings', ...base, settingsTab: second ?? null }
    case 'usage':
      return second === undefined ? { view: 'usage', ...base } : null
    case 'automations':
      return second === undefined ? { view: 'automations', ...base } : null
    case 'specs':
      return second === undefined ? { view: 'specs', ...base } : null
    case 'workflows':
      return second === undefined ? { view: 'workflows', ...base } : null
    default:
      return null
  }
}

/** Route → URL (path + query). `currentSearch` carries foreign params over. */
export function routePath(route: RouteState, currentSearch = ''): string {
  let path: string
  switch (route.view) {
    case 'workspace':
      path = '/workspace'
      break
    case 'issues':
      path = route.issueId ? `/issues/${encodeURIComponent(route.issueId)}` : '/issues'
      break
    case 'settings':
      path = route.settingsTab ? `/settings/${encodeURIComponent(route.settingsTab)}` : '/settings'
      break
    case 'usage':
      path = '/usage'
      break
    case 'automations':
      path = '/automations'
      break
    case 'specs':
      path = '/specs'
      break
    case 'workflows':
      path = '/workflows'
      break
  }
  const params = new URLSearchParams(currentSearch)
  for (const p of ROUTE_PARAMS) params.delete(p)
  if (route.view === 'workspace') {
    if (route.worktree) params.set('wt', route.worktree)
    if (route.pane) params.set('pane', route.pane)
  }
  const qs = params.toString()
  return qs ? `${path}?${qs}` : path
}

// ---------------------------------------------------------------------------
// Router: a thin stateful wrapper over pushState/replaceState + popstate.
// ---------------------------------------------------------------------------

/** The window surface the router touches — injectable for deterministic tests. */
export interface RouterWindow {
  location: { pathname: string; search: string }
  history: {
    pushState(data: unknown, unused: string, url?: string | null): void
    replaceState(data: unknown, unused: string, url?: string | null): void
  }
  addEventListener(type: 'popstate', cb: () => void): void
  removeEventListener(type: 'popstate', cb: () => void): void
}

export interface Router {
  current(): RouteState
  /** Push a new history entry and notify. No-op when the URL wouldn't change. */
  navigate(next: RouteState): void
  /** Replace the current entry and notify. No-op when the URL wouldn't change. */
  replace(next: RouteState): void
  subscribe(cb: (route: RouteState) => void): () => void
  /** Arm the popstate listener. Idempotent; pairs with dispose (StrictMode's
   *  dev double-mount disposes once, so the mount effect must re-arm). */
  attach(): void
  dispose(): void
}

export interface RouterInit {
  /** Defaults to the real window. */
  win?: RouterWindow
  /** Used when the initial URL is unknown, AND as the restored surface when the
   *  app starts on plain `/` (the persisted-view behavior the view string had). */
  fallbackView?: MainView
}

export function createRouter(init: RouterInit = {}): Router {
  const win = init.win ?? (window as unknown as RouterWindow)
  const listeners = new Set<(route: RouteState) => void>()

  const parsed = parseRoute(win.location.pathname, win.location.search)
  let route: RouteState
  if (parsed === null) {
    // Unknown URL → fall back to issues (or the restored view) without leaving a
    // dead history entry behind.
    route = routeDefaults(init.fallbackView ?? 'issues')
    win.history.replaceState(null, '', routePath(route, win.location.search))
  } else if (
    init.fallbackView &&
    init.fallbackView !== 'issues' &&
    win.location.pathname.replace(/\/+$/, '') === ''
  ) {
    // Plain `/` start: restore the persisted surface (reload lands where you
    // were), as a replace so back never returns to a transient `/`.
    route = routeDefaults(init.fallbackView)
    win.history.replaceState(null, '', routePath(route, win.location.search))
  } else {
    route = parsed
  }

  const notify = (): void => {
    for (const cb of [...listeners]) cb(route)
  }
  const onPopState = (): void => {
    const next = parseRoute(win.location.pathname, win.location.search)
    if (next === null) {
      route = routeDefaults('issues')
      win.history.replaceState(null, '', routePath(route, win.location.search))
    } else {
      route = next
    }
    notify()
  }
  let attached = false
  const attach = (): void => {
    if (attached) return
    attached = true
    win.addEventListener('popstate', onPopState)
  }
  attach()

  const apply = (next: RouteState, mode: 'push' | 'replace'): void => {
    const nextUrl = routePath(next, win.location.search)
    const currentUrl = `${win.location.pathname}${win.location.search}`
    if (nextUrl === currentUrl) {
      // Same URL — still adopt the (equivalent) route object silently.
      route = next
      return
    }
    if (mode === 'push') win.history.pushState(null, '', nextUrl)
    else win.history.replaceState(null, '', nextUrl)
    route = next
    notify()
  }

  return {
    current: () => route,
    navigate: (next) => apply(next, 'push'),
    replace: (next) => apply(next, 'replace'),
    subscribe: (cb) => {
      listeners.add(cb)
      return () => {
        listeners.delete(cb)
      }
    },
    attach,
    dispose: () => {
      attached = false
      win.removeEventListener('popstate', onPopState)
      listeners.clear()
    },
  }
}

/**
 * In-memory RouterWindow for platforms without a History API (React Native).
 * The shared store's router runs over it unchanged: navigate/replace mutate a
 * simple URL stack, popstate never fires (native back is the app shell's job).
 */
export function createMemoryRouterWindow(initialUrl = '/'): RouterWindow {
  const split = (url: string): { pathname: string; search: string } => {
    const q = url.indexOf('?')
    return q === -1
      ? { pathname: url, search: '' }
      : { pathname: url.slice(0, q), search: url.slice(q) }
  }
  let current = split(initialUrl)
  const set = (url?: string | null): void => {
    if (typeof url === 'string') current = split(url)
  }
  return {
    location: {
      get pathname() {
        return current.pathname
      },
      get search() {
        return current.search
      },
    },
    history: {
      pushState: (_data, _unused, url) => set(url),
      replaceState: (_data, _unused, url) => set(url),
    },
    addEventListener: () => {},
    removeEventListener: () => {},
  }
}
