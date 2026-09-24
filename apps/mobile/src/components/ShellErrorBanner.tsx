import { StyleSheet, Text, View } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { useMobileShell } from '../client/shell'
import { color, elevation, font, leading, radius, sans, space } from '../theme/theme'
import { Icon } from './Icon'
import { AlertTriangle, X } from './icons'
import { PressableScale } from './PressableScale'

/**
 * THE ONE PLACE A PHONE ERROR NOTICE IS SHOWN (POD-4662).
 *
 * Every engine `notices.error` lands in `shell.error` — a message not sent
 * because its session was deleted (POD-4660), a change the server refused, a
 * fatal store error. The only reader of that field used to be the Inbox
 * screen, which no route mounts, so every one of them was invisible. This
 * banner is mounted once, over every route, by the composition root
 * (`MobileShellSurface`), so a notice shows on whatever screen the operator is
 * on — including the session screen of the session that was just deleted.
 *
 * It stays until dismissed: the phone may be in a pocket when a queued send is
 * answered, and a timed toast would be gone before anyone looked.
 */
export function ShellErrorBanner() {
  const { error } = useMobileShell()
  const insets = useSafeAreaInsets()
  if (!error) return null

  return (
    <View pointerEvents="box-none" style={[styles.host, { paddingTop: insets.top + space.xs }]}>
      <View accessibilityRole="alert" style={styles.card} testID="shell-error-banner">
        <View style={styles.tint}>
          <Icon as={AlertTriangle} size={17} color={color.dangerText} />
          <Text style={styles.message}>{error.message}</Text>
          <PressableScale
            accessibilityRole="button"
            accessibilityLabel="Dismiss error"
            hitSlop={10}
            haptic={false}
            onPress={error.dismiss}
            style={styles.dismiss}
          >
            <Icon as={X} size={16} color={color.textDim} />
          </PressableScale>
        </View>
      </View>
    </View>
  )
}

const styles = StyleSheet.create({
  host: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    zIndex: 1000,
    paddingHorizontal: space.sm + 2,
  },
  // Opaque under the danger tint: this floats over whatever the route draws,
  // and a see-through card would mix the notice with the text behind it.
  card: {
    ...elevation.card,
    backgroundColor: color.surface,
    borderRadius: radius.md,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: 'rgba(229, 48, 63, 0.4)',
  },
  tint: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: space.sm,
    paddingHorizontal: space.md,
    paddingVertical: space.sm + 2,
    // Rounded itself rather than clipped by the card: `overflow: hidden` on
    // the card would also clip its iOS shadow.
    borderRadius: radius.md,
    backgroundColor: color.dangerSoft,
  },
  message: {
    ...sans(500),
    flex: 1,
    color: color.body,
    fontSize: font.small,
    lineHeight: leading(font.small),
  },
  dismiss: {
    padding: 2,
  },
})
