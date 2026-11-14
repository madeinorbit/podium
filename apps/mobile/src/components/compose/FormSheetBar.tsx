import { StyleSheet, Text, View } from 'react-native'
import { color, sans } from '../../theme/theme'
import { PressableScale } from '../PressableScale'
import {
  type FormSheetHeaderProps,
  formSheetConfirmInk,
  formSheetConfirmTint,
} from './form-sheet-header.types'

/**
 * A sheet's navigation row drawn in React Native: Cancel, the title, and a
 * prominent confirm, as UIKit lays out a sheet's bar. Sheets that are not a
 * navigation route (an RN modal) use it on every platform; route sheets use it
 * only off iOS, where `FormSheetHeader.native` hands the bar to UIKit.
 */
type Confirm = 'confirmLabel' | 'onConfirm' | 'canConfirm' | 'busy'
/** A picker sheet has no confirm: choosing a row is the action. */
export type FormSheetBarProps = Omit<FormSheetHeaderProps, Confirm> &
  Partial<Pick<FormSheetHeaderProps, Confirm>>

export function FormSheetBar(props: FormSheetBarProps) {
  const enabled = !!props.canConfirm && !props.busy
  return (
    <View style={styles.bar}>
      <PressableScale
        accessibilityRole="button"
        accessibilityLabel="Cancel"
        disabled={props.busy}
        onPress={props.onCancel}
        style={styles.side}
      >
        <Text style={styles.cancel}>Cancel</Text>
      </PressableScale>
      <Text pointerEvents="none" style={styles.title} numberOfLines={1}>
        {props.title}
      </Text>
      {props.onConfirm && props.confirmLabel ? (
        <PressableScale
          accessibilityRole="button"
          accessibilityLabel={props.confirmAccessibilityLabel ?? props.confirmLabel}
          accessibilityState={{ disabled: !enabled }}
          disabled={!enabled}
          onPress={props.onConfirm}
          style={[styles.side, styles.confirm, !enabled && styles.confirmOff]}
        >
          <Text style={[styles.confirmText, !enabled && styles.confirmTextOff]}>
            {props.busy ? (props.busyLabel ?? props.confirmLabel) : props.confirmLabel}
          </Text>
        </PressableScale>
      ) : (
        <View style={styles.side} />
      )}
    </View>
  )
}

const styles = StyleSheet.create({
  bar: {
    minHeight: 56,
    paddingHorizontal: 16,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 12,
  },
  side: { minHeight: 44, minWidth: 44, justifyContent: 'center' },
  cancel: { ...sans(400), color: color.text, fontSize: 17 },
  // Centred on the sheet, not between two buttons of different widths.
  title: {
    ...sans(600),
    position: 'absolute',
    left: 104,
    right: 104,
    textAlign: 'center',
    color: color.text,
    fontSize: 17,
  },
  confirm: {
    minHeight: 36,
    paddingHorizontal: 16,
    borderRadius: 18,
    alignItems: 'center',
    backgroundColor: formSheetConfirmTint,
  },
  confirmOff: { backgroundColor: color.quaternaryFill },
  confirmText: { ...sans(600), color: formSheetConfirmInk, fontSize: 17 },
  confirmTextOff: { color: color.textMicro },
})
