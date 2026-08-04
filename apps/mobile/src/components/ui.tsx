import type { ReactNode } from 'react'
import { StyleSheet, Text, View } from 'react-native'
import {
  type AttentionTone,
  color,
  font,
  leading,
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

/**
 * First-load placeholder rows [POD-366].
 *
 * Every list used to paint its empty state the instant the screen mounted, so
 * a cold start read "No tasks" and then popped content in — a flicker that
 * looks like breakage rather than latency. Lists render this while
 * `client.booting` and keep the empty state for genuinely empty.
 *
 * Deliberately still: the braille spinner is the app's only perpetual motion
 * (StatusGlyphs), so these do not shimmer.
 */
export function ListSkeleton({ rows = 3 }: { rows?: number }) {
  return (
    <View accessibilityRole="progressbar" accessibilityLabel="Loading">
      {Array.from({ length: rows }, (_, i) => (
        <View
          // biome-ignore lint/suspicious/noArrayIndexKey: fixed-length placeholder, no identity
          key={i}
          style={[styles.skelRow, { opacity: 1 - i * 0.22 }]}
        >
          <View style={styles.skelSquare} />
          <View style={styles.skelLines}>
            <View style={[styles.skelBar, { width: `${72 - i * 14}%` }]} />
            <View style={[styles.skelBar, styles.skelBarShort]} />
          </View>
        </View>
      ))}
    </View>
  )
}

export function EmptyState({
  title,
  body,
  icon,
  fill,
}: {
  title: string
  body?: string
  icon?: ReactNode
  /** Claim the leftover height and centre in it — for empty states that stand
   *  in for a scroller, so whatever is docked below (a composer) stays docked. */
  fill?: boolean
}) {
  return (
    <View style={[styles.empty, fill && styles.emptyFill]}>
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
    fontSize: font.micro,
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
    ...monoLabel(),
    color: color.label,
  },
  sectionRule: {
    flex: 1,
    height: StyleSheet.hairlineWidth,
    backgroundColor: color.hairline,
  },
  skelRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
    marginHorizontal: space.sm + 2,
    marginTop: space.sm,
    padding: space.md,
    borderRadius: radius.md,
    backgroundColor: color.surface,
  },
  skelSquare: {
    width: 34,
    height: 34,
    borderRadius: radius.md,
    backgroundColor: color.elevated,
  },
  skelLines: {
    flex: 1,
    gap: 7,
  },
  skelBar: {
    height: 10,
    borderRadius: radius.xs,
    backgroundColor: color.elevated,
  },
  skelBarShort: {
    width: '38%',
    height: 8,
  },
  empty: {
    alignItems: 'center',
    paddingHorizontal: space.xxl,
    paddingVertical: space.xxl * 2,
    gap: space.sm,
  },
  emptyFill: {
    flex: 1,
    minHeight: 0,
    justifyContent: 'center',
    paddingVertical: space.xxl,
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
    fontSize: font.heading,
    letterSpacing: -0.1,
  },
  emptyBody: {
    ...sans(400),
    color: color.textFaint,
    fontSize: font.small,
    textAlign: 'center',
    lineHeight: leading(font.small, 'prose'),
  },
})
