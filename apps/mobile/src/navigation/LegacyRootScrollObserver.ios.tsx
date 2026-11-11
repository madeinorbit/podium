import { requireNativeView } from 'expo'
import { type ComponentType, useRef } from 'react'
import { Platform, type ViewProps } from 'react-native'
import Animated, { useEvent } from 'react-native-reanimated'
import { useRootHeader } from './root-header-context'

type ScrollEvent = { offset: number }
type ObserverProps = ViewProps & {
  revision: number
  onRootScroll?: (event: { nativeEvent: ScrollEvent }) => void
}
const NativeObserver: ComponentType<ObserverProps> = requireNativeView('PodiumRootScroll')
const Observer = Animated.createAnimatedComponent(NativeObserver)

/** Expo UI handles iOS 18+. Earlier Lists expose their UIKit offset directly. */
export function LegacyRootScrollObserver() {
  const offset = useRootHeader()?.offset
  // Rebind after a lane/search replaces the underlying native List.
  const revision = useRef(0)
  revision.current += 1
  const onRootScroll = useEvent<{ nativeEvent: ScrollEvent }>(
    (event) => {
      'worklet'
      if (offset) offset.value = event.offset
    },
    ['onRootScroll'],
  )
  if (Number.parseInt(String(Platform.Version), 10) >= 18) return null
  return (
    <Observer
      revision={revision.current}
      collapsable={false}
      pointerEvents="none"
      accessible={false}
      style={{ position: 'absolute', width: 0, height: 0 }}
      onRootScroll={onRootScroll}
    />
  )
}
