import type { ChatBlock } from '@podium/client-core/values'
import { StyleSheet, Text } from 'react-native'
import { color, sans, space } from '../theme/theme'
import { BottomSheet } from './BottomSheet'
import { ToolCallContent } from './ToolCallContent'

export default function ToolCallDetails({
  block,
  onClose,
}: {
  block: ChatBlock
  onClose: () => void
}) {
  const title =
    block.item.toolTitle ?? block.item.toolInput ?? block.item.toolName ?? 'Call details'
  return (
    <BottomSheet
      visible
      mode="detented"
      accessibilityLabel="Call details"
      onClose={onClose}
      head={
        <Text numberOfLines={2} style={styles.title}>
          {title}
        </Text>
      }
      contentStyle={styles.content}
    >
      <ToolCallContent block={block} />
    </BottomSheet>
  )
}

const styles = StyleSheet.create({
  title: { ...sans(600), color: color.text, fontSize: 15, lineHeight: 20, padding: space.md },
  content: { padding: space.md },
})
