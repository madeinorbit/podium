import type { AccessibilityActionInfo } from 'react-native'

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
