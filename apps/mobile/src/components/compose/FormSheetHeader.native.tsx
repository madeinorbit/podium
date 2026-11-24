import { Stack } from 'expo-router/stack'
import { color } from '../../theme/theme'
import { type FormSheetHeaderProps, formSheetNativeConfirmTint } from './form-sheet-header.types'

/** UIKit owns the bar: a Cancel item on the left and a prominent confirm on
 * the right, the same chrome the New Task sheet uses for its close item. */
export function FormSheetHeader(props: FormSheetHeaderProps) {
  const enabled = props.canConfirm && !props.busy
  return (
    <>
      <Stack.Screen options={{ title: props.title }} />
      <Stack.Toolbar placement="left">
        <Stack.Toolbar.Button
          icon="xmark"
          accessibilityLabel="Cancel"
          tintColor={color.text}
          disabled={props.busy}
          onPress={props.onCancel}
        />
      </Stack.Toolbar>
      <Stack.Toolbar placement="right">
        <Stack.Toolbar.Button
          variant="prominent"
          accessibilityLabel={props.confirmAccessibilityLabel ?? props.confirmLabel}
          tintColor={enabled ? formSheetNativeConfirmTint : undefined}
          style={{ fontWeight: '600' }}
          disabled={!enabled}
          onPress={props.onConfirm}
        >
          {props.busy ? (props.busyLabel ?? props.confirmLabel) : props.confirmLabel}
        </Stack.Toolbar.Button>
      </Stack.Toolbar>
    </>
  )
}
