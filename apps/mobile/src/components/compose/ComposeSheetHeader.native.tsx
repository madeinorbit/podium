import { Stack } from 'expo-router/stack'
import { color } from '../../theme/theme'
import type { ComposeSheetHeaderProps } from './ComposeStartButton'

/** UIKit owns the bar, the close item and its iOS 26 glass. */
export function ComposeSheetHeader(props: ComposeSheetHeaderProps) {
  return (
    <Stack.Toolbar placement="left">
      <Stack.Toolbar.Button
        icon="xmark"
        accessibilityLabel="Cancel"
        tintColor={color.text}
        onPress={props.onCancel}
      />
    </Stack.Toolbar>
  )
}
