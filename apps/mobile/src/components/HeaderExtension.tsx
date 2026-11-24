import type { StyleProp, ViewStyle } from 'react-native'
import { Glass } from './Glass'

export interface HeaderExtensionProps {
  style?: StyleProp<ViewStyle>
  children?: React.ReactNode
}

/**
 * A strip that belongs to the header (the mission status bar under the nav
 * bar). Off iOS 26 it is our own glass, so text scrolling under it stays
 * behind a material.
 */
export function HeaderExtension({ style, children }: HeaderExtensionProps) {
  return <Glass style={style}>{children}</Glass>
}

/** iOS only: other platforms draw an opaque app bar above the page. */
export function HeaderBand(_props: { height: number }) {
  return null
}
