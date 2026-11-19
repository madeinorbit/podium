import { keepMountedState } from 'expo-router/build/fork/keepMountedState'
import { describe, expect, it } from 'vitest'

/**
 * The patched popstate path (patches/expo-router@57.0.26.patch, POD-7177).
 *
 * A browser back or forward to an entry Expo Router's memory history does not
 * hold resets the root to the state the path parses to. That state has no
 * route keys; reset to it as is and the root layout remounts (readiness, auth,
 * a fresh replica). `keepMountedState` reaches it within the current state.
 * The shapes below are the phone's: the root slot, its stack of (tabs) and the
 * mission screens, the tabs, and each tab's own stack. The browser test
 * expo-mobile-history-keeps-app covers the router around it.
 */
type Route = { name: string; key?: string; params?: object; state?: State }
type State = {
  type?: string
  key?: string
  stale?: boolean
  index?: number
  routeNames?: string[]
  routes: Route[]
}

const work = (params?: object): Route => ({
  name: 'work',
  key: 'work-K',
  state: {
    type: 'stack',
    key: 'stack-work',
    stale: false,
    index: 0,
    routes: [{ name: 'index', key: 'work-index-K', ...(params ? { params } : {}) }],
  },
})
const tabs = (index = 0): Route => ({
  name: '(tabs)',
  key: 'tabs-K',
  state: {
    type: 'tab',
    key: 'tab-T',
    stale: false,
    index,
    routeNames: ['work', 'issues'],
    routes: [work({ server: 'ws' }), { name: 'issues', key: 'issues-K' }],
  },
})
const mission = (id: string, key: string): Route => ({
  name: 'mission/[missionId]',
  key,
  params: { missionId: id },
})
const details = (id: string, key: string): Route => ({
  name: 'mission/[missionId]/details',
  key,
  params: { missionId: id },
})
const root = (...stack: Route[]): State => ({
  type: 'stack',
  key: 'stack-root',
  stale: false,
  index: 0,
  routeNames: ['__root'],
  routes: [
    {
      name: '__root',
      key: '__root-K',
      state: {
        type: 'stack',
        key: 'stack-app',
        stale: false,
        index: stack.length - 1,
        routes: stack,
      },
    },
  ],
})
/** What `getStateFromPath` answers: names and params, no keys. */
const fromPath = (route: Route): State => ({
  routes: [{ name: '__root', state: { routes: [route] } }],
})
const appStack = (state: State | undefined) => state?.routes[0]?.state
const keep = (current: State | undefined, next: State) =>
  keepMountedState(current as never, next as never) as unknown as State

describe('a popstate to an entry the router does not hold', () => {
  it('back to Work pops the stack and keeps the root, the tabs and the Work screen', () => {
    const current = root(tabs(), mission('i1', 'm-K'), details('i1', 'd-K'))
    const next = fromPath({
      name: '(tabs)',
      state: {
        routes: [
          { name: 'work', state: { routes: [{ name: 'index', params: { server: 'ws' } }] } },
        ],
      },
    })
    const kept = keep(current, next)
    expect(kept.routes[0]?.key).toBe('__root-K')
    const stack = appStack(kept)
    expect(stack?.routes.map((route) => route.key)).toEqual(['tabs-K'])
    expect(stack?.index).toBe(0)
    // Changed levels are partial, so each navigator rehydrates them and keeps the keys.
    expect(stack?.stale).toBeUndefined()
    const tabState = stack?.routes[0]?.state
    expect(tabState?.routes.map((route) => route.key)).toEqual(['work-K', 'issues-K'])
    expect(tabState?.routes[0]?.state?.routes[0]?.key).toBe('work-index-K')
  })

  it('forward to a mission the stack does not hold pushes it over the mounted routes', () => {
    const current = root(tabs())
    const kept = keep(
      current,
      fromPath({ name: 'mission/[missionId]/details', params: { missionId: 'i1' } }),
    )
    const stack = appStack(kept)
    expect(stack?.routes.map((route) => route.key)).toEqual(['tabs-K', undefined])
    expect(stack?.routes[1]).toMatchObject({
      name: 'mission/[missionId]/details',
      params: { missionId: 'i1' },
    })
    expect(stack?.index).toBe(1)
  })

  it('back to a mission the stack holds pops to that route, key and all', () => {
    const current = root(tabs(), mission('i1', 'm-K'), details('i1', 'd-K'))
    const kept = keep(
      current,
      fromPath({ name: 'mission/[missionId]', params: { missionId: 'i1' } }),
    )
    expect(appStack(kept)?.routes.map((route) => route.key)).toEqual(['tabs-K', 'm-K'])
  })

  it('another mission is another screen: same name, other params, pushed', () => {
    const current = root(tabs(), details('i1', 'd-K'))
    const kept = keep(
      current,
      fromPath({ name: 'mission/[missionId]/details', params: { missionId: 'i2' } }),
    )
    const stack = appStack(kept)
    expect(stack?.routes.map((route) => route.key)).toEqual(['tabs-K', 'd-K', undefined])
    expect(stack?.routes[2]?.params).toEqual({ missionId: 'i2' })
  })

  it('a tab the tabs hold is focused, every tab keeps its key', () => {
    const current = root(tabs(0))
    const kept = keep(
      current,
      fromPath({ name: '(tabs)', state: { routes: [{ name: 'issues' }] } }),
    )
    const tabState = appStack(kept)?.routes[0]?.state
    expect(tabState?.index).toBe(1)
    expect(tabState?.routes.map((route) => route.key)).toEqual(['work-K', 'issues-K'])
  })

  it('with no current state the path state is used as before', () => {
    const next = fromPath({ name: '(tabs)' })
    expect(keep(undefined, next)).toBe(next)
  })
})
