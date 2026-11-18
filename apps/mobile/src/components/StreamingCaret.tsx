import { useEffect } from 'react'
import { Animated, AppState, StyleSheet, Text } from 'react-native'
import { useContentActive } from '../lib/visible-content'
import { color, font, mono } from '../theme/theme'
import { ActivityLine } from './transcript-activity'

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

export function StreamingCaret({ reduceMotion }: { reduceMotion: boolean }) {
  return (
    <ActivityLine testID="streaming-caret-line">
      <CaretMotion reduceMotion={reduceMotion} />
    </ActivityLine>
  )
}
function CaretMotion({ reduceMotion }: { reduceMotion: boolean }) {
  const active = useContentActive() && !reduceMotion
  useEffect(() => (active ? subscribe() : undefined), [active])
  return active ? (
    <Animated.Text testID="streaming-caret" style={[styles.caret, { opacity }]}>
      ▋
    </Animated.Text>
  ) : (
    <Text testID="streaming-caret" style={styles.caret}>
      ▋
    </Text>
  )
}
const styles = StyleSheet.create({
  caret: { ...mono(700), color: color.accentTint, fontSize: font.small, marginTop: 2 },
})
