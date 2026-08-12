import type { ServerReadinessState } from '@podium/model'
import { StyleSheet, Text, View } from 'react-native'
import { color, font, monoLabel, radius, sans, space } from '../theme/theme'
import { PressableScale } from './PressableScale'

export type ReadinessDisplayState =
  | Exclude<ServerReadinessState, 'ready'>
  | 'configuration_invalid'
  | 'unreachable'

const COPY: Record<ReadinessDisplayState, { label: string; heading: string; body: string }> = {
  unconfigured: {
    label: 'SETUP REQUIRED',
    heading: 'Finish setup on the server',
    body: 'This Podium server is online, but it is not ready for other devices yet. On the server, run podium setup, finish access and login choices, then retry here.',
  },
  activation_pending: {
    label: 'RESTART REQUIRED',
    heading: 'Setup is saved; Podium needs to restart',
    body: 'Restart Podium on the server, then retry. No setup changes are needed.',
  },
  degraded: {
    label: 'LIMITED AVAILABILITY',
    heading: 'Server online; no agent machine available',
    body: 'You can review existing work, but starting agents is unavailable until a machine reconnects.',
  },
  configuration_invalid: {
    label: 'SERVER DEGRADED',
    heading: 'Server configuration needs repair',
    body: 'Podium is still running with the configuration it activated at startup, but config.json can no longer be read. Repair or restore it on the server, then retry.',
  },
  unreachable: {
    label: 'SERVER UNREACHABLE',
    heading: 'Cannot reach this Podium server',
    body: 'Check that Podium is running and that this phone can access the same private network or configured HTTPS URL. Your on-device data has not been changed.',
  },
}

export function ReadinessScreen({
  state,
  onRetry,
  onContinue,
}: {
  state: ReadinessDisplayState
  onRetry: () => void
  onContinue?: () => void
}) {
  const copy = COPY[state]
  return (
    <View style={styles.root}>
      <Text style={styles.label}>{copy.label}</Text>
      <Text style={styles.heading}>{copy.heading}</Text>
      <Text style={styles.body}>{copy.body}</Text>
      <View style={styles.actions}>
        <PressableScale onPress={onRetry} style={styles.button} accessibilityRole="button">
          <Text style={styles.buttonText}>Retry</Text>
        </PressableScale>
        {onContinue ? (
          <PressableScale
            onPress={onContinue}
            style={[styles.button, styles.primaryButton]}
            accessibilityRole="button"
          >
            <Text style={[styles.buttonText, styles.primaryButtonText]}>Review work</Text>
          </PressableScale>
        ) : null}
      </View>
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
  label: { ...monoLabel(), letterSpacing: 2, color: color.label },
  heading: {
    ...sans(600),
    maxWidth: 420,
    fontSize: font.title,
    color: color.text,
    textAlign: 'center',
  },
  body: {
    ...sans(400),
    maxWidth: 440,
    fontSize: font.small,
    lineHeight: 21,
    color: color.textDim,
    textAlign: 'center',
  },
  actions: { marginTop: space.md, flexDirection: 'row', gap: space.sm },
  button: {
    paddingHorizontal: space.lg,
    paddingVertical: space.sm,
    borderRadius: radius.md,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: color.border,
    backgroundColor: color.elevated,
  },
  primaryButton: { backgroundColor: color.accent, borderColor: color.accent },
  buttonText: { ...sans(600), fontSize: font.small, color: color.text },
  primaryButtonText: { color: color.onAccent },
})
