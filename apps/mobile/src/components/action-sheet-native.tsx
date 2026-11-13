import type { NativePickerProps } from './action-sheet-spec'

export type { NativePickerOption, NativePickerProps } from './action-sheet-spec'

/** Android and web retain the existing BottomSheet picker. Keep this extension
 * aligned with the iOS entry so Metro checks the platform before the fallback. */
export function NativePicker({ children, onOpenFallback }: NativePickerProps) {
  return children(onOpenFallback)
}
