import { Modal, Pressable, StyleSheet, Text, View } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { color, font, radius, space } from '../theme/theme'

export interface SheetAction {
  label: string
  destructive?: boolean
  onPress: () => void
}

/** Bottom action sheet built on Modal — no native dependency, works on web. */
export function ActionSheet({
  visible,
  title,
  actions,
  onClose,
}: {
  visible: boolean
  title?: string
  actions: SheetAction[]
  onClose: () => void
}) {
  const insets = useSafeAreaInsets()
  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <Pressable accessibilityLabel="Close menu" style={styles.backdrop} onPress={onClose}>
        <View />
      </Pressable>
      <View style={[styles.sheet, { paddingBottom: insets.bottom + space.md }]}>
        {title ? <Text style={styles.title}>{title}</Text> : null}
        {actions.map((action) => (
          <Pressable
            key={action.label}
            accessibilityRole="button"
            accessibilityLabel={action.label}
            onPress={() => {
              onClose()
              action.onPress()
            }}
            style={({ pressed }) => [styles.action, pressed && styles.actionPressed]}
          >
            <Text style={[styles.actionText, action.destructive && styles.destructive]}>
              {action.label}
            </Text>
          </Pressable>
        ))}
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Cancel"
          onPress={onClose}
          style={({ pressed }) => [styles.action, styles.cancel, pressed && styles.actionPressed]}
        >
          <Text style={styles.cancelText}>Cancel</Text>
        </Pressable>
      </View>
    </Modal>
  )
}

const styles = StyleSheet.create({
  backdrop: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: 'rgba(0,0,0,0.55)',
  },
  sheet: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: color.bgRaised,
    borderTopLeftRadius: radius.lg,
    borderTopRightRadius: radius.lg,
    paddingTop: space.md,
    paddingHorizontal: space.md,
    gap: space.xs,
  },
  title: {
    color: color.textFaint,
    fontSize: font.tiny,
    fontWeight: '700',
    letterSpacing: 1,
    textTransform: 'uppercase',
    textAlign: 'center',
    marginBottom: space.sm,
  },
  action: {
    backgroundColor: color.card,
    borderRadius: radius.sm,
    paddingVertical: space.md,
    alignItems: 'center',
  },
  actionPressed: {
    backgroundColor: color.cardPressed,
  },
  actionText: {
    color: color.text,
    fontSize: font.body,
    fontWeight: '600',
  },
  destructive: {
    color: color.danger,
  },
  cancel: {
    backgroundColor: 'transparent',
    marginTop: space.xs,
  },
  cancelText: {
    color: color.textDim,
    fontSize: font.body,
    fontWeight: '600',
  },
})
