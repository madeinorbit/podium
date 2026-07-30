import type { ReactNode } from 'react'
import { View } from 'react-native'
import { color } from '../theme/theme'

/** Native builds retain the existing React Native root; terminal controls are web-only today. */
export function VisualViewportRoot({ children }: { children: ReactNode }) {
  return <View style={{ flex: 1, backgroundColor: color.bg }}>{children}</View>
}
