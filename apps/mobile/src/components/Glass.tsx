import { StyleSheet, View } from 'react-native'
import { color } from '../theme/theme'
import { type GlassProps, glassRadius } from './glass-shape'

export type { GlassProps, GlassShape } from './glass-shape'

/** Web and Android: a solid secondary fill in the same shape as the iOS glass. */
export function Glass({ shape = 'control', style, children }: GlassProps) {
  return <View style={[styles.fill, { borderRadius: glassRadius(shape) }, style]}>{children}</View>
}

const styles = StyleSheet.create({
  fill: {
    overflow: 'hidden',
    backgroundColor: color.surface,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: color.hairlineBar,
  },
})
