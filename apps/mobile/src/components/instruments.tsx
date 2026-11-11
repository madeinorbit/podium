import type { ReactNode } from 'react'
import { Platform, Pressable, StyleSheet, Text, View } from 'react-native'
import { color, font, sans, space } from '../theme/theme'
import { Icon } from './Icon'
import { ChevronDown, ChevronRight } from './icons'

/**
 * Pulse's instrument pieces, drawn to the iOS redesign boards [POD-2379].
 *
 * One 4pt grid: screen margin 16, card inset 12, card radius 8, inner radius
 * 1–4. Data marks are the label colour (ink), not a hue: colour is spent only
 * on what wants attention — the signal for a window that is out, red for a
 * machine that is full.
 */

/**
 * Row separators inside a card. iOS draws its own `separator` colour; the web
 * and Android builds keep the dark palette, whose hairline token is nearly the
 * card colour, so they use the board's white-at-10% instead.
 */
export const SEPARATOR = Platform.OS === 'ios' ? color.hairline : 'rgba(255, 255, 255, 0.1)'

/** The board's card corner. Our own surface, so the redesign's 8, not a system shape. */
export const CARD_RADIUS = 8
/** Card content inset. */
export const CARD_INSET = space.md

export type MeterTone = 'ink' | 'signal' | 'crit'

const METER_FILL: Record<MeterTone, string> = {
  ink: color.text,
  signal: color.accent,
  crit: color.danger,
}

/**
 * A 4pt rail filled to `pct`, optionally ticked where something intervenes —
 * the elapsed share of a quota window, so fill PAST the tick means the window
 * is being spent faster than it runs out. The tick stands proud of the rail so
 * it stays visible exactly when the fill has reached it.
 */
export function Meter({
  pct,
  tone = 'ink',
  marker,
  muted = false,
}: {
  pct: number
  tone?: MeterTone
  /** 0–100 position of the pace tick. */
  marker?: number | null
  /** A share bar (models, projects) rather than a gauge: quieter fill. */
  muted?: boolean
}) {
  const width = Math.min(100, Math.max(0, pct))
  return (
    <View style={styles.meterWrap}>
      <View style={[styles.meter, muted && styles.meterMuted]}>
        <View
          style={[
            styles.meterFill,
            muted
              ? styles.meterFillMuted
              : { backgroundColor: METER_FILL[tone], opacity: tone === 'ink' ? 0.8 : 1 },
            { width: `${width}%` },
          ]}
        />
      </View>
      {marker != null ? (
        <View
          accessibilityElementsHidden
          importantForAccessibility="no-hide-descendants"
          style={[styles.tick, { left: `${Math.min(99.5, Math.max(0, marker))}%` }]}
        />
      ) : null}
    </View>
  )
}

/**
 * An hourly cost trace: one bar per hour slot, scaled against its own peak.
 * Future slots (the rest of today) are not bars; they are one shaded run at
 * the right edge, so "not yet" never reads as "nothing". Day boundaries get a
 * recessive gridline when `dayEvery` is set.
 */
export function HourTrace({
  slots,
  height = 56,
  dayEvery,
  label,
}: {
  slots: readonly { costUsd: number; future: boolean }[]
  height?: number
  /** Slots per day, for the day gridlines; omit for a short trace. */
  dayEvery?: number
  label: string
}) {
  const peak = Math.max(0, ...slots.map((s) => (s.future ? 0 : s.costUsd)))
  const firstFuture = slots.findIndex((s) => s.future)
  const pastCount = firstFuture === -1 ? slots.length : firstFuture
  const past = slots.slice(0, pastCount)
  const futureShare = slots.length > 0 ? (slots.length - pastCount) / slots.length : 0
  const gaps = slots.length > 24 ? 0.5 : 2
  return (
    <View style={[styles.trace, { height }]} accessibilityRole="image" accessibilityLabel={label}>
      {dayEvery && slots.length > dayEvery
        ? Array.from({ length: Math.floor((slots.length - 1) / dayEvery) }, (_, i) => (
            <View
              // biome-ignore lint/suspicious/noArrayIndexKey: fixed calendar grid positions never reorder.
              key={`grid-${i + 1}`}
              style={[styles.gridline, { left: `${(((i + 1) * dayEvery) / slots.length) * 100}%` }]}
            />
          ))
        : null}
      <View style={[styles.bars, { gap: gaps, flex: 1 - futureShare }]}>
        {past.map((slot, i) => (
          <View
            // A fixed run of hour slots: the index is the slot's identity.
            // biome-ignore lint/suspicious/noArrayIndexKey: positional series
            key={i}
            style={styles.barSlot}
          >
            {slot.costUsd > 0 && peak > 0 ? (
              <View
                style={[
                  styles.bar,
                  { height: `${Math.max(3, (slot.costUsd / peak) * 100)}%` },
                  slots.length <= 24 && styles.barWide,
                ]}
              />
            ) : null}
          </View>
        ))}
      </View>
      {futureShare > 0 ? <View style={[styles.future, { flex: futureShare }]} /> : null}
    </View>
  )
}

