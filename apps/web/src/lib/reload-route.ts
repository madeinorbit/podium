const RELOAD_ROUTE_PARAM = '__podium_reload_route'

/** The root has been excluded from the service-worker navigation fallback since
 * POD-359, including in old workers. It always reaches the current server HTML. */
export function freshInterfaceUrl(href: string): string {
  const url = new URL(href)
  const route = `${url.pathname}${url.search}${url.hash}`
  url.pathname = '/'
  url.hash = ''
  url.searchParams.set(RELOAD_ROUTE_PARAM, route)
  return url.href
}

export function restoreReloadRoute(win: Pick<Window, 'location' | 'history'> = window): void {
  const url = new URL(win.location.href)
  const route = url.searchParams.get(RELOAD_ROUTE_PARAM)
  if (route === null) return
  url.searchParams.delete(RELOAD_ROUTE_PARAM)
  let destination = `${url.pathname}${url.search}${url.hash}`
  // Only restore an app-local route; never navigate to a supplied foreign URL.
  if (route.startsWith('/')) {
    try {
      const target = new URL(route, url.origin)
      if (target.origin === url.origin)
        destination = `${target.pathname}${target.search}${target.hash}`
    } catch {
      // A malformed recovery parameter cannot prevent the app from booting.
    }
  }
  win.history.replaceState(win.history.state, '', destination)
}
