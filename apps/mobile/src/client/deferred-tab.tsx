import { type ComponentType, useSyncExternalStore } from 'react'
import { View } from 'react-native'
import { color } from '../theme/theme'
import { firstRouteReached, subscribeFirstRoute } from './first-route'
import { useProjectionFocus } from './projection-focus'

/**
 * A tab that is not on screen at launch renders after the first route has laid
 * out (POD-2666). Native tabs mount every tab at once, so Tasks' rows, Pulse and
 * Settings otherwise rendered on the JS thread while Work drew its first frame.
 * The focused tab renders at once, including a launch restored onto it.
 */
export function deferredUntilFirstRoute<P extends object>(Screen: ComponentType<P>) {
  function DeferredTab(props: P) {
    const focused = useProjectionFocus()
    const reached = useSyncExternalStore(subscribeFirstRoute, firstRouteReached, firstRouteReached)
    if (!focused && !reached) return <View style={{ flex: 1, backgroundColor: color.bg }} />
    return <Screen {...props} />
  }
  DeferredTab.displayName = `Deferred(${Screen.displayName ?? Screen.name ?? 'Screen'})`
  return DeferredTab
}
