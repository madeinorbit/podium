import { AlertTriangle, X } from './icons'
import { StyleSheet, Text, View } from 'react-native'
import { useMobileShell } from '../client/shell'
import { color, font, leading, radius, sans, space } from '../theme/theme'
import { Icon } from './Icon'
import { PressableScale } from './PressableScale'

/**
 * The replica's never-silent durability warning, with one global acknowledgement.
 * Dismissal belongs to the notice rather than this component so switching tabs
 * cannot resurrect a warning the operator has already read.
 */
export function StorageNoticeAlert() {
  const { notice } = useMobileShell()
  if (!notice) return null

  return (
    <View accessibilityRole="alert" style={styles.alert} testID="storage-notice-alert">
      <Icon as={AlertTriangle} size={17} color={color.danger} />
      <Text style={styles.message}>{notice.message}</Text>
      <PressableScale
        accessibilityRole="button"
        accessibilityLabel="Dismiss offline storage alert"
        hitSlop={10}
        haptic={false}
        onPress={notice.dismiss}
        style={styles.dismiss}
      >
        <Icon as={X} size={16} color={color.textDim} />
      </PressableScale>
    </View>
  )
}

const styles = StyleSheet.create({
  alert: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: space.sm,
    marginHorizontal: space.sm + 2,
    marginBottom: space.sm,
    paddingHorizontal: space.md,
    paddingVertical: space.sm + 2,
    backgroundColor: color.dangerSoft,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: 'rgba(229, 48, 63, 0.4)',
    borderRadius: radius.md,
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
