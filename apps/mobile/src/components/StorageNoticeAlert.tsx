import { StyleSheet, Text, View } from 'react-native'
import { useMobileShell } from '../client/shell'
import { color, font, leading, radius, sans, space } from '../theme/theme'
import { Icon } from './Icon'
import { AlertTriangle, RefreshCw, X } from './icons'
import { PressableScale } from './PressableScale'

/**
 * The replica's never-silent durability warning, with one global acknowledgement.
 * Dismissal belongs to the notice rather than this component so switching tabs
 * cannot resurrect a warning the operator has already read.
 *
 * TWO TONES (POD-4002). A `warning` is the danger colour: work was lost or
 * storage cannot be trusted. An `info` notice is a fact the user is owed that
 * cost them nothing — the one-time refresh after an upgrade — and it must not
 * read as a failure, so it takes the neutral surface and a refresh glyph.
 */
export function StorageNoticeAlert() {
  const { notice } = useMobileShell()
  if (!notice) return null
  const info = notice.tone === 'info'

  return (
    <View
      accessibilityRole="alert"
      style={[styles.alert, info ? styles.info : styles.warning]}
      testID={info ? 'storage-notice-info' : 'storage-notice-alert'}
    >
      <Icon
        as={info ? RefreshCw : AlertTriangle}
        size={17}
        color={info ? color.textDim : color.dangerText}
      />
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
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: radius.md,
  },
  warning: {
    backgroundColor: color.dangerSoft,
    borderColor: 'rgba(229, 48, 63, 0.4)',
  },
  info: {
    backgroundColor: color.idleSoft,
    borderColor: color.border,
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
