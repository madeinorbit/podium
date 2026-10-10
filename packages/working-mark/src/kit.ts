/**
 * A little 3D kit for the designs: x right, y down, z toward the viewer; units are em of the mark's size, from
 * its centre. Everything here is a plain function or a lazily built table, so importing one design pulls in only
 * what it uses and nothing runs at import time.
 */
import type { Pose } from './types'

export const TAU = Math.PI * 2
export const DEG = Math.PI / 180
/** 137.5°, the golden angle. */
export const GOLDEN = Math.PI * (3 - Math.sqrt(5))
export const lerp = (a: number, b: number, t: number): number => a + (b - a) * t
export const clamp01 = (t: number): number => Math.max(0, Math.min(1, t))
export const smooth = (t: number): number => {
  const c = clamp01(t)
  return c * c * (3 - 2 * c)
}
export const frac = (x: number): number => x - Math.floor(x)
export const easeOutBack = (t: number): number => {
  const c1 = 1.70158
  return 1 + (c1 + 1) * (t - 1) ** 3 + c1 * (t - 1) ** 2
}
export const easeInOutBack = (t: number): number => {
  const c2 = 1.70158 * 1.525
  return t < 0.5
    ? ((2 * t) ** 2 * ((c2 + 1) * 2 * t - c2)) / 2
    : ((2 * t - 2) ** 2 * ((c2 + 1) * (2 * t - 2) + c2) + 2) / 2
}
export const P = (x: number, y: number, z = 0): Pose => ({ x, y, z })
export const rotX = (p: Pose, a: number): Pose => {
  const c = Math.cos(a)
  const s = Math.sin(a)
  const z = p.z ?? 0
  return { ...p, y: p.y * c - z * s, z: p.y * s + z * c }
}
export const rotY = (p: Pose, a: number): Pose => {
  const c = Math.cos(a)
  const s = Math.sin(a)
  const z = p.z ?? 0
  return { ...p, x: p.x * c + z * s, z: -p.x * s + z * c }
}
export const rotZ = (p: Pose, a: number): Pose => {
  const c = Math.cos(a)
  const s = Math.sin(a)
  return { ...p, x: p.x * c - p.y * s, y: p.x * s + p.y * c }
}
export const ring = (r: number, a: number): Pose => P(r * Math.cos(a), r * Math.sin(a))
/** An orbit tilted away from the viewer by `tilt`, then turned in the picture plane by `turn`. */
export const orbit = (p: Pose, tilt: number, turn: number): Pose => rotZ(rotX(p, tilt), turn)
/** Opacity for a dot that may pass behind a central body of radius `rad`. */
export const behind = (p: Pose, rad: number): number =>
  (p.z ?? 0) < 0 ? 1 - 0.88 * (1 - smooth((Math.hypot(p.x, p.y) - rad * 0.6) / (rad * 1.2))) : 1
/** Kepler's equation M = E − e sin E, solved for the eccentric anomaly E. */
export const kepler = (M: number, e: number): number => {
  let E = M + e * Math.sin(M)
  for (let i = 0; i < 8; i++) E -= (E - e * Math.sin(E) - M) / (1 - e * Math.cos(E))
  return E
}

/** Today's 8-dot cell (66 × 100 viewBox), in em from its centre: two columns of four. */
export const GRID: readonly Pose[] = [
  { x: -0.16, y: -0.32, z: 0 },
  { x: 0.16, y: -0.32, z: 0 },
  { x: -0.16, y: -0.11, z: 0 },
  { x: 0.16, y: -0.11, z: 0 },
  { x: -0.16, y: 0.11, z: 0 },
  { x: 0.16, y: 0.11, z: 0 },
  { x: -0.16, y: 0.32, z: 0 },
  { x: 0.16, y: 0.32, z: 0 },
]

/** Builds a table the first time it is asked for. */
const lazy = <T>(build: () => T): (() => T) => {
  let value: T | undefined
  return () => {
    if (value === undefined) value = build()
    return value
  }
}

