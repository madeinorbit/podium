import { describe, expect, it } from 'vitest'
import {
  createRouter,
  parseRoute,
  type RouterWindow,
  type RouteState,
  routeDefaults,
  routePath,
} from './router'

// ---------------------------------------------------------------------------
// URL router (issue #15 Phase 4): URL → view mapping, back/forward via a
// deterministic fake history, unknown-URL fallback, and foreign-query
// preservation (?server= / ?e2e must survive navigation).
// ---------------------------------------------------------------------------

describe('parseRoute', () => {
  const at = (path: string, search = '') => parseRoute(path, search)

  it('maps every known URL to its view', () => {
    expect(at('/')?.view).toBe('home')
    expect(at('/home')?.view).toBe('home')
    expect(at('/workspace')?.view).toBe('workspace')
    expect(at('/issues')?.view).toBe('issues')
    expect(at('/issues/iss_42')).toMatchObject({ view: 'issues', issueId: 'iss_42' })
    expect(at('/settings')).toMatchObject({ view: 'settings', settingsTab: null })
    expect(at('/settings/hosts')).toMatchObject({ view: 'settings', settingsTab: 'hosts' })
    expect(at('/usage')?.view).toBe('usage')
    expect(at('/automations')?.view).toBe('automations')
  })

  it('reads workspace pane state from the query', () => {
    expect(at('/workspace', '?wt=%2Fw%2Fmain&pane=s1')).toMatchObject({
      view: 'workspace',
      worktree: '/w/main',
      pane: 's1',
    })
  })

  it('returns null for unknown URLs', () => {
    expect(at('/bogus')).toBeNull()
    expect(at('/issues/x/y')).toBeNull()
    expect(at('/workspace/extra')).toBeNull()
    expect(at('/search')).toBeNull()
  })
})

describe('routePath', () => {
  it('round-trips every route', () => {
    const routes: RouteState[] = [
      routeDefaults('home'),
      { ...routeDefaults('workspace'), worktree: '/w/x', pane: 's9' },
      { ...routeDefaults('issues'), issueId: 'iss_1' },
      { ...routeDefaults('settings'), settingsTab: 'notifications' },
      routeDefaults('usage'),
      routeDefaults('automations'),
      routeDefaults('workflows'),
    ]
    for (const r of routes) {
      const url = routePath(r)
      const [path, search = ''] = url.split('?')
      expect(parseRoute(path as string, search)).toEqual(r)
    }
  })

  it('preserves foreign query params (?server=, ?e2e) and drops its own', () => {
    const url = routePath(routeDefaults('issues'), '?server=ws%3A%2F%2Fhost%3A1&wt=%2Fold&e2e')
    expect(url).toContain('/issues?')
    expect(url).toContain('server=ws%3A%2F%2Fhost%3A1')
    expect(url).toContain('e2e')
    expect(url).not.toContain('wt=')
  })
})

/** Deterministic fake window: a real history stack with popstate dispatch. */
function fakeWindow(initialUrl = '/'): RouterWindow & {
  back(): void
  forward(): void
  url(): string
} {
  let stack = [initialUrl]
  let idx = 0
  const listeners = new Set<() => void>()
  const setUrl = () => {
    const [pathname, search = ''] = (stack[idx] as string).split('?')
    win.location.pathname = pathname as string
    win.location.search = search ? `?${search}` : ''
  }
  const win = {
    location: { pathname: '/', search: '' },
    history: {
      pushState: (_d: unknown, _u: string, url?: string | null) => {
        stack = stack.slice(0, idx + 1)
        stack.push(url ?? stack[idx] ?? '/')
        idx += 1
        setUrl()
      },
      replaceState: (_d: unknown, _u: string, url?: string | null) => {
        stack[idx] = url ?? stack[idx] ?? '/'
        setUrl()
      },
    },
    addEventListener: (_t: 'popstate', cb: () => void) => void listeners.add(cb),
    removeEventListener: (_t: 'popstate', cb: () => void) => void listeners.delete(cb),
    back: () => {
      if (idx === 0) return
      idx -= 1
      setUrl()
      for (const cb of [...listeners]) cb()
    },
    forward: () => {
      if (idx >= stack.length - 1) return
      idx += 1
      setUrl()
      for (const cb of [...listeners]) cb()
    },
    url: () => stack[idx] as string,
  }
  setUrl()
  return win
}

describe('createRouter', () => {
  it('navigates with pushState; back and forward restore routes', () => {
    const win = fakeWindow('/')
    const router = createRouter({ win })
    const seen: string[] = []
    router.subscribe((r) => seen.push(r.view))

    router.navigate(routeDefaults('issues'))
    router.navigate({ ...routeDefaults('issues'), issueId: 'iss_7' })
    expect(win.url()).toBe('/issues/iss_7')

    win.back()
    expect(router.current()).toMatchObject({ view: 'issues', issueId: null })
    win.back()
    expect(router.current().view).toBe('home')
    expect(win.url()).toBe('/')

    win.forward()
    expect(router.current()).toMatchObject({ view: 'issues', issueId: null })
    expect(seen).toEqual(['issues', 'issues', 'issues', 'home', 'issues'])
  })

  it('settings tab changes are history entries: back/forward move between tabs', () => {
    // The store's setSettingsTab pushes (never replaces) tab changes, so each
    // visited tab is a real /settings/:tab history entry.
    const win = fakeWindow('/settings')
    const router = createRouter({ win })
    router.navigate({ ...router.current(), settingsTab: 'appearance' })
    router.navigate({ ...router.current(), settingsTab: 'network' })
    expect(win.url()).toBe('/settings/network')

    win.back()
    expect(router.current()).toMatchObject({ view: 'settings', settingsTab: 'appearance' })
    expect(win.url()).toBe('/settings/appearance')
    win.back()
    expect(router.current()).toMatchObject({ view: 'settings', settingsTab: null })
    win.forward()
    expect(router.current()).toMatchObject({ view: 'settings', settingsTab: 'appearance' })
  })

  it('falls back to home on an unknown initial URL (replace, not push)', () => {
    const win = fakeWindow('/definitely-not-a-route')
    const router = createRouter({ win })
    expect(router.current().view).toBe('home')
    expect(win.url()).toBe('/')
    // replace: back has nowhere to go (single entry)
    win.back()
    expect(router.current().view).toBe('home')
  })

  it('restores the persisted view when starting on plain /', () => {
    const win = fakeWindow('/')
    const router = createRouter({ win, fallbackView: 'workspace' })
    expect(router.current().view).toBe('workspace')
    expect(win.url()).toBe('/workspace')
  })

  it('a deep link wins over the persisted view', () => {
    const win = fakeWindow('/settings/hosts')
    const router = createRouter({ win, fallbackView: 'workspace' })
    expect(router.current()).toMatchObject({ view: 'settings', settingsTab: 'hosts' })
  })

  it('keeps foreign query params across navigation', () => {
    const win = fakeWindow('/?server=ws%3A%2F%2Fh%3A9')
    const router = createRouter({ win })
    router.navigate(routeDefaults('usage'))
    expect(win.url()).toBe('/usage?server=ws%3A%2F%2Fh%3A9')
  })

  it('same-URL navigation is silent (no history entry, no notify)', () => {
    const win = fakeWindow('/issues')
    const router = createRouter({ win })
    let notifications = 0
    router.subscribe(() => {
      notifications += 1
    })
    router.navigate(routeDefaults('issues'))
    expect(notifications).toBe(0)
    win.back()
    expect(win.url()).toBe('/issues') // nothing was pushed
  })
})
