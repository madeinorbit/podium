import type { ReactNode } from 'react'
import { ScrollView, StyleSheet, View } from 'react-native'
import { color, font, sans } from '../../theme/theme'
import { PressableScale } from '../PressableScale'
import { SectionHeading } from './chrome'
import { DetailText as Text } from './DetailText'

export function DetailList({ children }: { children: ReactNode }) {
  return (
    <ScrollView
      testID="issue-detail-list"
      contentInsetAdjustmentBehavior="automatic"
      contentContainerStyle={styles.content}
      keyboardShouldPersistTaps="handled"
      keyboardDismissMode="on-drag"
    >
      {children}
    </ScrollView>
  )
}

/** `bleed` is the iOS native List's header inset opt-out; this ScrollView has none. */
export function DetailContent({ children }: { children: ReactNode; bleed?: boolean }) {
  return <View style={styles.reference}>{children}</View>
}

export function DetailGroup({
  label,
  count,
  children,
  testID,
}: {
  label: string
  count?: string
  children: ReactNode
  testID?: string
}) {
  return (
    <View testID={testID}>
      <SectionHeading label={label} count={count} />
      <View style={styles.group}>{children}</View>
    </View>
  )
}

export function DetailActionRow({
  label,
  onPress,
  primary = false,
  disabled = false,
}: {
  label: string
  onPress: () => void
  primary?: boolean
  disabled?: boolean
}) {
  return (
    <PressableScale
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled }}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [styles.action, primary && styles.primary, pressed && styles.pressed]}
    >
      <Text style={[styles.actionText, primary && styles.primaryText]}>{label}</Text>
    </PressableScale>
  )
}

const styles = StyleSheet.create({
  content: { padding: 16, paddingBottom: 32, gap: 24 },
  reference: { gap: 16 },
  group: { backgroundColor: color.groupedCard, borderRadius: 12, overflow: 'hidden' },
  action: { minHeight: 44, paddingHorizontal: 16, paddingVertical: 12, justifyContent: 'center' },
  primary: { backgroundColor: color.accent },
  actionText: { ...sans(400), fontSize: font.body, color: color.accentTint },
  primaryText: { ...sans(600), color: color.onAccent },
  pressed: { opacity: 0.65 },
})
