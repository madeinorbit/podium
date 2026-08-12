import { StyleSheet, Text, View } from 'react-native'
import { color, font, mono, monoLabel, radius, sans, space } from '../theme/theme'
import { PressableScale } from './PressableScale'

/**
 * WHAT THE APP SHOWS WHEN IT CANNOT START (POD-712).
 *
 * Before this screen existed, every way the mobile boot could fail rendered the
 * SAME thing as the boot still running: `LiveProvider` returned `null`, so the
 * one `LaunchBoundary` above it kept `BootSplash` mounted and the app sat on the
 * wordmark forever. A thrown auth status, a storage engine that never opens, a
 * rejected replica migration — all of them were indistinguishable from a slow
 * network, and none of them reached `shell.error`, because that is only rendered
 * by screens that a failed boot never mounts.
 *
 * The distinction this screen draws is between a boot that FAILED and one that
 * is merely SLOW, because the honest message differs:
 *
 *  - `kind: 'failed'` — the boot threw. It is over; retrying is the only move.
 *  - `kind: 'stalled'` — the watchdog fired but the boot is still running and may
 *    still succeed on its own. Saying "failed" here would be a lie on a slow
 *    phone, so it says what is true (this is taking longer than it should) and
 *    offers the same retry without claiming the first attempt is dead.
 */
export function BootTroubleScreen({
  kind,
  detail,
  onRetry,
}: {
  kind: 'failed' | 'stalled'
  detail: string | null
  onRetry: () => void
}) {
  const failed = kind === 'failed'
  return (
    <View style={styles.root}>
      <Text style={styles.label}>{failed ? 'CANNOT START' : 'STILL STARTING'}</Text>
      <Text style={styles.headline}>
        {failed ? 'Podium could not open its local data.' : 'This is taking longer than it should.'}
      </Text>
      <Text style={styles.body}>
        {failed
          ? 'The app stopped before it could load anything. Retrying usually clears it.'
          : 'The app is still trying to start. You can wait, or retry now.'}
      </Text>
      {detail ? (
        <Text style={styles.detail} numberOfLines={4}>
          {detail}
        </Text>
      ) : null}
      <PressableScale onPress={onRetry} style={styles.button} accessibilityRole="button">
        <Text style={styles.buttonText}>Retry</Text>
      </PressableScale>
    </View>
  )
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: color.bg,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: space.lg,
    gap: space.sm,
  },
  label: {
    ...monoLabel(),
    letterSpacing: 2,
    color: color.label,
  },
  headline: {
    ...sans(600),
    fontSize: font.body,
    color: color.text,
    textAlign: 'center',
  },
  body: {
    ...sans(400),
    fontSize: font.small,
    color: color.textDim,
    textAlign: 'center',
  },
  detail: {
    ...mono(400),
    fontSize: font.micro,
    color: color.textFaint,
    textAlign: 'center',
  },
  button: {
    marginTop: space.md,
    paddingHorizontal: space.lg,
    paddingVertical: space.sm,
    borderRadius: radius.md,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: color.border,
    backgroundColor: color.elevated,
  },
  buttonText: {
    ...sans(600),
    fontSize: font.small,
    color: color.text,
  },
})
