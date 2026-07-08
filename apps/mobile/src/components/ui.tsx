import type { ReactNode } from 'react'
import { StyleSheet, Text, View } from 'react-native'
import { type AttentionTone, color, font, radius, space, tone } from '../theme/theme'

export function Pill({ label, toneKey }: { label: string; toneKey?: AttentionTone }) {
  const t = toneKey ? tone[toneKey] : null
  return (
    <View style={[styles.pill, t ? { backgroundColor: t.bg, borderColor: t.border } : null]}>
      <Text style={[styles.pillText, t ? { color: t.fg } : null]}>{label}</Text>
    </View>
  )
}

export function StatusDot({ toneKey, size = 8 }: { toneKey: AttentionTone; size?: number }) {
  return (
    <View
      style={{
        width: size,
        height: size,
        borderRadius: radius.full,
        backgroundColor: tone[toneKey].fg,
      }}
    />
  )
}

export function SectionHeader({ label, right }: { label: string; right?: ReactNode }) {
  return (
    <View style={styles.sectionHeader}>
      <Text style={styles.sectionLabel}>{label}</Text>
      {right}
    </View>
  )
}

export function EmptyState({
  title,
  body,
  icon,
}: {
  title: string
  body?: string
  icon?: ReactNode
}) {
  return (
    <View style={styles.empty}>
      {icon ? <View style={styles.emptyIcon}>{icon}</View> : null}
      <Text style={styles.emptyTitle}>{title}</Text>
      {body ? <Text style={styles.emptyBody}>{body}</Text> : null}
    </View>
  )
}

const styles = StyleSheet.create({
  pill: {
    backgroundColor: color.idleSoft,
    borderColor: 'transparent',
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: radius.full,
    paddingHorizontal: space.sm + 1,
    paddingVertical: 3,
    alignSelf: 'flex-start',
  },
  pillText: {
    color: color.textDim,
    fontSize: font.tiny,
    fontWeight: '700',
    letterSpacing: 0.4,
  },
  sectionHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: space.xl,
    paddingTop: space.xl,
    paddingBottom: space.sm,
  },
  sectionLabel: {
    color: color.textFaint,
    fontSize: font.tiny,
    fontWeight: '800',
    letterSpacing: 1.6,
    textTransform: 'uppercase',
  },
  empty: {
    alignItems: 'center',
    paddingHorizontal: space.xxl,
    paddingVertical: space.xxl * 2,
    gap: space.sm,
  },
  emptyIcon: {
    width: 64,
    height: 64,
    borderRadius: radius.lg,
    backgroundColor: color.surface,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: color.border,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: space.sm,
  },
  emptyTitle: {
    color: color.text,
    fontSize: font.heading,
    fontWeight: '700',
    letterSpacing: -0.2,
  },
  emptyBody: {
    color: color.textFaint,
    fontSize: font.small,
    textAlign: 'center',
    lineHeight: 20,
  },
})
