import type { ReactElement } from 'react'
import type { StyleProp, ViewStyle } from 'react-native'

export interface NativePickerOption {
  value: string
  label: string
  group?: string
  disabled?: boolean
}

export interface NativePickerProps {
  label: string
  options: readonly NativePickerOption[]
  selected: string
  onSelect: (value: string) => void
  onOpenFallback: () => void
  style?: StyleProp<ViewStyle>
  children: (onPress: (() => void) | undefined) => ReactElement
}

/**
 * Android and web keep their existing picker presentation. iOS resolves the
 * sibling file and supplies the trigger to a SwiftUI Menu instead.
 */
export function NativePicker({ children, onOpenFallback }: NativePickerProps) {
  return children(onOpenFallback)
}
