import { useSyncExternalStore } from 'react'
import { StyleSheet, Text, View } from 'react-native'
import { color, font, mono, monoLabel } from '../theme/theme'

const FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']
const FRAME_MS = 80

/**
 * One clock for every spinner on screen [POD-366].
 *
 * Each spinner used to own a `setInterval` driving its own `setState`, so a
 * screen with five working sessions ran five timers and five component
 * re-renders 12.5 times a second, forever. They all show the same frame
 * anyway, so they share a single interval that only runs while something is
 * subscribed.
 */
let frame = 0
let timer: ReturnType<typeof setInterval> | null = null
const listeners = new Set<() => void>()

function subscribe(onChange: () => void): () => void {
  listeners.add(onChange)
  if (!timer) {
    timer = setInterval(() => {
      frame = (frame + 1) % FRAMES.length
      for (const listener of listeners) listener()
    }, FRAME_MS)
  }
  return () => {
    listeners.delete(onChange)
    if (listeners.size === 0 && timer) {
      clearInterval(timer)
      timer = null
    }
  }
}

const getFrame = () => frame

/**
 * The motion grammar's braille spinner — mono glyph stepping at .8s per
 * cycle. The ONLY perpetual motion in the app: it means "an agent is
 * computing right now"; nothing else may pulse.
 */
export function BrailleSpinner({
  size = font.micro,
  tint = color.working,
}: {
  size?: number
  tint?: string
}) {
  const current = useSyncExternalStore(subscribe, getFrame, getFrame)
  return (
    <Text
      accessibilityRole="progressbar"
      accessibilityLabel="Working"
      style={[mono(400), { fontSize: size, color: tint }]}
    >
      {FRAMES[current]}
    </Text>
  )
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
