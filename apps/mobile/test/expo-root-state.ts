import { INTERNAL_SLOT_NAME } from 'expo-router/build/constants'
import { StackRouter } from 'expo-router/build/react-navigation/routers/StackRouter'
import type { NavigationState, PartialState } from 'expo-router/react-navigation'

/** ExpoRoot.Content mounts the app layout inside this outer Stack's __root slot. */
export function expoRootStateReader(
  readAppState: () => NavigationState | PartialState<NavigationState>,
) {
  const root = StackRouter({ initialRouteName: INTERNAL_SLOT_NAME }).getInitialState({
    routeNames: [INTERNAL_SLOT_NAME],
    routeParamList: {},
    routeGetIdList: {},
  })
  const slot = root.routes[0]
  if (!slot) throw new Error('Missing Expo root slot')
  return (): NavigationState => ({
    ...root,
    routes: [{ ...slot, state: readAppState() }],
  })
}
