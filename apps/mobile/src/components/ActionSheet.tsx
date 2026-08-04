import { useEffect, useMemo, useRef, useState } from 'react'
import {
  Animated,
  Modal,
  PanResponder,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { color, elevation, font, leading, monoLabel, radius, sans, space } from '../theme/theme'
import { PressableScale } from './PressableScale'

/** How far the sheet travels when opening — and the drag distance that dismisses it. */
const SHEET_TRAVEL = 320

export interface SheetAction {
  label: string
  /** One line under the label, for a choice the label alone can't settle
   *  (e.g. task vs bare session — where the work ends up differs). */
  hint?: string
  destructive?: boolean
  disabled?: boolean
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
    slide.stopAnimation()
    if (visible) {
      setMounted(true)
      const opening = Animated.spring(slide, {
        toValue: 1,
        // JS driver on purpose: the drag below feeds the same transform via
        // PanResponder.setValue, which a native-driven node rejects.
        useNativeDriver: false,
        speed: 18,
        bounciness: 4,
      })
      opening.start()
      return () => opening.stop()
    }

    const closing = Animated.timing(slide, {
      toValue: 0,
      duration: 160,
      useNativeDriver: false,
    })
    closing.start(({ finished }) => {
      if (finished) setMounted(false)
    })
    return () => closing.stop()
  }, [visible, slide])

  // The sheet drew the 36×4 grab pill that means "drag me down" on every native
  // sheet, and ignored the gesture [POD-366]. Now it tracks the finger: past a
  // third of its travel, or on a fast flick, it dismisses; otherwise it springs
  // back. Downward drags only — an upward pull must not lift it off the edge.
  const drag = useRef(new Animated.Value(0)).current
  const pan = useMemo(
    () =>
      PanResponder.create({
        onMoveShouldSetPanResponder: (_e, g) => g.dy > 4 && Math.abs(g.dy) > Math.abs(g.dx),
        onPanResponderMove: (_e, g) => {
          if (g.dy > 0) drag.setValue(g.dy)
        },
        onPanResponderRelease: (_e, g) => {
          if (g.dy > SHEET_TRAVEL / 3 || g.vy > 0.8) {
            onClose()
            return
          }
          Animated.spring(drag, {
            toValue: 0,
            useNativeDriver: false,
            speed: 20,
            bounciness: 6,
          }).start()
        },
        onPanResponderTerminate: () => {
          drag.setValue(0)
        },
      }),
    [drag, onClose],
  )

  useEffect(() => {
    if (visible) drag.setValue(0)
  }, [visible, drag])

  if (!mounted) return null

  const translateY = Animated.add(
    slide.interpolate({ inputRange: [0, 1], outputRange: [SHEET_TRAVEL, 0] }),
    drag,
  )

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
        <View style={styles.handleZone} {...pan.panHandlers}>
          <View style={styles.handle} />
        </View>
        {title ? (
          <Text style={styles.title} numberOfLines={1}>
            {title}
          </Text>
        ) : null}
        <View style={styles.group}>
          {actions.map((action, i) => (
            <PressableScale
              key={action.label}
              accessibilityRole="button"
              accessibilityLabel={action.label}
              {...(action.hint ? { accessibilityHint: action.hint } : {})}
              accessibilityState={{ disabled: action.disabled }}
              disabled={action.disabled}
              onPress={() => {
                onClose()
                action.onPress()
              }}
              style={({ pressed }) => [
                styles.action,
                i > 0 && styles.actionDivider,
                action.disabled && styles.actionDisabled,
                pressed && styles.actionPressed,
              ]}
            >
              <Text style={[styles.actionText, action.destructive && styles.destructive]}>
                {action.label}
              </Text>
              {action.hint ? <Text style={styles.actionHint}>{action.hint}</Text> : null}
            </PressableScale>
          ))}
        </View>
        <PressableScale
          accessibilityRole="button"
          accessibilityLabel="Cancel"
          onPress={onClose}
          style={({ pressed }) => [styles.cancel, pressed && styles.actionPressed]}
        >
          <Text style={styles.cancelText}>Cancel</Text>
        </PressableScale>
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
  // The grab target is the whole strip above the actions, not the 4px pill.
  handleZone: {
    alignSelf: 'stretch',
    alignItems: 'center',
    paddingTop: 2,
    paddingBottom: space.sm,
  },
  handle: {
    width: 36,
    height: 4,
    borderRadius: radius.full,
    backgroundColor: color.borderStrong,
  },
  title: {
    ...monoLabel(),
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
    paddingHorizontal: space.lg,
    alignItems: 'center',
    gap: 3,
  },
  actionDivider: {
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: color.hairline,
  },
  actionPressed: {
    backgroundColor: color.surfacePressed,
  },
  actionDisabled: {
    opacity: 0.38,
  },
  actionText: {
    ...sans(600),
    color: color.text,
    fontSize: font.body,
  },
  actionHint: {
    ...sans(400),
    color: color.textFaint,
    fontSize: font.tiny,
    lineHeight: leading(font.tiny),
    textAlign: 'center',
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
