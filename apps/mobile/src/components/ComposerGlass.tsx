import type { ReactNode } from 'react'
import { type StyleProp, StyleSheet, View, type ViewStyle } from 'react-native'
import { Glass } from './Glass'

/**
 * The composer's own glass piece (POD-2380), drawn by the shared Glass helper
 * (POD-2376): real Liquid Glass on iOS 26, the system material blur before it,
 * a solid fill off iOS.
 *
 * The glass is a BACKGROUND LAYER under the composer's content rather than its
 * container, so the composer keeps its own padding, hairline, test id and the
 * board's 14pt corner (taller than the helper's card tier) without the helper
 * learning about any of them.
 */
export function ComposerGlass({
  style,
  radius,
  testID,
  children,
}: {
  style?: StyleProp<ViewStyle>
  /** The composer's corner; the glass layer follows it. */
  radius: number
  testID?: string
  children: ReactNode
}) {
  return (
    <View testID={testID} style={style}>
      <View style={[StyleSheet.absoluteFill, { borderRadius: radius }]} pointerEvents="none">
        <Glass shape="card" style={[StyleSheet.absoluteFill, { borderRadius: radius }]} />
      </View>
      {children}
    </View>
  )
}
