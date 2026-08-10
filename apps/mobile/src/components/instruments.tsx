import { StyleSheet, Text, View } from 'react-native'
import { color, font, mono, monoLabel, space } from '../theme/theme'

/**
 * READOUTS AND RAILS — the machine-voice primitives [POD-662].
 *
 * Deliberately NOT cards. A same-size bordered tile carrying a big number over
 * a small label is the SaaS-dashboard cliché PRODUCT.md names as an
 * anti-reference, and the desktop instrument well already settled the
 * alternative: a mono micro-label, a tabular figure, a thin rail, divided by a
 * hairline rather than boxed. These are that grammar, sized for a thumb.
 */

export type MeterTone = 'ok' | 'warn' | 'crit'

const METER_FILL: Record<MeterTone, string> = {
  // Blue is calm liveness, and a meter with room left is not asking anything.
  ok: color.success,
  // Yellow is The Signal Rule's "this wants a decision from you" — which is
  // exactly what a window about to run out is saying.
  warn: color.accent,
  crit: color.danger,
}

/**
 * A filled rail, optionally marked with the point where something intervenes.
 *
 * The marker is the whole reason the rail is readable: filled against a
 * notional 100% it only says "some", while against the auto-park threshold or
 * the elapsed share of the window it predicts what is about to happen.
 */
export function Meter({
  pct,
  tone = 'ok',
  marker,
  markerLabel,
}: {
  pct: number
  tone?: MeterTone
  /** 0–100 position of the intervention tick, if the reading has one. */
  marker?: number | null
  markerLabel?: string
}) {
  const width = Math.min(100, Math.max(0, pct))
  return (
    <View style={styles.rail}>
      <View style={[styles.railFill, { width: `${width}%`, backgroundColor: METER_FILL[tone] }]} />
      {marker != null ? (
        <View
          accessibilityElementsHidden
          importantForAccessibility="no-hide-descendants"
          accessibilityLabel={markerLabel}
          style={[styles.railMark, { left: `${Math.min(99, Math.max(1, marker))}%` }]}
        />
      ) : null}
    </View>
  )
}

/** Mono label left, tabular figure right — one line of the instrument well. */
export function Readout({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.readout}>
      <Text style={styles.readoutLabel} numberOfLines={1}>
        {label}
      </Text>
      <Text style={styles.readoutValue} numberOfLines={1}>
        {value}
      </Text>
    </View>
  )
}

/** The dim mono line under a rail: what it is, and when it turns over. */
export function SubReadout({ left, right }: { left: string; right?: string }) {
  return (
    <View style={styles.sub}>
      <Text style={styles.subText} numberOfLines={1}>
        {left}
      </Text>
      {right ? (
        <Text style={[styles.subText, styles.subRight]} numberOfLines={1}>
          {right}
        </Text>
      ) : null}
    </View>
  )
}

/**
 * A run of bars over a baseline, with recessive gridlines.
 *
 * NO NUMBER ON EVERY BAR — that is the habit that turns a chart back into a
 * table, and at this width most bars have nowhere to put one. Proportion is
 * what a bar chart says; the peak is called out in the heading instead.
 *
 * Bars are DATA and read calm blue: yellow is reserved for what is asking
 * something of you, and a spend history asks nothing.
 */
export function BarTrace({
  values,
  height,
  gridlines = 0,
  label,
}: {
  /** Raw magnitudes, oldest first. Scaled here against their own peak. */
  values: readonly number[]
  height: number
  /** Interior lines, evenly spaced. Three is already denser than a phone needs. */
  gridlines?: number
  label: string
}) {
  const peak = Math.max(0, ...values)
  return (
    <View style={[styles.trace, { height }]} accessibilityRole="image" accessibilityLabel={label}>
      {Array.from({ length: gridlines }, (_, i) => ((i + 1) / (gridlines + 1)) * 100).map(
        (bottom) => (
          <View key={bottom} style={[styles.gridline, { bottom: `${bottom}%` }]} />
        ),
      )}
      {values.map((v, i) => (
        <View
          // The series is a fixed-length window of slots, so the index IS the
          // identity: slot 3 is the same slot on every render.
          // biome-ignore lint/suspicious/noArrayIndexKey: positional series
          key={i}
          style={[
            styles.bar,
            // A zero slot keeps a hairline of presence rather than vanishing:
            // an absent bar and a quiet one are different facts.
            { height: `${peak > 0 ? Math.max(1.5, (v / peak) * 100) : 1.5}%` },
          ]}
        />
      ))}
    </View>
  )
}

const styles = StyleSheet.create({
  rail: {
    position: 'relative',
    height: 4,
    marginTop: 9,
    borderRadius: 3,
    backgroundColor: color.surfaceHigh,
    overflow: 'hidden',
  },
  railFill: {
    height: '100%',
    borderRadius: 3,
  },
  railMark: {
    position: 'absolute',
    top: 0,
    bottom: 0,
    width: 1,
    backgroundColor: color.textFaint,
  },
  readout: {
    flexDirection: 'row',
    alignItems: 'baseline',
    justifyContent: 'space-between',
    gap: space.md,
  },
  readoutLabel: {
    ...monoLabel(),
    color: color.label,
    flexShrink: 1,
  },
  readoutValue: {
    ...mono(600),
    color: color.body,
    fontSize: font.micro,
  },
  sub: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    gap: space.sm,
    marginTop: 7,
  },
  subText: {
    ...mono(400),
    color: color.textFaint,
    fontSize: font.micro,
    flexShrink: 1,
  },
  subRight: {
    textAlign: 'right',
  },
  trace: {
    position: 'relative',
    flexDirection: 'row',
    alignItems: 'flex-end',
    gap: 2,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: color.border,
  },
  gridline: {
    position: 'absolute',
    left: 0,
    right: 0,
    height: StyleSheet.hairlineWidth,
    backgroundColor: color.hairline,
  },
  bar: {
    flex: 1,
    minHeight: 2,
    backgroundColor: color.working,
    borderTopLeftRadius: 1,
    borderTopRightRadius: 1,
  },
})
