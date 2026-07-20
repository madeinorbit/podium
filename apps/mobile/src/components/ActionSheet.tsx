import { useEffect, useRef, useState } from 'react'
import { Animated, Modal, Platform, Pressable, StyleSheet, Text, View } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { color, elevation, font, monoLabel, radius, sans, space } from '../theme/theme'

export interface SheetAction {
  label: string
  destructive?: boolean
  onPress: () => void
}

/**
 * Bottom sheet with the manners of the native platform sheet: slide-up spring,
 * dimmed backdrop, drag handle, grouped actions. Pure RN (works on web too).
 */
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
  const slide = useRef(new Animated.Value(0)).current
  const [mounted, setMounted] = useState(visible)

  useEffect(() => {
    if (visible) {
      setMounted(true)
      Animated.spring(slide, {
        toValue: 1,
        useNativeDriver: Platform.OS !== 'web',
        speed: 18,
        bounciness: 4,
      }).start()
    } else {
      Animated.timing(slide, {
        toValue: 0,
        duration: 160,
        useNativeDriver: Platform.OS !== 'web',
      }).start(() => setMounted(false))
    }
  }, [visible, slide])

  if (!mounted) return null

  const translateY = slide.interpolate({ inputRange: [0, 1], outputRange: [320, 0] })

  return (
    <Modal visible transparent animationType="none" onRequestClose={onClose}>
      <Animated.View style={[styles.backdrop, { opacity: slide }]}>
        <Pressable
          accessibilityLabel="Close menu"
          style={StyleSheet.absoluteFill}
          onPress={onClose}
        />
      </Animated.View>
      <Animated.View
        style={[
          styles.sheet,
          elevation.raised,
          { paddingBottom: insets.bottom + space.lg, transform: [{ translateY }] },
        ]}
      >
        <View style={styles.handle} />
        {title ? (
          <Text style={styles.title} numberOfLines={1}>
            {title}
          </Text>
        ) : null}
        <View style={styles.group}>
          {actions.map((action, i) => (
            <Pressable
              key={action.label}
              accessibilityRole="button"
              accessibilityLabel={action.label}
              onPress={() => {
                onClose()
                action.onPress()
              }}
              style={({ pressed }) => [
                styles.action,
                i > 0 && styles.actionDivider,
                pressed && styles.actionPressed,
              ]}
            >
              <Text style={[styles.actionText, action.destructive && styles.destructive]}>
                {action.label}
              </Text>
            </Pressable>
          ))}
        </View>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Cancel"
          onPress={onClose}
          style={({ pressed }) => [styles.cancel, pressed && styles.actionPressed]}
        >
          <Text style={styles.cancelText}>Cancel</Text>
        </Pressable>
      </Animated.View>
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
    backgroundColor: 'rgba(4,5,8,0.6)',
  },
  sheet: {
    position: 'absolute',
    left: space.sm,
    right: space.sm,
    bottom: 0,
    backgroundColor: color.surfaceHigh,
    borderRadius: radius.xl,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: color.borderStrong,
    paddingTop: space.sm,
    paddingHorizontal: space.md,
  },
  handle: {
    alignSelf: 'center',
    width: 36,
    height: 4,
    borderRadius: radius.full,
    backgroundColor: color.borderStrong,
    marginBottom: space.sm,
  },
  title: {
    ...monoLabel(9),
    color: color.textMicro,
    textAlign: 'center',
    marginBottom: space.sm,
  },
  group: {
    backgroundColor: color.surface,
    borderRadius: radius.md,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: color.border,
    overflow: 'hidden',
  },
  action: {
    paddingVertical: 14,
    alignItems: 'center',
  },
  actionDivider: {
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: color.hairline,
  },
  actionPressed: {
    backgroundColor: color.surfacePressed,
  },
  actionText: {
    ...sans(600),
    color: color.text,
    fontSize: font.body,
  },
  destructive: {
    color: color.danger,
  },
  cancel: {
    marginTop: space.sm,
    paddingVertical: 13,
    alignItems: 'center',
    borderRadius: radius.md,
  },
  cancelText: {
    ...sans(600),
    color: color.textDim,
    fontSize: font.body,
  },
})
