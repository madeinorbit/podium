import { StyleSheet, Text, View } from 'react-native'
import { color, font, sans, space } from '../theme/theme'
import { Icon } from './Icon'
import { Reply, X } from './icons'
import { PressableScale } from './PressableScale'

/**
 * "Replying to POD-1906" with its cancel (POD-2380, board ChatReply): the line
 * above the composer's field that says the words go to the asker, in the
 * signal colour, never into the session prompt.
 */
export function ComposerReplyHeader({ asker, onCancel }: { asker: string; onCancel: () => void }) {
  return (
    <View style={styles.row} testID="composer-reply">
      <Icon as={Reply} size={14} color={color.accentTint} />
      <Text style={styles.text} numberOfLines={1}>
        Replying to {asker}
      </Text>
      <PressableScale
        accessibilityRole="button"
        accessibilityLabel="Cancel reply"
        onPress={onCancel}
        hitSlop={10}
        style={styles.cancel}
      >
        <Icon as={X} size={14} color={color.textDim} />
      </PressableScale>
    </View>
  )
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    height: 24,
    marginBottom: space.xs,
  },
  text: { ...sans(500), flex: 1, minWidth: 0, fontSize: font.tiny, color: color.accentTint },
  cancel: { width: 28, height: 24, alignItems: 'center', justifyContent: 'center' },
})
