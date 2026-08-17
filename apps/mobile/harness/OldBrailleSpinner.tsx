/* The spinner as it stood before this change, kept ONLY so the harness can
   put the two marks side by side and settle the optical sizing. Not shipped. */
import { useSyncExternalStore } from 'react'
import { Text } from 'react-native'
import { color, font, mono } from '../src/theme/theme'

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
