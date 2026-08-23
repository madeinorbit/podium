import { StyleSheet, Text, View } from 'react-native'
import { color, mono, monoLabel, radius } from '../theme/theme'
import { AsciiWordmark } from './AsciiWordmark'

/**
 * Cold-start splash — the web AsciiLoader ported [POD-131]: the wordmark
 * reveals cell-by-cell with a sparkle then settles, over a static mono loading
 * label. Shown while fonts load, the replica hydrates, and the auth probe runs
 * (the app previously showed a blank dark view in these gaps).
 */
export function BootSplash({
  label = 'LOADING',
  detail,
  progress,
}: {
  label?: string
  detail?: string | undefined
  /** Exact measured fraction, or null/undefined when the server has no denominator. */
  progress?: number | null | undefined
} = {}) {
  const measuredProgress =
    progress === null || progress === undefined ? null : Math.max(0, Math.min(1, progress))
  return (
    <View style={styles.root} accessibilityState={{ busy: true }} testID="boot-splash">
      <AsciiWordmark color={color.text} fontSize={5.5} variant="reveal" />
      <Text style={styles.label}>{`${label}...`}</Text>
      {detail ? <Text style={styles.detail}>{detail}</Text> : null}
      {measuredProgress !== null ? (
        <View
          style={styles.track}
          accessibilityRole="progressbar"
          accessibilityLabel="Workspace loading progress"
          accessibilityValue={{ min: 0, max: 100, now: Math.round(measuredProgress * 100) }}
        >
          <View style={[styles.fill, { width: `${measuredProgress * 100}%` }]} />
        </View>
      ) : null}
    </View>
  )
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: color.bg,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 18,
  },
  label: {
    ...monoLabel(),
    letterSpacing: 2,
    color: color.label,
  },
  detail: {
    ...mono(400),
    marginTop: -10,
    color: color.textFaint,
    fontSize: 11,
  },
  track: {
    width: 152,
    height: 3,
    marginTop: -8,
    overflow: 'hidden',
    borderRadius: radius.full,
    backgroundColor: color.border,
  },
  fill: {
    height: '100%',
    borderRadius: radius.full,
    backgroundColor: color.working,
  },
})
