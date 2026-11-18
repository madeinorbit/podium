import type { Href, ImperativeRouter } from 'expo-router'
import { resolveHref } from 'expo-router/build/link/href'
import { getStateFromPath } from 'expo-router/build/react-navigation/core/getStateFromPath'
import { StackRouter } from 'expo-router/build/react-navigation/routers/StackRouter'
import type {
  NavigationAction,
  ParamListBase,
  StackNavigationState,
} from 'expo-router/react-navigation'
import { describe, expect, it, vi } from 'vitest'
import { expoRootStateReader } from '../../test/expo-root-state'
import { appStackState, ROOT_SHEET_ROUTES, rootScreenRouter } from './root-screen-router'

const screens = {
  '(tabs)': '',
  'mission/[missionId]': 'mission/:missionId',
  'issue/[issueId]': 'issue/:issueId',
  'session/[sessionId]': 'session/:sessionId',
  'session/[sessionId]/terminal': 'session/:sessionId/terminal',
  'new-issue': 'new-issue',
  'launch/[issueId]': 'launch/:issueId',
  'inspect/[issueId]': 'inspect/:issueId',
}

it('targets the app Stack while retaining the Expo container slot and its keys', () => {
  const app = stack()
  app.router.push('/inspect/task')
  const before = app.navigation.getRootState()
  expect(before.routes[0]?.name).toBe('__root')
  expect(before.key).not.toBe(app.state.key)

  rootScreenRouter(app.router, app.navigation).push('/session/lead')

  expect(app.dispatch.mock.calls.find(([action]) => action.type === 'RESET')?.[0].target).toBe(
    app.state.key,
  )
  const after = app.navigation.getRootState()
  expect(after.key).toBe(before.key)
  expect(after.routes[0]?.key).toBe(before.routes[0]?.key)
  expect(after.routes[0]?.state).toBe(app.state)
})

it('waits for the Expo root slot to contain an app state before addressing a reset', () => {
  expect(appStackState({ routes: [{ name: '__root' }] })).toBeUndefined()
})

it('stops at the app Stack while its active tabs route has a focused child navigator', () => {
  const app = stack()
  expect(app.state.routes[0]?.state?.index).toBe(1)
  expect(appStackState(app.navigation.getRootState())).toBe(app.state)
})

/** Real Expo/React Navigation path parsing and stack actions, without UIKit. */
function stack(nested = true) {
  const config = { routeNames: Object.keys(screens), routeParamList: {}, routeGetIdList: {} }
  const reducer = StackRouter({ initialRouteName: '(tabs)' })
  let state: StackNavigationState<ParamListBase> = reducer.getInitialState(config)
  // A tab's own history must survive sheet dismissal, by the same route key.
  const tabs = state.routes[0]
  if (!tabs) throw new Error('Missing tab root')
  tabs.state = {
    index: 1,
    routes: [
      { name: 'work', key: 'work-root' },
      { name: 'issues', key: 'tasks-root' },
    ],
  }
  const dispatch = vi.fn((action: NavigationAction) => {
    if (action.target && action.target !== state.key) throw new Error('Wrong navigator')
    const next = reducer.getStateForAction(state, action as never, config)
    if (!next) throw new Error(`Unhandled ${action.type}`)
    state = reducer.getRehydratedState(next, config)
  })
  const open = (type: 'PUSH' | 'REPLACE', href: Href) => {
    const linked = getStateFromPath(resolveHref(href), { initialRouteName: '(tabs)', screens })
    const route = linked?.routes.at(-1)
    if (!route) throw new Error(`Invalid href: ${resolveHref(href)}`)
    dispatch({ type, payload: { name: route.name, params: route.params } })
  }
  const router = {
    push: vi.fn((href: Href) => open('PUSH', href)),
    replace: vi.fn((href: Href) => open('REPLACE', href)),
    back: () => dispatch({ type: 'GO_BACK' }),
  } as unknown as ImperativeRouter
  const navigation = {
    getRootState: nested ? expoRootStateReader(() => state) : () => state,
    dispatch,
  }
  return {
    get state() {
      return state
    },
    router,
    navigation,
    dispatch,
  }
}

