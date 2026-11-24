import { useEffect } from 'react'
import { Animated, AppState, Text } from 'react-native'
import { useContentActive } from '../lib/visible-content'
import { caretStyle } from './streaming-caret-style'

const opacity = new Animated.Value(1)
let users = 0
let loop: Animated.CompositeAnimation | undefined
let subscription: { remove(): void } | undefined
function reconcile() {
  const active = users > 0 && AppState.currentState === 'active'
  if (active === !!loop) return
  loop?.stop()
  loop = undefined
  opacity.setValue(1)
  if (active) {
    loop = Animated.loop(
      Animated.sequence([
        Animated.timing(opacity, {
          toValue: 0.25,
          duration: 520,
          useNativeDriver: true,
          isInteraction: false,
        }),
        Animated.timing(opacity, {
          toValue: 1,
          duration: 520,
          useNativeDriver: true,
          isInteraction: false,
        }),
      ]),
    )
    loop.start()
  }
}
function subscribe() {
  if (++users === 1) subscription = AppState.addEventListener('change', reconcile)
  reconcile()
  let released = false
  return () => {
    if (released) return
    released = true
    if (--users === 0) {
      subscription?.remove()
      subscription = undefined
    }
    reconcile()
  }
}

/** Web and Android: one shared native-driver opacity loop. */
export function CaretMotion({ reduceMotion }: { reduceMotion: boolean }) {
  const active = useContentActive() && !reduceMotion
  useEffect(() => (active ? subscribe() : undefined), [active])
  return active ? (
    <Animated.Text testID="streaming-caret" style={[caretStyle, { opacity }]}>
      ▋
    </Animated.Text>
  ) : (
    <Text testID="streaming-caret" style={caretStyle}>
      ▋
    </Text>
  )
}
