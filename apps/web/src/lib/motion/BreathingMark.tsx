/**
 * THE BREATH (POD-993) — the working mark at the END of the feed, and on the tab
 * that leads to it.
 *
 * The braille spinner stays the system's machine-voice spinner: it rides inside
 * work lines, sidebar rows and menu rows, where a mono glyph sits in a mono line
 * and anything else would be a foreign object. The tail is a different problem.
 * It is the one place in the window a reader WATCHES while nothing else is
 * happening — they sent a message and are waiting for the agent to speak — and a
 * ten-frame stepped glyph read there as a terminal artefact rather than as the
 * app thinking.
 *
 * So the tail gets a mark that INHALES. A face-on ring of dots whose radius
 * undulates: two travelling waves around the circumference, three lanes deep,
 * brightest where a lobe swells. It does not spin and it does not pulse — there
 * is no frame you could point at as "the beat" — which is what separates it from
 * every progress affordance in the app and is why it can be watched for a minute
 * without becoming irritating.
 *
 * Why canvas and not CSS: the effect is per-dot, and the phase of each dot is a
 * function of its angle, so in CSS it would be 26 elements × 3 lanes = 78 nodes
 * each carrying its own delayed keyframe — 78 animated boxes at the hot end of a
 * feed that is already streaming. One canvas is one composited layer, painted
 * from a single shared rAF loop no matter how many marks are mounted, and it
 * stops dead the moment the last one unmounts.
 *
 * It is licensed by the same predicate as the spinner (DESIGN.md §5, amended by
 * this issue): it renders ONLY while the session is genuinely computing or a
 * message is in transport to it, and gating remains the caller's job. Under
 * `prefers-reduced-motion` it paints one frame and never asks for another — the
 * mark remains, the breathing does not.
 */
import { type JSX, useEffect, useRef } from 'react'
import { cn } from '@/lib/utils'

/** Canvas backing scale. Fixed rather than read from the display: these are
 *  sub-pixel dots, and 3× is crisp everywhere while costing 17KB of texture. */
const SCALE = 3

/** Paint one frame of the ring. `t` is seconds — any monotonic clock will do,
 *  and every mark on screen is handed the same one so they breathe together. */
function paintOrb(
  ctx: CanvasRenderingContext2D,
  el: HTMLCanvasElement,
  color: string,
  t: number,
  n: number,
  lanes: number,
): void {
  const w = el.width
  const c = w / 2
  const R = c * 0.72
  ctx.clearRect(0, 0, w, w)
  ctx.fillStyle = color
  const half = (lanes - 1) / 2
  for (let lane = 0; lane < lanes; lane++) {
    const off = lane - half
    for (let k = 0; k < n; k++) {
      const a = (k / n) * Math.PI * 2
      // Two waves, three and five lobes, running at different speeds and in
      // opposite directions, so the ring never repeats a recognisable pose.
      const wob = 0.17 * Math.sin(a * 3 - t * 1.55 + off * 0.26) + 0.07 * Math.sin(a * 5 + t * 1.05)
      const rr = (R + off * 0.075 * R) * (1 + wob * 0.55)
      const swell = 0.5 + 0.5 * Math.sin(a * 3 - t * 1.55)
      ctx.globalAlpha = (0.3 + 0.7 * swell) * (off === 0 ? 1 : 0.5)
      ctx.beginPath()
      ctx.arc(
        c + Math.cos(a) * rr,
        c + Math.sin(a) * rr,
        (off === 0 ? 0.62 : 0.5) * SCALE,
        0,
        6.2832,
      )
      ctx.fill()
    }
  }
  ctx.globalAlpha = 1
}

/** Every mounted mark, painted from one loop on one clock. */
const painters = new Set<(t: number) => void>()
let frameHandle: number | null = null

function tick(): void {
  const t = performance.now() / 1000
  for (const paint of painters) paint(t)
  frameHandle = painters.size > 0 ? requestAnimationFrame(tick) : null
}

function start(): void {
  if (frameHandle === null && painters.size > 0) frameHandle = requestAnimationFrame(tick)
}

function prefersReducedMotion(): boolean {
  return typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches
}

export function BreathingMark({
  size = 14,
  className,
}: {
  /** Box size in px. Below 18px the ring drops to one lane and fewer dots —
   *  three lanes inside 14px is mud, not depth. */
  size?: number
  className?: string
}): JSX.Element {
  const ref = useRef<HTMLCanvasElement | null>(null)

  useEffect(() => {
    const el = ref.current
    const ctx = el?.getContext('2d')
    // jsdom and any canvas-less environment: the element stands, unpainted.
    if (!el || !ctx) return
    const dots = size >= 18 ? 26 : 18
    const lanes = size >= 18 ? 3 : 1

    // The ink follows the theme, but re-reading it every frame would force a
    // style recalc 60×/s against a feed that is mutating underneath us. A
    // quarter-second of staleness after a theme switch is not perceivable.
    let color = getComputedStyle(el).color
    let age = 0
    const paint = (t: number): void => {
      if (age-- <= 0) {
        color = getComputedStyle(el).color
        age = 15
      }
      paintOrb(ctx, el, color, t, dots, lanes)
    }

    if (prefersReducedMotion()) {
      // One frame, then stillness. Painted on the next tick so the element has
      // its computed colour by the time we read it.
      const once = requestAnimationFrame(() => paint(0))
      return () => cancelAnimationFrame(once)
    }
    painters.add(paint)
    start()
    return () => {
      painters.delete(paint)
    }
  }, [size])

  // Decorative: the tail's own label and timer, and the tab's own name, carry
  // the state for readers.
  return (
    <canvas
      ref={ref}
      aria-hidden
      data-testid="breathing-mark"
      width={size * SCALE}
      height={size * SCALE}
      className={cn('breath', className)}
      style={{ width: size, height: size }}
    />
  )
}
