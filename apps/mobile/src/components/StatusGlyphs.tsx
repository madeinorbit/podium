import { useEffect, useState } from 'react'
import { StyleSheet, Text, View } from 'react-native'
import { color, mono, monoLabel } from '../theme/theme'

const FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']

/**
 * The motion grammar's braille spinner — green mono glyph stepping at .8s per
 * cycle. The ONLY perpetual motion in the app: it means "an agent is
 * computing right now"; nothing else may pulse.
 */
export function BrailleSpinner({
  size = 10,
  tint = color.working,
}: {
  size?: number
  tint?: string
}) {
  const [frame, setFrame] = useState(0)
  useEffect(() => {
    const id = setInterval(() => setFrame((f) => (f + 1) % FRAMES.length), 80)
    return () => clearInterval(id)
  }, [])
  return <Text style={[mono(400), { fontSize: size, color: tint }]}>{FRAMES[frame]}</Text>
}

/** Amber numbered pill — "N things waiting on you". */
export function CountPill({ count, size = 16 }: { count: number; size?: number }) {
  return (
    <View
      style={[
        styles.pill,
        {
          height: size,
          minWidth: size,
          borderRadius: size / 2,
          paddingHorizontal: size >= 16 ? 5 : 3,
        },
      ]}
    >
      <Text style={[mono(700), styles.pillText, { fontSize: size >= 16 ? 9 : 7.5 }]}>
        {String(count)}
      </Text>
    </View>
  )
}

/** Mono section label (project names, scope labels): 8.5–10px, .12em, #7a7a86. */
export function MonoLabel({
  children,
  size = 9,
  tint = color.label,
  rule = false,
}: {
  children: string
  size?: number
  tint?: string
  rule?: boolean
}) {
  return (
    <View style={styles.labelRow}>
      <Text style={[monoLabel(size), { color: tint }]} numberOfLines={1}>
        {children}
      </Text>
      {rule ? <View style={styles.rule} /> : null}
    </View>
  )
}

const styles = StyleSheet.create({
  pill: {
    backgroundColor: color.needsYou,
    alignItems: 'center',
    justifyContent: 'center',
  },
  pillText: {
    color: color.onAccent,
  },
  labelRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  rule: {
    flex: 1,
    height: StyleSheet.hairlineWidth,
    backgroundColor: color.hairline,
  },
})
