import { Image, type ImageSourcePropType, Modal, StyleSheet, View } from 'react-native'
import { color, radius, space } from '../theme/theme'
import { Icon } from './Icon'
import { X } from './icons'
import { PressableScale } from './PressableScale'

/** One full-screen image over a dimmed ground, closed by its X. Shared by chat
 *  attachments and inline markdown images so both open the same way. */
export function ImageLightbox({
  visible,
  source,
  label,
  onClose,
  onError,
}: {
  visible: boolean
  source: ImageSourcePropType
  label: string
  onClose(): void
  onError?: () => void
}) {
  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <View style={styles.lightbox}>
        <PressableScale
          accessibilityRole="button"
          accessibilityLabel="Close image"
          onPress={onClose}
          hitSlop={12}
          style={styles.close}
        >
          <Icon as={X} size={22} color={color.text} />
        </PressableScale>
        <Image
          source={source}
          accessibilityLabel={label}
          resizeMode="contain"
          style={styles.image}
          onError={onError}
        />
      </View>
    </Modal>
  )
}

const styles = StyleSheet.create({
  lightbox: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(0, 0, 0, 0.92)',
    padding: space.lg,
  },
  close: {
    position: 'absolute',
    top: 48,
    right: space.lg,
    zIndex: 2,
    width: 38,
    height: 38,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: radius.full,
    backgroundColor: color.surfaceHigh,
  },
  image: { width: '100%', height: '82%' },
})