describe.each([
  true,
  false,
])('full-screen navigation from root sheets, Expo wrapper=%s', (nested) => {
  const stackForLayout = () => stack(nested)
  it.each(
    ROOT_SHEET_ROUTES,
  )('dismisses %s and keeps the warm issue/mission Back chain', (sheet) => {
    const app = stackForLayout()
    app.router.push('/mission/root?sessionId=lead')
    app.router.push('/issue/task')
    const history = [...app.state.routes]
    const path = sheet === 'new-issue' ? '/new-issue' : `/${sheet.split('/')[0]}/task`
    app.router.push(path)

    rootScreenRouter(app.router, app.navigation).push('/session/lead/terminal')

    expect(app.state.routes.map((route) => route.name)).toEqual([
      '(tabs)',
      'mission/[missionId]',
      'issue/[issueId]',
      'session/[sessionId]/terminal',
    ])
    expect(app.state.routes.slice(0, -1)).toEqual(history)
    history.forEach((route, index) => {
      expect(app.state.routes[index]).toBe(route)
    })
    app.router.back()
    expect(app.state.routes).toEqual(history)
    app.router.back()
    expect(app.state.routes.at(-1)).toBe(history[1])
    expect(app.state.routes[0]?.state).toBe(history[0]?.state)
  })

  it('removes stacked sheets while retaining a chat already opened above them', () => {
    const app = stackForLayout()
    app.router.push('/mission/root')
    app.router.push('/inspect/task')
    app.router.push('/launch/task')
    app.router.push('/session/lead')
    const chat = app.state.routes.at(-1)

    rootScreenRouter(app.router, app.navigation).push('/session/lead/terminal')

    expect(app.state.routes.map((route) => route.name)).toEqual([
      '(tabs)',
      'mission/[missionId]',
      'session/[sessionId]',
      'session/[sessionId]/terminal',
    ])
    app.router.back()
    expect(app.state.routes.at(-1)).toBe(chat)
  })

  it('replaces New Task with a shell console without replacing the underlying issue', () => {
    const app = stackForLayout()
    app.router.push('/issue/task')
    const issue = app.state.routes.at(-1)
    app.router.push('/new-issue')
    const root = rootScreenRouter(app.router, app.navigation)

    root.replace({
      pathname: '/session/[sessionId]/terminal',
      params: { sessionId: 'shell session', backTo: '/issue/task' },
    })

    expect(app.router.replace).not.toHaveBeenCalled()
    expect(app.state.routes.at(-1)?.params).toMatchObject({
      sessionId: 'shell session',
      backTo: '/issue/task',
    })
    app.router.back()
    expect(app.state.routes.at(-1)).toBe(issue)
  })

  it('reads the current stack when an earlier callback opens a full-screen destination', () => {
    const app = stackForLayout()
    const root = rootScreenRouter(app.router, app.navigation)
    app.router.push('/new-issue')
    root.push('/session/lead')
    expect(app.state.routes.map((route) => route.name)).toEqual(['(tabs)', 'session/[sessionId]'])
  })

  it('keeps cold console Back at the tab root and preserves Expo anchor options', () => {
    const app = stackForLayout()
    rootScreenRouter(app.router, app.navigation).push('/session/lead/terminal', {
      withAnchor: true,
    })
    expect(app.router.push).toHaveBeenCalledWith('/session/lead/terminal', { withAnchor: true })
    expect(app.dispatch.mock.calls.map(([action]) => action.type)).toEqual(['PUSH'])
    app.router.back()
    expect(app.state.routes.map((route) => route.name)).toEqual(['(tabs)'])
  })

  it('keeps ordinary replace and sheet-to-sheet navigation on Expo Router', () => {
    const app = stackForLayout()
    const root = rootScreenRouter(app.router, app.navigation)
    app.router.push('/session/old')
    root.replace('/session/resolved')
    expect(app.state.routes.at(-1)?.params).toEqual({ sessionId: 'resolved' })
    app.router.push('/inspect/task')
    app.dispatch.mockClear()
    root.replace('/launch/task')
    expect(app.dispatch.mock.calls.map(([action]) => action.type)).toEqual(['REPLACE'])
  })
})
