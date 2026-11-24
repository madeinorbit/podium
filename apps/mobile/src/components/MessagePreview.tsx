import { markdownPlainText } from '@podium/client-core/markdown-plain-text'
import { LinearGradient } from 'expo-linear-gradient'
import { useMemo, useState } from 'react'
import { StyleSheet, Text, useWindowDimensions, View } from 'react-native'
import { color, font, leading, radius, sans, space } from '../theme/theme'

const PREVIEW_CHAR_LIMIT = 2048

/** The system menu lifts a separate, bounded copy instead of the feed row. */
export function MessagePreview({ text }: { text: string }) {
  const { width, height } = useWindowDimensions()
  const maxHeight = Math.min(360, height * 0.45)
  const [overflow, setOverflow] = useState(false)
  // ContextMenu mounts its React preview before presentation. Bound parsing and
  // native text; never duplicate images, highlighting or reference subscriptions.
  const preview = useMemo(() => markdownPlainText(text.slice(0, PREVIEW_CHAR_LIMIT)), [text])
  return (
    <View
      testID="message-preview"
      style={[styles.card, { width: Math.min(560, width - 48), maxHeight }]}
    >
      <View
        onLayout={(event) =>
          setOverflow(event.nativeEvent.layout.height > maxHeight - space.lg * 2)
        }
        style={styles.body}
      >
        <Text style={styles.text} numberOfLines={20}>
          {preview}
          {text.length > PREVIEW_CHAR_LIMIT ? '…' : ''}
        </Text>
      </View>
      {overflow || text.length > PREVIEW_CHAR_LIMIT ? (
        <LinearGradient
          pointerEvents="none"
          colors={[color.clear, color.bgRaised]}
          style={styles.fade}
        />
      ) : null}
    </View>
  )
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: color.bgRaised,
    borderRadius: radius.card,
    overflow: 'hidden',
    padding: space.lg,
  },
  body: { flexShrink: 0 },
  text: {
    ...sans(400),
    color: color.text,
    fontSize: font.body,
    lineHeight: leading(font.body, 'prose'),
  },
  fade: { position: 'absolute', bottom: 0, left: 0, right: 0, height: 40 },
})
