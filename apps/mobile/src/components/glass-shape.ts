import type { ReactNode } from 'react'
import type { StyleProp, ViewStyle } from 'react-native'
import { radius } from '../theme/theme'

/** The two corner tiers our own glass pieces use: chips and buttons, or a card (the composer). */
export type GlassShape = 'control' | 'card'

export interface GlassProps {
  shape?: GlassShape
  /** Lets the system glass react to touches (pressable chips). */
  interactive?: boolean
  style?: StyleProp<ViewStyle>
  children?: ReactNode
}

export const glassRadius = (shape: GlassShape) => (shape === 'card' ? radius.card : radius.control)
