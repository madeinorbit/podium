import { type ReactNode, useEffect, useRef } from 'react'
import { setTextIfChanged, startAsciiAnimation } from '@/lib/ascii-animation'
import { ASCII_COVERAGE } from './podium-ascii'

/* ── ASCII wordmark ─────────────────────────────────────────────────────────
   The PODIUM wordmark ships as a precomputed 96×22 coverage grid (one hex
   nibble per cell — see scripts/generate-login-ascii.ts). Rendering maps
   coverage onto a density ramp; the idle shimmer only remaps characters.

   It lives here rather than in `LoginGate` because it is the identity of every
   screen Podium shows BEFORE (or instead of) the app: the login screen, the
   setup console, and the boot failures. Importing it from the login module
   dragged the whole password screen into a bundle that only needed a logo. */

/** True when the operator asked not to be moved. */
export function prefersReducedMotion(): boolean {
  return (
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches
  )
}

const RAMP = ' .`\'^",:;!i~+_-?][}{1)(|/tfjrxnuvczXYUJCLQ0OZmwqpdbkhao*#MW&8%B@$'

/** One frame of the wordmark. `t` is seconds for the shimmer; null renders it static. */
function asciiFrame(t: number | null): string {
  const n = RAMP.length - 1
  let out = ''
  for (const [y, line] of ASCII_COVERAGE.entries()) {
    for (let x = 0; x < line.length; x++) {
      const v = parseInt(line.charAt(x), 16)
      if (v === 0) {
        out += ' '
        continue
      }
      const cov = v / 15
      const b = t === null ? cov : cov * (0.8 + 0.2 * Math.sin(x * 0.22 + y * 0.13 - t * 2.2))
      out += RAMP.charAt(Math.min(n, Math.max(1, Math.round(b * n))))
    }
    out += '\n'
  }
  return out
}

export function AsciiWordmark({ color }: { color: string }): ReactNode {
  const preRef = useRef<HTMLPreElement>(null)

  useEffect(() => {
    const pre = preRef.current
    if (!pre) return
    return startAsciiAnimation({
      renderStatic: () => asciiFrame(null),
      renderFrame: asciiFrame,
      commit: (frame) => {
        if (preRef.current) setTextIfChanged(preRef.current, frame)
      },
      reducedMotion: prefersReducedMotion(),
    })
  }, [])

  return (
    <pre
      ref={preRef}
      role="img"
      aria-label="Podium"
      style={{
        margin: 0,
        minHeight: 143,
        fontFamily: "Menlo, Consolas, 'Courier New', monospace",
        fontSize: '6.5px',
        lineHeight: 1,
        letterSpacing: 0,
        whiteSpace: 'pre',
        userSelect: 'none',
        color,
        transition: 'color .5s',
      }}
    />
  )
}
