import type { JSX } from 'react'
import { useEffect, useRef } from 'react'
import logoUrl from '@/lib/icons/podium-logo.svg'

/** viewBox of podium-logo.svg — the asset has no intrinsic width/height. */
const LOGO_W = 826.4
const LOGO_H = 317.7

const COLS = 120
/** Character-cell aspect correction: a monospace cell is ~0.6 as wide as tall. */
const CELL_ASPECT = 0.6
/** Brightness ramp, darkest → densest (design handoff SP: Podium ASCII Loader). */
const RAMP = ' .`\'^",:;!i~+_-?][}{1)(|/tfjrxnuvczXYUJCLQ0OZmwqpdbkhao*#MW&8%B@$'
/** Cells reveal in random order across this window, sparkling as they resolve.
 *  Kept short and front-loaded (REVEAL_EXP > 1 → most cells land in the first
 *  ~0.3s) so even a brief cold start clearly reads as the wordmark. */
const REVEAL_SECONDS = 0.8
const REVEAL_EXP = 1.6
const SPARKLE_SECONDS = 0.2

/**
 * Cold-start splash animation: the wordmark rendered as ASCII art. The logo's
 * alpha channel is sampled into a COLS-wide character grid; cells reveal in
 * random order with a brief sparkle, then a sine wave shimmers across the
 * resolved glyphs. Honors prefers-reduced-motion by drawing one static frame.
 */
export function AsciiLoader(): JSX.Element {
  const preRef = useRef<HTMLPreElement>(null)
  const labelRef = useRef<HTMLSpanElement>(null)

  useEffect(() => {
    const pre = preRef.current
    const label = labelRef.current
    if (!pre) return
    const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches
    let raf = 0
    let disposed = false

    const start = (img: HTMLImageElement): void => {
      const rows = Math.round(COLS * (LOGO_H / LOGO_W) * CELL_ASPECT)
      const canvas = document.createElement('canvas')
      canvas.width = COLS
      canvas.height = rows
      const ctx = canvas.getContext('2d')
      if (!ctx) return
      ctx.drawImage(img, 0, 0, COLS, rows)
      const data = ctx.getImageData(0, 0, COLS, rows).data
      const cov = new Float32Array(COLS * rows)
      for (let i = 0; i < cov.length; i++) cov[i] = (data[i * 4 + 3] ?? 0) / 255

      const inked: number[] = []
      for (let i = 0; i < cov.length; i++) if ((cov[i] ?? 0) > 0.05) inked.push(i)
      for (let i = inked.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1))
        const a = inked[i] as number
        inked[i] = inked[j] as number
        inked[j] = a
      }
      const revealAt = new Float32Array(cov.length).fill(Number.POSITIVE_INFINITY)
      inked.forEach((cell, k) => {
        revealAt[cell] = (k / inked.length) ** REVEAL_EXP * REVEAL_SECONDS
      })

      const startTime = performance.now()
      const n = RAMP.length - 1
      const render = (t: number): void => {
        let out = ''
        for (let y = 0; y < rows; y++) {
          for (let x = 0; x < COLS; x++) {
            const i = y * COLS + x
            const cvg = cov[i] as number
            if (cvg <= 0.05) {
              out += ' '
              continue
            }
            const dt = t - (revealAt[i] as number)
            if (dt < 0) {
              out += ' '
              continue
            }
            let b: number
            if (dt < SPARKLE_SECONDS) {
              b = Math.random()
            } else {
              b = cvg * (0.62 + 0.38 * Math.sin(x * 0.22 + y * 0.13 - t * 3.2))
            }
            out += RAMP[Math.max(1, Math.round(b * n))]
          }
          out += '\n'
        }
        pre.textContent = out
        if (label) label.textContent = `LOADING${'.'.repeat(1 + (Math.floor(t * 2) % 3))}`
      }

      if (reduceMotion) {
        // One fully-revealed static frame: past the reveal window, wave frozen.
        render(REVEAL_SECONDS + SPARKLE_SECONDS + 1)
        if (label) label.textContent = 'LOADING'
        return
      }
      const loop = (): void => {
        raf = requestAnimationFrame(loop)
        render((performance.now() - startTime) / 1000)
      }
      loop()
    }

    const img = new Image()
    img.onload = () => {
      if (!disposed) start(img)
    }
    img.src = logoUrl
    return () => {
      disposed = true
      cancelAnimationFrame(raf)
    }
  }, [])

  return (
    <>
      <pre ref={preRef} className="app-loading-ascii" aria-hidden="true" />
      <span ref={labelRef} className="app-loading-label" aria-hidden="true">
        LOADING
      </span>
      <span className="sr-only">Loading Podium…</span>
    </>
  )
}
