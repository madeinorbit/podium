import type { NativeStackNavigationProp } from 'expo-router'
import { NavigationContext } from 'expo-router/build/react-navigation/core/NavigationContext'
import { NavigationRouteContext } from 'expo-router/build/react-navigation/core/NavigationProvider'
import type { ParamListBase } from 'expo-router/react-navigation'
import { use, useLayoutEffect, useRef } from 'react'
import { Platform } from 'react-native'
import { missionStack } from './mission-stack'

/** Preserve task-opening seat selection, then give the native back gesture its deck. */
export function useMissionDeckReturn(missionId: string | undefined, sessionId: string | undefined) {
  const navigation = use(NavigationContext) as NativeStackNavigationProp<ParamListBase> | undefined
  const route = use(NavigationRouteContext)
  const chatKey = route?.key
  const entered = useRef(false)
  useLayoutEffect(() => {
    // Native can insert an unfocused return screen. Web history only records
    // focused URLs, so the web mission strip keeps its explicit deck push.
    if (Platform.OS === 'web' || !navigation || !chatKey) return
    const install = () => {
      if (!missionId) return
      const state = navigation.getState()
      if (!state) return
      const next = missionStack(state, chatKey, missionId, sessionId)
      if (next !== state) navigation.dispatch({ type: 'RESET', payload: next })
    }
    // Changing the native controller stack during its push can briefly present
    // the inserted deck. Keep the chat's push intact, then install its Back
    // destination with the same mounted chat key. A cold deep link has no push.
    const initialRoute = navigation.getState()?.routes[0]?.key === chatKey
    const unsubscribe = navigation.addListener?.('transitionEnd', (event) => {
      if (event.data.closing) return
      entered.current = true
      install()
    })
    if (entered.current || initialRoute) install()
    return unsubscribe
  }, [missionId, navigation, chatKey, sessionId])
}