/**
 * The grouped card every Pulse section sits in.
 */
export function Card({ children }: { children: ReactNode }) {
  return <View style={styles.card}>{children}</View>
}

/**
 * A section name on the card's own axis, with a disclosure chevron. The whole
 * row toggles, as in Mail's mailbox groups; `trailing` carries a quiet note.
 */
export function SectionHeader({
  title,
  open,
  onToggle,
  trailing,
  trailingSignal = false,
}: {
  title: string
  open: boolean
  onToggle: () => void
  trailing?: string
  /** The note is a state that needs a look (a provider out), drawn in the signal tint. */
  trailingSignal?: boolean
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ expanded: open }}
      aria-expanded={open}
      accessibilityLabel={`${title}${trailing ? `, ${trailing}` : ''}, ${open ? 'expanded' : 'collapsed'}`}
      onPress={onToggle}
      style={styles.section}
    >
      <Icon as={open ? ChevronDown : ChevronRight} size={12} color={color.textFaint} />
      <Text style={styles.sectionTitle} numberOfLines={1}>
        {title}
      </Text>
      {trailing ? (
        <Text
          style={[styles.sectionTrailing, trailingSignal && styles.sectionSignal]}
          numberOfLines={1}
        >
          {trailing}
        </Text>
      ) : null}
    </Pressable>
  )
}

/** Hairline between rows inside a card, starting at the card inset. */
export const rowDivider = {
  borderTopWidth: StyleSheet.hairlineWidth,
  borderTopColor: SEPARATOR,
} as const

const styles = StyleSheet.create({
  meterWrap: {
    position: 'relative',
    justifyContent: 'center',
  },
  meter: {
    height: 4,
    borderRadius: 1,
    backgroundColor: color.fill,
    overflow: 'hidden',
  },
  meterMuted: {
    backgroundColor: color.tertiaryFill,
  },
  meterFill: {
    height: '100%',
  },
  meterFillMuted: {
    backgroundColor: color.textDim,
  },
  tick: {
    position: 'absolute',
    top: -2,
    bottom: -2,
    width: 1,
    backgroundColor: color.textDim,
  },
  trace: {
    position: 'relative',
    flexDirection: 'row',
    alignItems: 'stretch',
  },
  gridline: {
    position: 'absolute',
    top: 0,
    bottom: 0,
    width: StyleSheet.hairlineWidth,
    backgroundColor: SEPARATOR,
  },
  bars: {
    flexDirection: 'row',
    alignItems: 'stretch',
  },
  barSlot: {
    flex: 1,
    justifyContent: 'flex-end',
  },
  bar: {
    width: '100%',
    backgroundColor: color.text,
    opacity: 0.78,
    borderTopLeftRadius: 0.5,
    borderTopRightRadius: 0.5,
  },
  barWide: {
    borderTopLeftRadius: 2,
    borderTopRightRadius: 2,
  },
  future: {
    backgroundColor: color.tertiaryFill,
  },
  card: {
    backgroundColor: color.groupedCard,
    borderRadius: CARD_RADIUS,
    overflow: 'hidden',
  },
  section: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    minHeight: 28,
    marginTop: space.lg,
    marginBottom: space.xs,
    paddingHorizontal: CARD_INSET,
  },
  sectionTitle: {
    ...sans(600),
    flex: 1,
    color: color.textDim,
    fontSize: font.tiny,
    lineHeight: 16,
  },
  sectionTrailing: {
    ...sans(400),
    flexShrink: 1,
    color: color.textFaint,
    fontSize: 12,
    lineHeight: 16,
  },
  sectionSignal: {
    color: color.accentTint,
  },
})
