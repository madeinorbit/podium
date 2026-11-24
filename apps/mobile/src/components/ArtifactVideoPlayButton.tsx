import { Pressable, StyleSheet, View } from 'react-native'
import { Icon } from './Icon'
import type { AppIcon } from './icons'

const play: AppIcon = { ios: 'play.fill', android: 'play_arrow', web: 'play_arrow' }

/** The first frame stays visible behind an explicit, accessible playback action. */
export function ArtifactVideoPlayButton({
  label,
  onPress,
}: {
  label: string
  onPress: () => void
}) {
  return (
    <View style={styles.overlay}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`Play ${label}`}
        onPress={onPress}
        style={({ pressed }) => [styles.button, pressed && styles.pressed]}
      >
        <Icon as={play} size={32} color="#fff" />
      </Pressable>
    </View>
  )
}

const styles = StyleSheet.create({
  overlay: {
    ...StyleSheet.absoluteFill,
    pointerEvents: 'box-none',
    alignItems: 'center',
    justifyContent: 'center',
  },
  button: {
    width: 56,
    height: 56,
    borderRadius: 6,
    backgroundColor: 'rgba(0, 0, 0, 0.6)',
    alignItems: 'center',
    justifyContent: 'center',
    paddingLeft: 4,
  },
  pressed: { opacity: 0.7 },
})
