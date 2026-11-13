import { cleanup, render } from '@testing-library/react'
import { NavigationContext } from 'expo-router/build/react-navigation/core/NavigationContext'
import { NavigationRouteContext } from 'expo-router/build/react-navigation/core/NavigationProvider'
import { StackActions, StackRouter } from 'expo-router/build/react-navigation/routers/StackRouter'
import type { NavigationState } from 'expo-router/react-navigation'
import { afterEach, expect, it, vi } from 'vitest'
import { MISSION_CHAT, MISSION_DECK, missionStack } from './mission-stack'
import { useMissionDeckReturn } from './use-mission-deck-return'

const platform = vi.hoisted(() => ({ os: 'ios' }))
vi.mock('react-native', async (original) => {
  const real = await original<typeof import('react-native')>()
  return {
    ...real,
    Platform: {
      ...real.Platform,
      get OS() {
        return platform.os
      },
    },
  }
})
afterEach(() => {
  cleanup()
  platform.os = 'ios'
})

const options = {
  routeNames: ['(tabs)', MISSION_CHAT, MISSION_DECK, 'inspect/[issueId]'],
  routeParamList: {},
  routeGetIdList: {},
}
const router = StackRouter({ initialRouteName: '(tabs)' })
const initial = () => router.getInitialState(options)
function required<T>(value: T | null | undefined): T {
  if (value == null) throw new Error('Missing navigation value')
  return value
}
const focused = (state: NavigationState) => required(state.routes[state.index])
const sessionParam = (route: NavigationState['routes'][number] | undefined) =>
  (route?.params as { sessionId?: string } | undefined)?.sessionId
const pop = (state: NavigationState) =>
  router.getRehydratedState(
    required(
      router.getStateForAction(state as ReturnType<typeof initial>, StackActions.pop(1), options),
    ),
    options,
  )
const push = (state: NavigationState, name: string, params: object) => {
  const result = router.getStateForAction(
    state as ReturnType<typeof initial>,
    StackActions.push(name, params),
    options,
  )
  if (!result) throw new Error('Push refused')
  return router.getRehydratedState(result, options)
}

it('task opening keeps chat on top with its selected seat and deck beneath', () => {
  const from = initial()
  const chat = push(from, MISSION_CHAT, { missionId: 'child' })
  const chatRoute = focused(chat)
  const next = missionStack(chat, chatRoute.key, 'root', 'task-coordinator')
  expect(next.routes.map((route) => route.name)).toEqual(['(tabs)', MISSION_DECK, MISSION_CHAT])
  expect(next.routes[next.index]).toBe(chatRoute)
  expect(next.routes[0]).toBe(from.routes[0])
  expect(next.routes[1]?.params).toEqual({ missionId: 'root', sessionId: 'task-coordinator' })
  const back = pop(next)
  expect(back.routes[back.index]?.name).toBe(MISSION_DECK)
  expect(sessionParam(back.routes[back.index])).toBe('task-coordinator')
  expect(router.getStateForAction(back, StackActions.pop(1), options)?.routes).toEqual(from.routes)
})

it('reuses the deck when a row pushes another chat, updating the highlighted seat', () => {
  const first = push(initial(), MISSION_CHAT, { missionId: 'root', sessionId: 'lead' })
  const opened = missionStack(first, focused(first).key, 'root', 'lead')
  const deck = pop(opened)
  const nextChat = push(deck, MISSION_CHAT, { missionId: 'root', sessionId: 'helper' })
  const next = missionStack(nextChat, focused(nextChat).key, 'root', 'helper')
  expect(next.routes.filter((route) => route.name === MISSION_DECK)).toHaveLength(1)
  expect(next.routes[1]?.key).toBe(opened.routes[1]?.key)
  expect(sessionParam(next.routes[1])).toBe('helper')
  expect(missionStack(next, focused(next).key, 'root', 'helper')).toBe(next)
})

it('gives a cold chat deep link a Work return route and leaves other routes alone', () => {
  const cold = {
    ...initial(),
    index: 0,
    routes: [{ name: MISSION_CHAT, key: 'cold', params: { missionId: 'root' } }],
  }
  const next = missionStack(cold, 'cold', 'root', undefined)
  expect(next.routes.map((route) => route.name)).toEqual(['(tabs)', MISSION_DECK, MISSION_CHAT])
  const untouched = initial()
  expect(missionStack(untouched, 'missing', 'root', undefined)).toBe(untouched)
})

it('installs the history from the mounted chat without navigating away or remounting it', () => {
  const state = push(initial(), MISSION_CHAT, { missionId: 'child' })
  const route = focused(state)
  const dispatch = vi.fn()
  const navigation = { getState: () => state, dispatch } as unknown as NonNullable<
    React.ContextType<typeof NavigationContext>
  >
  function Chat() {
    useMissionDeckReturn('root', 'remembered')
    return <div>Chat</div>
  }
  render(
    <NavigationContext value={navigation}>
      <NavigationRouteContext value={route}>
        <Chat />
      </NavigationRouteContext>
    </NavigationContext>,
  )
  expect(dispatch).toHaveBeenCalledWith({
    type: 'RESET',
    payload: expect.objectContaining({ index: 2 }),
  })
  expect(dispatch.mock.calls[0]?.[0].payload.routes[2]).toBe(route)
  expect(dispatch.mock.calls[0]?.[0].payload.routes[1].params.sessionId).toBe('remembered')
})

it('leaves web navigation history unchanged instead of inserting an unfocused deck URL', () => {
  platform.os = 'web'
  const state = push(initial(), MISSION_CHAT, { missionId: 'root' })
  const route = focused(state)
  const dispatch = vi.fn()
  const navigation = { getState: () => state, dispatch } as unknown as NonNullable<
    React.ContextType<typeof NavigationContext>
  >
  function Chat() {
    useMissionDeckReturn('root', 'remembered')
    return <div>Chat</div>
  }
  render(
    <NavigationContext value={navigation}>
      <NavigationRouteContext value={route}>
        <Chat />
      </NavigationRouteContext>
    </NavigationContext>,
  )
  expect(dispatch).not.toHaveBeenCalled()
  expect(state.routes.map((route) => route.name)).toEqual(['(tabs)', MISSION_CHAT])
})
