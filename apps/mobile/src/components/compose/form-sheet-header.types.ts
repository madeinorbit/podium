import { adaptiveColor } from '../../theme/theme'

export interface FormSheetHeaderProps {
  title: string
  confirmLabel: string
  /** Spoken name when the visible label is terse ("Start" → "Start agent"). */
  confirmAccessibilityLabel?: string
  busyLabel?: string
  canConfirm: boolean
  busy: boolean
  onCancel: () => void
  onConfirm: () => void
}

/** The app's prominent fill: the New Task start button's tinted glass. */
export const formSheetConfirmTint = adaptiveColor('#a8762a', '#d9b477', '#81591b', '#e1c392')
export const formSheetConfirmInk = adaptiveColor('#ffffff', '#16171a', '#ffffff', '#16171a')
/** UIKit draws its own label on a prominent bar item and only follows the
 * fill, so the native button keeps the deeper gold in dark mode as well: the
 * light gold there gets a grey label that reads as disabled. */
export const formSheetNativeConfirmTint = adaptiveColor('#a8762a', '#a8762a', '#81591b', '#81591b')
