import { Host } from '@expo/ui'
import { Button, ContextMenu, RNHostView } from '@expo/ui/swift-ui'
import { StyleSheet, View } from 'react-native'
import type { MessageMenuProps } from './message-menu.types'

/**
 * THE MESSAGE CONTEXT MENU (POD-2429). Long-press lifts the message and shows
 * the system menu, as Messages does: Copy, Quote in Reply, Select Text. Select
 * Text opens the message in a native text view with real selection handles,
 * which React Native's paragraph text cannot offer in place on iOS.
 */
export function MessageMenu({ text, canQuote, onAction, children }: MessageMenuProps) {
  return (
    <Host matchContents={{ vertical: true }} style={styles.host}>
      <ContextMenu>
        <ContextMenu.Trigger>
          <RNHostView matchContents={{ vertical: true }}>
            <View
              collapsable={false}
              accessibilityActions={[
                { name: 'copy', label: 'Copy message' },
                ...(canQuote ? [{ name: 'quote', label: 'Quote in reply' }] : []),
                { name: 'select', label: 'Select text' },
              ]}
              onAccessibilityAction={(event) => {
                const name = event.nativeEvent.actionName
                if (name === 'copy' || name === 'quote' || name === 'select') onAction(text, name)
              }}
            >
              {children}
            </View>
          </RNHostView>
        </ContextMenu.Trigger>
        <ContextMenu.Items>
          <Button label="Copy" systemImage="doc.on.doc" onPress={() => onAction(text, 'copy')} />
          {canQuote ? (
            <Button
              label="Quote in Reply"
              systemImage="text.quote"
              onPress={() => onAction(text, 'quote')}
            />
          ) : null}
          <Button
            label="Select Text"
            systemImage="character.cursor.ibeam"
            onPress={() => onAction(text, 'select')}
          />
        </ContextMenu.Items>
      </ContextMenu>
    </Host>
  )
}

const styles = StyleSheet.create({
  host: { alignSelf: 'stretch' },
})
