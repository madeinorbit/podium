import { NavigationContext } from 'expo-router/build/react-navigation/core/NavigationContext'
import { NavigationRouteContext } from 'expo-router/build/react-navigation/core/NavigationProvider'
import { use, useLayoutEffect } from 'react'
import { Platform } from 'react-native'
import { missionStack } from './mission-stack'

/** Preserve task-opening seat selection, then give the native back gesture its deck. */
export function useMissionDeckReturn(missionId: string | undefined, sessionId: string | undefined) {
  const navigation = use(NavigationContext)
  const route = use(NavigationRouteContext)
  const chatKey = route?.key
  useLayoutEffect(() => {
    // Native can insert an unfocused return screen. Web history only records
    // focused URLs, so the web mission strip keeps its explicit deck push.
    if (Platform.OS === 'web' || !missionId || !navigation || !chatKey) return
    const state = navigation.getState()
    if (!state) return
    const next = missionStack(state, chatKey, missionId, sessionId)
    if (next !== state) navigation.dispatch({ type: 'RESET', payload: next })
  }, [missionId, navigation, chatKey, sessionId])
}
