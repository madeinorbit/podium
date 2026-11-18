import { type ImageSourcePropType, StyleSheet, View } from 'react-native'
import { GestureHandlerRootView } from 'react-native-gesture-handler'
import { useDismissOnRootLeave } from '../navigation/use-dismiss-on-root-leave'
import { color, radius, space } from '../theme/theme'
import { ActivityModal as Modal } from './ActivityModal'
import { Icon } from './Icon'
import { X } from './icons'
import { PressableScale } from './PressableScale'
import { ZoomableImage } from './ZoomableImage'

/** One full-screen image over a dimmed ground, closed by its X. Shared by chat
 *  attachments and inline markdown images so both open the same way, and
 *  zoomable like the artifact viewer's images (pinch, double tap, pan). */
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
  useDismissOnRootLeave(onClose, visible)
  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <GestureHandlerRootView style={styles.lightbox}>
        <PressableScale
          accessibilityRole="button"
          accessibilityLabel="Close image"
          onPress={onClose}
          hitSlop={12}
          style={styles.close}
        >
          <Icon as={X} size={22} color={color.text} />
        </PressableScale>
        <View style={styles.image}>
          <ZoomableImage source={source} label={label} {...(onError ? { onError } : {})} />
        </View>
      </GestureHandlerRootView>
    </Modal>
  )
}

const styles = StyleSheet.create({
  lightbox: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(0, 0, 0, 0.92)',
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
  /** Edge to edge: zoomed, the image pans under the close button. */
  image: { width: '100%', height: '100%' },
})
