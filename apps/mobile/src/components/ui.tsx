import type { ReactNode } from 'react'
import { StyleSheet, Text, View } from 'react-native'
import { type AttentionTone, color, font, radius, space, tone } from '../theme/theme'

export function Pill({ label, toneKey }: { label: string; toneKey?: AttentionTone }) {
  const t = toneKey ? tone[toneKey] : null
  return (
    <View style={[styles.pill, t ? { backgroundColor: t.bg } : null]}>
      <Text style={[styles.pillText, t ? { color: t.fg } : null]}>{label}</Text>
    </View>
  )
}

export function StatusDot({ toneKey }: { toneKey: AttentionTone }) {
  return <View style={[styles.dot, { backgroundColor: tone[toneKey].fg }]} />
}

export function SectionHeader({ label, right }: { label: string; right?: ReactNode }) {
  return (
    <View style={styles.sectionHeader}>
      <Text style={styles.sectionLabel}>{label}</Text>
      {right}
    </View>
  )
}

export function EmptyState({ title, body }: { title: string; body?: string }) {
  return (
    <View style={styles.empty}>
      <Text style={styles.emptyTitle}>{title}</Text>
      {body ? <Text style={styles.emptyBody}>{body}</Text> : null}
    </View>
  )
}

const styles = StyleSheet.create({
  pill: {
    backgroundColor: color.idleBg,
    borderRadius: radius.full,
    paddingHorizontal: space.sm,
    paddingVertical: 2,
    alignSelf: 'flex-start',
  },
  pillText: {
    color: color.textDim,
    fontSize: font.tiny,
    fontWeight: '600',
    letterSpacing: 0.3,
  },
  dot: {
    width: 8,
    height: 8,
    borderRadius: radius.full,
  },
  sectionHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: space.lg,
    paddingTop: space.xl,
    paddingBottom: space.sm,
  },
  sectionLabel: {
    color: color.textFaint,
    fontSize: font.tiny,
    fontWeight: '700',
    letterSpacing: 1.2,
    textTransform: 'uppercase',
  },
  empty: {
    alignItems: 'center',
    paddingHorizontal: space.xl,
    paddingVertical: space.xxl * 2,
    gap: space.sm,
  },
  emptyTitle: {
    color: color.textDim,
    fontSize: font.heading,
    fontWeight: '600',
  },
  emptyBody: {
    color: color.textFaint,
    fontSize: font.small,
    textAlign: 'center',
    lineHeight: 19,
  },
})
