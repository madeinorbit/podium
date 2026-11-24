import type { AgentSetupView } from '@podium/client-graph/agent-setup-view'
import { agentCapabilityRejection, type BuiltinHarnessKind } from '@podium/model'
import { StyleSheet, Text } from 'react-native'
import { color, font, sans, space } from '../theme/theme'
import { PressableScale } from './PressableScale'

export const SET_UP_AGENTS = 'set-up-agents'

/** A terminal may also start a signed-out agent, where its own sign-in runs. */
export function pickerHarnessStartable(
  views: readonly AgentSetupView[],
  kind: BuiltinHarnessKind,
): boolean {
  return views.some(
    (view) =>
      view.reachable &&
      agentCapabilityRejection(view.machine, kind) === undefined &&
      ['ready', 'needs-sign-in'].includes(view.itemFor(kind)?.status ?? ''),
  )
}
export function installingAgentsHint(views: readonly AgentSetupView[]): string | undefined {
  const count = views.reduce(
    (total, view) =>
      total + (view.groups.find((group) => group.status === 'installing')?.items.length ?? 0),
    0,
  )
  return count ? `${count} installing` : undefined
}

export function AgentSetupPickerEntry({
  hint,
  onPress,
  disabled,
}: {
  hint?: string
  onPress: () => void
  disabled?: boolean
}) {
  return (
    <PressableScale
      accessibilityRole="button"
      accessibilityLabel="Set up agents…"
      accessibilityHint={hint}
      accessibilityState={{ disabled }}
      disabled={disabled}
      onPress={onPress}
      style={[styles.row, disabled && styles.disabled]}
    >
      <Text style={styles.plus}>＋</Text>
      <Text style={styles.label}>Set up agents…</Text>
      {hint ? <Text style={styles.hint}>{hint}</Text> : null}
    </PressableScale>
  )
}
const styles = StyleSheet.create({
  row: {
    minHeight: 52,
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
    paddingHorizontal: space.lg,
    paddingVertical: space.sm,
    marginTop: space.md,
    backgroundColor: color.surface,
    borderRadius: 12,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: color.border,
  },
  plus: { ...sans(), color: color.accentTint, fontSize: font.heading },
  label: { ...sans(), color: color.accentTint, fontSize: font.body, flex: 1 },
  hint: { ...sans(), color: color.textDim, fontSize: font.tiny },
  disabled: { opacity: 0.4 },
})
