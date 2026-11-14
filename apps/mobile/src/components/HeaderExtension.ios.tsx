import { BlurView } from 'expo-blur'
import { isLiquidGlassAvailable } from 'expo-glass-effect'
import { View } from 'react-native'
import { Glass } from './Glass'
import type { HeaderExtensionProps } from './HeaderExtension'

const liquidGlass = isLiquidGlassAvailable()

/**
 * A strip that belongs to the header (the mission status bar under the nav
 * bar). On iOS 26 it draws no material of its own: the native pager makes it a
 * scroll-edge container of the page's list (`header-extension`), so the
 * system's soft edge runs under the nav bar and this strip as one, like
 * Messages' header. Earlier systems keep the glass strip.
 */
export function HeaderExtension({ style, children }: HeaderExtensionProps) {
  if (!liquidGlass) return <Glass style={style}>{children}</Glass>
  return (
    <View testID="header-extension" collapsable={false} style={style}>
      {children}
    </View>
  )
}

/**
 * The system bar material behind the nav bar's region of a page whose list
 * scrolls under it but takes no edge effect from inside the pager: the deck,
 * a SwiftUI list. Draws the bar backing iOS draws for a classic navigation
 * bar; takes no touches.
 */
export function HeaderBand({ height }: { height: number }) {
  if (height <= 0) return null
  return (
    <BlurView
      pointerEvents="none"
      tint="systemChromeMaterial"
      intensity={100}
      style={{ position: 'absolute', top: 0, left: 0, right: 0, height }}
    />
  )
}
