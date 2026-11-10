import { BlurView } from 'expo-blur'
import type { ReactNode } from 'react'
import { Platform, type StyleProp, StyleSheet, View, type ViewStyle } from 'react-native'
import { alpha } from '../theme/mix'
import { color } from '../theme/theme'

/**
 * The composer's own glass piece (POD-2380).
 *
 * TEMPORARY MATERIAL: the redesign's shared Glass helper (Shell task, POD-2372)
 * draws Liquid Glass through expo-glass-effect with an `isLiquidGlassAvailable()`
 * fallback. That package is not installed yet, so this wraps the system chrome
 * material on iOS and a tinted blur elsewhere; swapping in the helper is a
 * change to this file only.
 */
export function ComposerGlass({
  style,
  testID,
  children,
}: {
  style?: StyleProp<ViewStyle>
  testID?: string
  children: ReactNode
}) {
  const ios = Platform.OS === 'ios'
  return (
    <BlurView
      intensity={ios ? 80 : 32}
      tint={ios ? 'systemChromeMaterial' : 'dark'}
      testID={testID}
      style={style}
    >
      {/* The system material carries its own tint; elsewhere the blur needs one
          to sit on, or a coloured card passing underneath tints the capsule. */}
      {ios ? null : <View style={styles.fill} pointerEvents="none" />}
      {children}
    </BlurView>
  )
}

const styles = StyleSheet.create({
  fill: {
    ...StyleSheet.absoluteFill,
    backgroundColor: alpha(color.bg, 0.72),
  },
})
