import { useEffect, useRef, useState } from 'react'
import { AccessibilityInfo, Platform, StyleSheet, Text } from 'react-native'
import { ASCII_COVERAGE } from './podium-ascii'

/**
 * The PODIUM wordmark as ASCII — the SAME effect as the web login/loader
 * (apps/web LoginGate + AsciiLoader): the precomputed 96×22 coverage grid is
 * mapped onto a density ramp; the idle shimmer only remaps characters, and the
 * loader variant reveals cells in random order with a brief sparkle first.
 * Honors reduced motion by rendering one static frame.
 */
const RAMP = ' .`\'^",:;!i~+_-?][}{1)(|/tfjrxnuvczXYUJCLQ0OZmwqpdbkhao*#MW&8%B@$'

/** Reveal timing (web AsciiLoader values): front-loaded random reveal. */
const REVEAL_SECONDS = 0.8
const REVEAL_EXP = 1.6
const SPARKLE_SECONDS = 0.2
const FPS = 30

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
      } else {
        b = cov * (0.8 + 0.2 * Math.sin(x * 0.22 + y * 0.13 - t * 2.2))
      }
      out += RAMP.charAt(Math.min(n, Math.max(1, Math.round(b * n))))
    }
    out += '\n'
  }
  return out
}

function useReducedMotion(): boolean {
  const [reduced, setReduced] = useState(false)
  useEffect(() => {
    if (Platform.OS === 'web') {
      const mq =
        typeof window.matchMedia === 'function'
          ? window.matchMedia('(prefers-reduced-motion: reduce)')
          : null
      setReduced(mq?.matches ?? false)
      return
    }
    let alive = true
    void AccessibilityInfo.isReduceMotionEnabled().then((v) => {
      if (alive) setReduced(v)
    })
    return () => {
      alive = false
    }
  }, [])
  return reduced
}

/**
 * @param variant 'shimmer' — resolved glyphs with the idle sine shimmer (login);
 *                'reveal' — random-order sparkle reveal, then shimmer (loader).
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
  const reduced = useReducedMotion()
  const revealAtRef = useRef<Float32Array | null>(null)
  if (variant === 'reveal' && revealAtRef.current === null) revealAtRef.current = makeRevealAt()
  const [text, setText] = useState(() => frame(null, null))

  useEffect(() => {
    if (reduced) {
      setText(frame(null, null))
      return
    }
    const start = Date.now()
    if (variant === 'reveal') setText(frame(0, revealAtRef.current))
    const id = setInterval(() => {
      const t = (Date.now() - start) / 1000
      setText(frame(t, variant === 'reveal' ? revealAtRef.current : null))
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