/** The order-2 Moore curve (Hilbert's closed cousin) through a 4 × 4 grid. */
export const moore = lazy(() =>
  [
    [1, 0],
    [0, 0],
    [0, 1],
    [1, 1],
    [1, 2],
    [0, 2],
    [0, 3],
    [1, 3],
    [2, 3],
    [3, 3],
    [3, 2],
    [2, 2],
    [2, 1],
    [3, 1],
    [3, 0],
    [2, 0],
  ].map(([gx, gy]) => P(((gx ?? 0) - 1.5) * 0.26, (1.5 - (gy ?? 0)) * 0.26)),
)

/** The comet's orbit; its sun sits at the ellipse's focus, placed so the whole orbit is centred in the box. */
export const COMET = { e: 0.55, a: 0.32, turn: -25 * DEG }
export const cometSun = lazy(() => rotZ(P(COMET.a * COMET.e, 0), COMET.turn))

/** The heart curve's Fourier coefficients, so a chain of spinning arms can draw it. */
const heartCurve = (t: number): Pose =>
  P(
    16 * Math.sin(t) ** 3,
    -(13 * Math.cos(t) - 5 * Math.cos(2 * t) - 2 * Math.cos(3 * t) - Math.cos(4 * t)),
  )
const heart = lazy(() => {
  const N = 256
  const cs: { n: number; re: number; im: number }[] = []
  for (let n = -4; n <= 4; n++) {
    let re = 0
    let im = 0
    for (let j = 0; j < N; j++) {
      const t = (TAU * j) / N
      const z = heartCurve(t)
      const c = Math.cos(n * t)
      const s = Math.sin(n * t)
      re += z.x * c + z.y * s
      im += z.y * c - z.x * s
    }
    cs.push({ n, re: re / N, im: im / N })
  }
  const c0 = cs.find((c) => c.n === 0) ?? { n: 0, re: 0, im: 0 }
  const arms = cs
    .filter((c) => c.n && Math.hypot(c.re, c.im) > 1e-6)
    .sort((a, b) => Math.hypot(b.re, b.im) - Math.hypot(a.re, a.im))
  return { c0, arms }
})
export const heartAt = (t: number, arms: number): Pose => {
  const h = heart()
  let x = h.c0.re
  let y = h.c0.im
  for (const c of h.arms.slice(0, arms)) {
    const a = c.n * t
    x += c.re * Math.cos(a) - c.im * Math.sin(a)
    y += c.re * Math.sin(a) + c.im * Math.cos(a)
  }
  return P(x * 0.026, (y - 2.5) * 0.026)
}

/**
 * A repeating two-wing path shaped after the Lorenz attractor: about 2.5 laps round the left wing, a crossing, 2.5
 * laps the other way round the right wing, and a crossing back.
 */
const lobe = (v: number): number => smooth((v - 0.42) / 0.08) - smooth((v - 0.92) / 0.08)
const grow = (v: number): number =>
  v < 0.42
    ? v / 0.42
    : v < 0.5
      ? 1 - smooth((v - 0.42) / 0.08)
      : v < 0.92
        ? (v - 0.5) / 0.42
        : 1 - smooth((v - 0.92) / 0.08)
const wing = lazy(() => {
  // The wing angle turns one way on the left wing and the other way on the right; it leaves each wing pointing at
  // the other one (0 at v = .42, π at v = .92) and comes back to where it started.
  const n = 4000
  const K = (5 * Math.PI) / 0.42
  const out = new Float64Array(n + 1)
  out[0] = Math.PI
  for (let i = 0; i < n; i++) out[i + 1] = (out[i] ?? 0) + (K * (1 - 2 * lobe((i + 0.5) / n))) / n
  return out
})
export const lorenz = (v: number): Pose => {
  const w = wing()
  const x = v * 4000
  const i = Math.min(3999, Math.floor(x))
  const a = lerp(w[i] ?? 0, w[i + 1] ?? 0, x - i)
  const r = 0.05 + 0.15 * grow(v)
  return P(
    lerp(-0.21, 0.21, lobe(v)) + r * Math.cos(a),
    0.9 * r * Math.sin(a),
    (lobe(v) - 0.5) * 0.24,
  )
}
