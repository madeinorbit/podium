import { RefreshCw } from 'lucide-react-native'
import { StyleSheet, Text, View } from 'react-native'
import { useServedBuildRefresh } from '../lib/served-build'
import { color, font, leading, radius, sans, space } from '../theme/theme'
import { Icon } from './Icon'
import { PressableScale } from './PressableScale'

/**
 * "A NEWER PODIUM IS BEING SERVED" (updater-convergence spec §8c decision 11).
 *
 * The update itself was decided somewhere else — an admin approved it, a
 * machine applied it — and by the time this appears the phone's own interface
 * has already been replaced on the server. So this is not an update offer and
 * must not read like one: there is nothing to consent to, nothing to install,
 * and no progress to watch. One sentence and one button.
 *
 * Yellow, because Superade Yellow means "waiting on you" and this is the one
 * thing on screen that is.
 */
export function RefreshOffer() {
  const { needsRefresh, refresh } = useServedBuildRefresh()
  if (!needsRefresh) return null

  return (
    <View accessibilityRole="alert" style={styles.offer} testID="served-build-refresh">
      <Icon as={RefreshCw} size={16} color={color.needsYouText} />
      <Text style={styles.message}>A newer Podium is ready on your server.</Text>
      <PressableScale
        accessibilityRole="button"
        accessibilityLabel="Refresh to the new version of Podium"
        hitSlop={8}
        onPress={refresh}
        style={styles.action}
      >
        <Text style={styles.actionLabel}>Refresh</Text>
      </PressableScale>
    </View>
  )
}

const styles = StyleSheet.create({
  offer: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    marginHorizontal: space.sm + 2,
    marginBottom: space.sm,
    paddingLeft: space.md,
    paddingRight: space.sm,
    paddingVertical: space.sm,
    backgroundColor: color.needsYouSoft,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: color.needsYouBorder,
    borderRadius: radius.md,
  },
  message: {
    ...sans(500),
    flex: 1,
    color: color.body,
    fontSize: font.small,
    lineHeight: leading(font.small),
  },
  action: {
    paddingHorizontal: space.sm + 2,
    paddingVertical: 5,
    backgroundColor: color.accent,
    borderRadius: radius.sm,
  },
  actionLabel: {
    ...sans(600),
    color: color.onAccent,
    fontSize: font.small,
  },
})
