import type { ReactNode } from 'react'
import { StyleSheet, Text, View } from 'react-native'
import {
  type AttentionTone,
  color,
  mono,
  monoLabel,
  radius,
  sans,
  space,
  tone,
} from '../theme/theme'

export function Pill({ label, toneKey }: { label: string; toneKey?: AttentionTone }) {
  const t = toneKey ? tone[toneKey] : null
  return (
    <View style={[styles.pill, t ? { backgroundColor: t.bg, borderColor: t.border } : null]}>
      <Text style={[styles.pillText, t ? { color: t.fg } : null]}>{label}</Text>
    </View>
  )
}

export function StatusDot({ toneKey, size = 7 }: { toneKey: AttentionTone; size?: number }) {
  return (
    <View
      style={{
        width: size,
        height: size,
        borderRadius: 2.5,
        backgroundColor: tone[toneKey].fg,
      }}
    />
  )
}

/** Mono section label with a trailing hairline rule — the redesign's group
 *  header grammar (project names, WORK, NEEDS YOU …). */
export function SectionHeader({ label, right }: { label: string; right?: ReactNode }) {
  return (
    <View style={styles.sectionHeader}>
      <Text style={styles.sectionLabel} numberOfLines={1}>
        {label}
      </Text>
      <View style={styles.sectionRule} />
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
    paddingHorizontal: 7,
    paddingVertical: 2,
    alignSelf: 'flex-start',
  },
  pillText: {
    ...mono(500),
    color: color.textDim,
    fontSize: 9,
    letterSpacing: 0.3,
  },
  sectionHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    paddingHorizontal: space.lg,
    paddingTop: space.lg + 2,
    paddingBottom: 4,
  },
  sectionLabel: {
    ...monoLabel(9),
    color: color.label,
  },
  sectionRule: {
    flex: 1,
    height: StyleSheet.hairlineWidth,
    backgroundColor: color.hairline,
  },
  empty: {
    alignItems: 'center',
    paddingHorizontal: space.xxl,
    paddingVertical: space.xxl * 2,
    gap: space.sm,
  },
  emptyIcon: {
    width: 56,
    height: 56,
    borderRadius: radius.lg,
    backgroundColor: color.surface,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: color.border,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: space.sm,
  },
  emptyTitle: {
    ...sans(600),
    color: color.text,
    fontSize: 14,
    letterSpacing: -0.1,
  },
  emptyBody: {
    ...sans(400),
    color: color.textFaint,
    fontSize: 11.5,
    textAlign: 'center',
    lineHeight: 17,
  },
})
