import { BlurView } from 'expo-blur'
import { GlassView, isLiquidGlassAvailable } from 'expo-glass-effect'
import { StyleSheet } from 'react-native'
import { color } from '../theme/theme'
import { type GlassProps, glassRadius } from './glass-shape'

export type { GlassProps, GlassShape } from './glass-shape'

const liquidGlass = isLiquidGlassAvailable()

/**
 * Our own glass pieces (composer, chips). iOS 26 draws real Liquid Glass;
 * earlier systems get the system material blur in the same shape.
 */
export function Glass({ shape = 'control', interactive, style, children }: GlassProps) {
  const corner = { borderRadius: glassRadius(shape) }
  if (liquidGlass) {
    return (
      <GlassView glassEffectStyle="regular" isInteractive={interactive} style={[corner, style]}>
        {children}
      </GlassView>
    )
  }
  return (
    <BlurView tint="systemChromeMaterial" intensity={80} style={[styles.blur, corner, style]}>
      {children}
    </BlurView>
  )
}

const styles = StyleSheet.create({
  blur: {
    overflow: 'hidden',
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: color.hairlineBar,
  },
})
