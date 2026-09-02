import type { AccessibilityActionInfo, AccessibilityProps } from 'react-native'

export const TASK_ROW_ACCESSIBILITY_ACTIONS: readonly AccessibilityActionInfo[] = [
  { name: 'activate', label: 'Open task' },
  { name: 'showActions', label: 'Show task actions' },
]

/** Keep VoiceOver actions on the same callbacks as tap and long press. */
export function dispatchTaskRowAccessibilityAction(
  actionName: string,
  onOpen: () => void,
  onShowActions: () => void,
): void {
  if (actionName === 'activate') onOpen()
  if (actionName === 'showActions') onShowActions()
}

/** The exact accessibility boundary spread onto every native task row. */
export function taskRowAccessibilityProps({
  seq,
  title,
  stateText,
  onOpen,
  onShowActions,
}: {
  seq: number
  title: string
  stateText?: string
  onOpen: () => void
  onShowActions: () => void
}): Pick<
  AccessibilityProps,
  'accessibilityLabel' | 'accessibilityHint' | 'accessibilityActions' | 'onAccessibilityAction'
> {
  return {
    accessibilityLabel: `Task ${seq}: ${title}${stateText ? `, ${stateText}` : ''}`,
    accessibilityHint: 'Open task, or use Actions for task actions.',
    accessibilityActions: TASK_ROW_ACCESSIBILITY_ACTIONS,
    onAccessibilityAction: (event) =>
      dispatchTaskRowAccessibilityAction(event.nativeEvent.actionName, onOpen, onShowActions),
  }
}
