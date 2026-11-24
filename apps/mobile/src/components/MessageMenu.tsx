import * as Haptics from 'expo-haptics'
import { Pressable } from 'react-native'
import type { MessageMenuProps } from './message-menu.types'

/**
 * Long-press on a message opens the host's message sheet (Copy, Quote in
 * reply, Select Text). iOS draws a native context menu instead
 * (MessageMenu.ios.tsx).
 */
export function MessageMenu({ text, onAction, children }: MessageMenuProps) {
  return (
    <Pressable
      accessibilityActions={[
        { name: 'copy', label: 'Copy message' },
        { name: 'quote', label: 'Quote in reply' },
      ]}
      onAccessibilityAction={() => onAction(text)}
      onLongPress={() => {
        void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => {})
        onAction(text)
      }}
      delayLongPress={350}
    >
      {children}
    </Pressable>
  )
}
