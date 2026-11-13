import { LinearGradient } from 'expo-linear-gradient'
import { useState } from 'react'
import { StyleSheet, useWindowDimensions, View } from 'react-native'
import { color, radius, space } from '../theme/theme'
import { RichMarkdown } from './RichMarkdown'

/** The system menu lifts a separate, bounded copy instead of the feed row. */
export function MessagePreview({ text }: { text: string }) {
  const { width, height } = useWindowDimensions()
  const maxHeight = Math.min(360, height * 0.45)
  const [overflow, setOverflow] = useState(false)
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
        <RichMarkdown text={text} selectable={false} />
      </View>
      {overflow ? (
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
  fade: { position: 'absolute', bottom: 0, left: 0, right: 0, height: 40 },
})
