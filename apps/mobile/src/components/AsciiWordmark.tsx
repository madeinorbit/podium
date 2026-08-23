import { useEffect, useRef, useState } from 'react'
import { Platform, StyleSheet, Text } from 'react-native'
import { useReducedMotion as useReducedMotionAtLaunch } from 'react-native-reanimated'
import { useReduceMotion } from '../hooks/useReduceMotion'
import { ASCII_COVERAGE } from './podium-ascii'

/**
 * The PODIUM wordmark as ASCII — the SAME effect as the web login/loader
 * (apps/web LoginGate + AsciiLoader): the precomputed 96×22 coverage grid is
 * mapped onto a density ramp. The loader variant reveals cells in random order
 * with a brief sparkle, then settles. Idle wordmarks stay still, and reduced
 * motion renders the settled frame without starting the reveal.
 */
const RAMP = ' .`\'^",:;!i~+_-?][}{1)(|/tfjrxnuvczXYUJCLQ0OZmwqpdbkhao*#MW&8%B@$'

/** Reveal timing (web AsciiLoader values): front-loaded random reveal. */
const REVEAL_SECONDS = 0.8
const REVEAL_EXP = 1.6
const SPARKLE_SECONDS = 0.2
const FPS = 30
export const REVEAL_DURATION_MS = (REVEAL_SECONDS + SPARKLE_SECONDS) * 1000

/** Stable per-cell reveal offsets (computed once per mount). */
function makeRevealAt(): Float32Array {
  const cells = ASCII_COVERAGE.length * (ASCII_COVERAGE[0]?.length ?? 0)
  const cols = ASCII_COVERAGE[0]?.length ?? 0
  const inked: number[] = []
  for (const [y, line] of ASCII_COVERAGE.entries()) {
    for (let x = 0; x < line.length; x++) {
      if (parseInt(line.charAt(x), 16) > 0) inked.push(y * cols + x)
    }
  }
  for (let i = inked.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    const a = inked[i] as number
    inked[i] = inked[j] as number
    inked[j] = a
  }
  const revealAt = new Float32Array(cells).fill(Number.POSITIVE_INFINITY)
  inked.forEach((cell, k) => {
    revealAt[cell] = (k / inked.length) ** REVEAL_EXP * REVEAL_SECONDS
  })
  return revealAt
}

function frame(t: number | null, revealAt: Float32Array | null): string {
  const n = RAMP.length - 1
  const cols = ASCII_COVERAGE[0]?.length ?? 0
  let out = ''
  for (const [y, line] of ASCII_COVERAGE.entries()) {
    for (let x = 0; x < line.length; x++) {
      const v = parseInt(line.charAt(x), 16)
      if (v === 0) {
        out += ' '
        continue
      }
      const cov = v / 15
      let b: number
      if (t === null) {
        b = cov
      } else if (revealAt) {
        const dt = t - (revealAt[y * cols + x] as number)
        if (dt < 0) {
          out += ' '
          continue
        }
        b =
          dt < SPARKLE_SECONDS
            ? Math.random()
            : cov * (0.62 + 0.38 * Math.sin(x * 0.22 + y * 0.13 - t * 3.2))
      } else b = cov
      out += RAMP.charAt(Math.min(n, Math.max(1, Math.round(b * n))))
    }
    out += '\n'
  }
  return out
}

/**
 * @param variant 'shimmer' — a settled wordmark for idle screens;
 *                'reveal' — one random-order sparkle reveal at launch.
 */
export function AsciiWordmark({
  color,
  fontSize = 6.5,
  variant = 'shimmer',
}: {
  color: string
  fontSize?: number
  variant?: 'shimmer' | 'reveal'
}) {
  const reducedMotionAtLaunch = useReducedMotionAtLaunch()
  const reduceMotionSetting = useReduceMotion()
  const reduced = reducedMotionAtLaunch || reduceMotionSetting
  const revealAtRef = useRef<Float32Array | null>(null)
  if (!reduced && variant === 'reveal' && revealAtRef.current === null) {
    revealAtRef.current = makeRevealAt()
  }
  const [text, setText] = useState(() => frame(null, null))

  useEffect(() => {
    if (reduced || variant === 'shimmer') {
      setText(frame(null, null))
      return
    }
    const start = Date.now()
    setText(frame(0, revealAtRef.current))
    const id = setInterval(() => {
      const elapsed = Date.now() - start
      if (elapsed >= REVEAL_DURATION_MS) {
        clearInterval(id)
        setText(frame(null, null))
        return
      }
      setText(frame(elapsed / 1000, revealAtRef.current))
    }, 1000 / FPS)
    return () => clearInterval(id)
  }, [reduced, variant])

  return (
    <Text
      accessibilityRole="image"
      accessibilityLabel="Podium"
      style={[
        styles.pre,
        { color, fontSize, lineHeight: fontSize },
        Platform.OS === 'web' ? ({ whiteSpace: 'pre' } as object) : null,
      ]}
    >
      {text}
    </Text>
  )
}

const styles = StyleSheet.create({
  pre: {
    fontFamily: Platform.select({ web: 'Menlo, Consolas, monospace', default: 'Courier' }),
    letterSpacing: 0,
  },
})
