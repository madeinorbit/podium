import { Host } from '@expo/ui'
import { Button, RNHostView, Section } from '@expo/ui/swift-ui'
import { useState } from 'react'
import { StyleSheet, useWindowDimensions, View } from 'react-native'
import { space } from '../theme/theme'
import { ContextMenu } from './ContextMenu.ios'
import { MessagePreview } from './MessagePreview'
import type { MessageMenuProps } from './message-menu.types'

/**
 * THE MESSAGE CONTEXT MENU (POD-2429). Long-press lifts the message and shows
 * the system menu, as Messages does: Copy, Quote in Reply, Select Text. Select
 * Text opens the message in a native text view with real selection handles,
 * which React Native's paragraph text cannot offer in place on iOS.
 */
export function MessageMenu({
  messageId,
  text,
  timeLabel,
  canQuote,
  onAction,
  children,
}: MessageMenuProps) {
  const window = useWindowDimensions()
  const [measuredWidth, setWidth] = useState<number>()
  const [contentHeight, setContentHeight] = useState(0)
  const width = measuredWidth ?? window.width - space.lg * 2
  const actions = (
    <>
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
    </>
  )
  return (
    <View
      testID="message-menu-host"
      style={[styles.host, { minHeight: contentHeight }]}
      onLayout={(event) => setWidth(event.nativeEvent.layout.width)}
    >
      {/* The transcript owns safe areas. SwiftUI's size notification can lag
          a growing RN subtree; reserve its measured height before the next row. */}
      <Host
        ignoreSafeArea="all"
        matchContents={{ vertical: true }}
        style={{ width, minHeight: contentHeight }}
      >
        <ContextMenu key={messageId ?? text}>
          <ContextMenu.Trigger>
            <RNHostView matchContents={{ vertical: true }}>
              <View
                testID="message-menu-body"
                collapsable={false}
                style={{ width }}
                onLayout={(event) => setContentHeight(event.nativeEvent.layout.height)}
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
          <ContextMenu.Preview>
            <RNHostView matchContents>
              <MessagePreview text={text} />
            </RNHostView>
          </ContextMenu.Preview>
          <ContextMenu.Items>
            {timeLabel ? <Section title={timeLabel}>{actions}</Section> : actions}
          </ContextMenu.Items>
        </ContextMenu>
      </Host>
    </View>
  )
}

const styles = StyleSheet.create({
  host: { alignSelf: 'stretch' },
})
