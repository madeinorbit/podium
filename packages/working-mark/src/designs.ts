/**
 * The working-mark designs (POD-5558's gallery, apps/web/harness/working-mark-designs-2.html). Each is a separate
 * named export whose dots are built on first use, so an app that imports one design ships only that one: the rest
 * are dropped by the bundler (the package is `sideEffects: false`, and nothing here runs at import time).
 */
import {
  behind,
  COMET,
  clamp01,
  cometSun,
  DEG,
  easeInOutBack,
  easeOutBack,
  frac,
  GOLDEN,
  GRID,
  heartAt,
  kepler,
  lerp,
  lorenz,
  moore,
  orbit,
  P,
  ring,
  rotX,
  rotY,
  rotZ,
  smooth,
  TAU,
} from './kit'
import type { Design, Dot, Pose } from './types'

const g = (k: number): Pose => GRID[k] ?? P(0, 0)
const eight = [0, 1, 2, 3, 4, 5, 6, 7]
const range = (n: number): number[] => Array.from({ length: n }, (_, i) => i)
const WAVE_DELAY = [0, 120, 210, 330, 420, 540, 630, 750]
const RACE = [0, 2, 4, 6, 7, 5, 3, 1]
const tetraCorners = (): Pose[] =>
  [
    [1, 1, 1],
    [1, -1, -1],
    [-1, 1, -1],
    [-1, -1, 1],
  ].map(([x = 0, y = 0, z = 0]) => P(x * 0.2, y * 0.2, z * 0.2))
/** A 3-ball cascade: 6 beats per ball cycle; throws are 2 beats long, holds 1 beat. */
const juggleBall = (phase: number): Dot => ({
  d: 0.24,
  at: (u) => {
    const b = frac(u + phase) * 6
    const fly = (x0: number, x1: number, s: number): Pose =>
      P(lerp(x0, x1, s), 0.27 - 4 * 0.62 * s * (1 - s))
    const hold = (x0: number, x1: number, s: number): Pose =>
      P(lerp(x0, x1, smooth(s)), 0.27 + 0.06 * Math.sin(Math.PI * s))
    if (b < 2) return fly(0.11, -0.36, b / 2)
    if (b < 3) return hold(-0.36, -0.11, b - 2)
    if (b < 5) return fly(-0.11, 0.36, (b - 3) / 2)
    return hold(0.36, 0.11, b - 5)
  },
})
const moon = (laps: number, turn: number, phase: number): Dot => ({
  d: 0.23,
  at: (u) => {
    const p = orbit(ring(0.4, TAU * (laps * u + phase)), 70 * DEG, turn * DEG)
    return { ...p, o: behind(p, 0.135) }
  },
})

// ---------- the original ----------

export const wave: Design = {
  id: 'wave',
  name: 'Original wave',
  tall: true,
  loop: 1500,
  dots: () =>
    eight.map((k) => ({
      d: 0.22,
      at: (u) => {
        const v = frac(u - (WAVE_DELAY[k] ?? 0) / 1500)
        const lit = v < 0.16 ? v / 0.16 : v < 0.44 ? 1 - (v - 0.16) / 0.28 : 0
        return { ...g(k), s: 0.8 + 0.36 * lit, o: 0.2 + 0.8 * lit }
      },
    })),
  description:
    'The pre-September wave, rebuilt from 8 dots, each fading and swelling on its own clock.',
}

// ---------- the operator's picks, pushed further ----------

export const race: Design = {
  id: 'race',
  name: 'Racetrack',
  tall: true,
  loop: 1200,
  dots: () =>
    eight.map((k) => ({
      d: 0.22,
      at: (u) => {
        const behindHead = frac(u - RACE.indexOf(k) / 8)
        const lit = behindHead < 0.45 ? (1 - behindHead / 0.45) ** 1.6 : 0
        return {
          ...g(k),
          x: g(k).x + (k % 2 ? 1 : -1) * 0.04 * lit,
          s: 0.72 + 0.32 * lit,
          o: 0.16 + 0.84 * lit,
        }
      },
    })),
  description: 'The wave turned into a lap: a bright head with a fading tail runs round the cell.',
}

export const binary: Design = {
  id: 'binary',
  name: 'Binary pair',
  loop: 1400,
  depth: 0.31,
  dots: () => [
    { d: 0.28, at: (u) => orbit(ring(0.25, TAU * u), 64 * DEG, -24 * DEG) },
    { d: 0.25, at: (u) => orbit(ring(0.31, TAU * u + Math.PI), 64 * DEG, -24 * DEG) },
  ],
  description: 'Two near-equal dots circling each other on a tilted orbit.',
}

export const binaryPrecess: Design = {
  id: 'binary-precess',
  name: 'Binary pair, wobbling',
  loop: 4200,
  depth: 0.31,
  dots: () => [
    {
      d: 0.28,
      at: (u) => orbit(ring(0.25, TAU * 3 * u), (60 + 16 * Math.sin(TAU * u)) * DEG, -TAU * u),
    },
    {
      d: 0.25,
      at: (u) =>
        orbit(ring(0.31, TAU * 3 * u + Math.PI), (60 + 16 * Math.sin(TAU * u)) * DEG, -TAU * u),
    },
  ],
  description: 'The binary pair on an orbit that turns and rocks: a slow rosette.',
}

export const haloGyre: Design = {
  id: 'halo-gyre',
  name: 'Halo, tumbling',
  loop: 3600,
  depth: 0.36,
  dots: () =>
    eight.map((j) => ({
      d: 0.19,
      at: (u) =>
        orbit(ring(0.36, TAU * (2 * u + j / 8)), (58 + 24 * Math.sin(TAU * u)) * DEG, TAU * u),
    })),
  description:
    'Eight dots run round a ring while the ring turns and rocks from open to nearly edge-on.',
}

export const haloFlip: Design = {
  id: 'halo-flip',
  name: 'Halo, coin flip',
  loop: 2400,
  depth: 0.36,
  dots: () =>
    eight.map((j) => ({
      d: 0.19,
      at: (u) => rotX(rotY(ring(0.36, TAU * (u + j / 8)), TAU * u), 18 * DEG),
    })),
  description: 'A ring of eight flips over like a spun coin while the dots keep running round it.',
}

export const haloSix: Design = {
  id: 'halo-six',
  name: 'Halo of six, tumbling',
  loop: 3000,
  depth: 0.34,
  dots: () =>
    range(6).map((j) => ({
      d: 0.23,
      at: (u) =>
        orbit(ring(0.34, TAU * (2 * u + j / 6)), (56 + 26 * Math.sin(TAU * u)) * DEG, -TAU * u),
    })),
  description: 'The tumbling halo with six bigger dots, for the smallest sizes.',
}

// ---------- most satisfying ----------

export const tusi: Design = {
  id: 'tusi',
  name: 'Rolling circle',
  loop: 2400,
  dots: () =>
    range(6).map((k) => {
      const th = (k * Math.PI) / 6
      return {
        d: 0.19,
        at: (u) => {
          const m = 0.46 * Math.cos(TAU * u - th)
          return P(m * Math.cos(th), m * Math.sin(th))
        },
      }
    }),
  description:
    'A ring of dots rolls round inside the mark; each dot only slides on a straight line (the Tusi couple).',
}

export const pendulums: Design = {
  id: 'pendulums',
  name: 'Pendulum wave',
  loop: 7200,
  dots: () =>
    range(5).map((k) => ({
      d: 0.17,
      loop: 7200 / (6 + k),
      at: (u) => P(0.3 * Math.cos(TAU * u), -0.36 + 0.18 * k),
    })),
  description: 'Five pendulums drift out of step into waves and snakes, then line up again.',
}

export const cradle: Design = {
  id: 'cradle',
  name: "Newton's cradle",
  loop: 1400,
  dots: () =>
    [-1, 0, 1].map((i) => ({
      d: 0.2,
      at: (u) => {
        const a =
          i === 1 && u < 0.5
            ? 30 * DEG * Math.sin(TAU * u)
            : i === -1 && u >= 0.5
              ? -30 * DEG * Math.sin(TAU * (u - 0.5))
              : 0
        return P(0.2 * i + 0.55 * Math.sin(a), -0.45 + 0.55 * Math.cos(a))
      },
    })),
  description: 'The end ball swings out, falls back and knocks the far ball out, and back again.',
}

export const syzygy: Design = {
  id: 'syzygy',
  name: 'Syzygy',
  loop: 2700,
  depth: 0.42,
  still: [{ d: 0.2, x: 0, y: 0 }],
  dots: () =>
    [
      [0.17, 3, 0.17],
      [0.29, 2, 0.19],
      [0.42, 1, 0.21],
    ].map(([r = 0, laps = 0, d = 0]) => ({
      d,
      at: (u) => {
        const p = orbit(ring(r, TAU * laps * u), 62 * DEG, -12 * DEG)
        const line = Math.max(Math.cos(TAU * 2 * u), 0) ** 30
        return { ...p, s: 1 + 0.16 * line, o: behind(p, 0.1) }
      },
    })),
  description:
    'Three planets round a sun at their own speeds; twice a loop they line up and swell.',
}

export const click: Design = {
  id: 'click',
  name: 'Click',
  loop: 2600,
  rest: 0.55,
  dots: () =>
    eight.map((k) => ({
      d: 0.22,
      at: (u) => {
        const rs = Math.hypot(g(k).x, g(k).y)
        const as = Math.atan2(g(k).y, g(k).x)
        const tin = clamp01((u - k * 0.02) / 0.3)
        const tout = clamp01((u - 0.74 - k * 0.012) / 0.16)
        const placed = easeOutBack(tin) * (1 - tout * tout)
        const snap = Math.exp(-(((u - 0.45) / 0.03) ** 2))
        return {
          ...ring(lerp(0.5, rs, placed), lerp(as + 2.4, as, placed)),
          s: 1 + 0.16 * snap,
          o: smooth(tin / 0.35) * (1 - smooth(tout)),
        }
      },
    })),
  description:
    "The eight dots swirl in and snap into today's mark with a tiny bounce, hold, then swirl away.",
}

export const halfTurn: Design = {
  id: 'flip',
  name: 'Half-turn',
  loop: 2200,
  rest: 0.7,
  dots: () =>
    eight.map((k) => ({
      d: 0.22,
      at: (u) => rotZ(g(k), Math.PI * easeInOutBack(clamp01(u / 0.42))),
    })),
  description: "Today's mark winds back, spins half a turn, overshoots and settles, then rests.",
}

export const bowl: Design = {
  id: 'bowl',
  name: 'Bowl',
  loop: 1800,
  // A getter, like every computed part of a design, so nothing runs at import time.
  get still() {
    return [-2.7, -1.8, -0.9, 0, 0.9, 1.8, 2.7].map((t) => ({
      d: 0.07,
      o: 0.3,
      x: 0.14 * (t + Math.sin(t)),
      y: 0.31 - 0.14 * (1 - Math.cos(t)),
    }))
  },
  dots: () =>
    [0.92, -0.6, 0.3].map((s0) => ({
      d: 0.2,
      at: (u) => {
        const t = 2 * Math.asin(s0 * Math.cos(TAU * u))
        return P(0.14 * (t + Math.sin(t)), 0.2 - 0.14 * (1 - Math.cos(t)))
      },
    })),
  description:
    'Three dots let go at different heights in a cycloid bowl reach the bottom together.',
}

// ---------- space ----------

export const moons: Design = {
  id: 'moons',
  name: 'Planet and moons',
  loop: 3600,
  depth: 0.4,
  still: [{ d: 0.27, x: 0, y: 0 }],
  dots: () => [moon(1, -20, 0), moon(-1, 40, 1 / 3), moon(2, 100, 2 / 3)],
  description: 'A planet with three moons on three tilted orbits; moons pass behind it.',
}

export const electrons: Design = {
  id: 'electrons',
  name: 'Electron cloud',
  loop: 2800,
  depth: 0.34,
  dots: () =>
    range(3).map((k) => ({
      d: 0.25,
      at: (u) => {
        const a = TAU * (2 * u + k / 3)
        const c = 0.34 * Math.cos(a)
        const s = 0.34 * Math.sin(a)
        const p = [P(c, s, 0), P(0, c, s), P(c, 0, s)][k] ?? P(0, 0)
        return rotX(rotY(p, TAU * u), 30 * DEG)
      },
    })),
  description: 'Three dots on three crossing orbits, the whole cloud slowly turning.',
}

export const tetra: Design = {
  id: 'tetra',
  name: 'Tumbling tetrahedron',
  loop: 4000,
  depth: 0.35,
  dots: () =>
    tetraCorners().map((v) => ({ d: 0.25, at: (u) => rotY(rotX(v, TAU * u), TAU * 2 * u) })),
  description: 'Four dots at the corners of an invisible pyramid, tumbling end over end.',
}

export const eightOrbit: Design = {
  id: 'eight',
  name: 'Figure-eight three-body',
  loop: 4500,
  depth: 0.24,
  dots: () =>
    range(3).map((k) => ({
      d: 0.25,
      at: (u) => {
        const v = 3 * u + k / 3
        return rotZ(
          rotY(P(0.4 * Math.sin(TAU * v), 0.2 * Math.sin(2 * TAU * v)), 35 * DEG),
          -TAU * u,
        )
      },
    })),
  description: 'Three equal dots chasing each other round one figure-eight while it turns.',
}

export const comet: Design = {
  id: 'comet',
  name: 'Comet',
  loop: 3600,
  get still() {
    const sun = cometSun()
    return [{ d: 0.17, x: sun.x, y: sun.y }]
  },
  dots: () =>
    [3, 2, 1, 0].map((i) => ({
      d: [0.17, 0.13, 0.1, 0.08][i] ?? 0.1,
      at: (u) => {
        const sun = cometSun()
        const E = kepler(TAU * u, COMET.e)
        const q = rotZ(
          P(COMET.a * (Math.cos(E) - COMET.e), COMET.a * Math.sqrt(1 - COMET.e ** 2) * Math.sin(E)),
          COMET.turn,
        )
        const r = Math.hypot(q.x, q.y)
        const tail = 1 + (Math.min(0.3, 0.026 / r) * i) / 3 / r
        return { ...P(sun.x + q.x * tail, sun.y + q.y * tail), o: [1, 0.62, 0.4, 0.24][i] ?? 1 }
      },
    })),
  description:
    'A comet whips round the sun; its tail points away from the sun and grows as it gets close.',
}

export const blackhole: Design = {
  id: 'blackhole',
  name: 'Black hole',
  loop: 4000,
  depth: 0.42,
  back: { s: 0.72, o: 0.82 },
  dots: () =>
    [
      [0.42, 1, 3, 0.2],
      [0.265, 2, 3, 0.18],
      [0.167, 4, 2, 0.16],
    ].flatMap(([r = 0, laps = 0, n = 0, d = 0]) =>
      range(n).map((j) => ({
        d,
        at: (u: number) => {
          const a = TAU * (laps * u + j / n)
          const p = orbit(ring(r, a), 64 * DEG, -10 * DEG)
          const q = orbit(ring(r, a + 0.01), 64 * DEG, -10 * DEG)
          return { ...p, o: clamp01(0.8 + (0.2 * ((q.z ?? 0) - (p.z ?? 0))) / (0.01 * r)) }
        },
      })),
    ),
  description: 'A disc of dots round an empty middle: inner dots race, outer ones crawl.',
}

export const pulsar: Design = {
  id: 'pulsar',
  name: 'Pulsar',
  loop: 1600,
  depth: 0.41,
  still: [{ d: 0.15, x: 0, y: 0 }],
  dots: () =>
    [1, -1].flatMap((sg) =>
      [0.17, 0.29, 0.41].map((r, i) => ({
        d: [0.15, 0.13, 0.11][i] ?? 0.11,
        at: (u: number) => {
          const m = rotX(
            P(
              Math.sin(40 * DEG) * Math.cos(TAU * u),
              -Math.cos(40 * DEG),
              Math.sin(40 * DEG) * Math.sin(TAU * u),
            ),
            -50 * DEG,
          )
          const beam = Math.max(0, sg * (m.z ?? 0)) ** 4
          return {
            ...P(sg * m.x * r, sg * m.y * r, sg * (m.z ?? 0) * r),
            s: 1 + 0.3 * beam,
            o: 0.5 + 0.5 * beam,
          }
        },
      })),
    ),
  description:
    'A spinning star throws two beams of dots round a cone; once a turn a beam flashes at you.',
}

export const trojans: Design = {
  id: 'trojans',
  name: 'Trojans',
  loop: 4000,
  depth: 0.42,
  still: [{ d: 0.22, x: 0, y: 0 }],
  dots: () => [
    {
      d: 0.2,
      at: (u) => {
        const p = orbit(ring(0.38, TAU * u), 64 * DEG, -15 * DEG)
        return { ...p, o: behind(p, 0.11) }
      },
    },
    ...[
      [60, 0],
      [60, 0.5],
      [-60, 0.25],
      [-60, 0.75],
    ].map(([lead = 0, ph = 0]) => ({
      d: 0.12,
      at: (u: number) => {
        const w = TAU * (2 * u + ph)
        const p = orbit(
          ring(0.38 + 0.025 * Math.cos(w), TAU * u + lead * DEG + 0.22 * Math.sin(w)),
          64 * DEG,
          -15 * DEG,
        )
        return { ...p, o: behind(p, 0.11) }
      },
    })),
  ],
  description: 'A planet circles its star with two little swarms riding along at L4 and L5.',
}

export const tatooine: Design = {
  id: 'tatooine',
  name: 'Tatooine',
  loop: 4800,
  depth: 0.42,
  dots: () => [
    { d: 0.21, at: (u) => orbit(ring(0.09, TAU * 4 * u), 64 * DEG, -15 * DEG) },
    { d: 0.17, at: (u) => orbit(ring(0.12, TAU * 4 * u + Math.PI), 64 * DEG, -15 * DEG) },
    { d: 0.17, at: (u) => orbit(ring(0.4, TAU * u + 1), 64 * DEG, -15 * DEG) },
  ],
  description: 'Two suns waltz round each other while a planet slowly circles both.',
}

// ---------- natural phenomena ----------

export const fireflySync: Design = {
  id: 'firefly-sync',
  name: 'Fireflies in sync',
  loop: 6000,
  dots: () =>
    [
      [-0.3, -0.2, 0],
      [0.05, -0.33, 0.37],
      [0.32, -0.12, 0.71],
      [-0.12, 0.05, 0.19],
      [0.25, 0.25, 0.55],
      [-0.28, 0.3, 0.86],
    ].map(([x = 0, y = 0, ph = 0], k) => ({
      d: 0.21,
      at: (u: number) => {
        const sync = Math.sin(Math.PI * u) ** 2
        const v = frac(8 * u + ph * (1 - sync))
        const flash = Math.exp(-(Math.min(v, 1 - v) ** 2) / 0.003)
        return {
          ...P(
            x + 0.03 * Math.sin(TAU * (k + 1) * u),
            y + 0.03 * Math.cos(TAU * (2 + (k % 3)) * u),
          ),
          s: 0.85 + 0.15 * flash,
          o: 0.2 + 0.8 * flash,
        }
      },
    })),
  description:
    'Six fireflies blinking on their own beats fall into step, flash together, then drift apart.',
}

export const sunflower: Design = {
  id: 'sunflower',
  name: 'Sunflower',
  loop: 4000,
  dots: () =>
    range(10).map((k) => ({
      d: 0.21,
      at: (u) => {
        const age = frac(u + k / 10)
        return {
          ...ring(0.45 * Math.sqrt(age), k * GOLDEN),
          s: 0.35 + 0.65 * age,
          o: smooth(age / 0.12) * (1 - smooth((age - 0.78) / 0.22)),
        }
      },
    })),
  description:
    'Seeds appear in the middle and drift outward at the golden angle: a sunflower head growing.',
}

export const waggle: Design = {
  id: 'waggle',
  name: 'Waggle dance',
  loop: 2600,
  dots: () =>
    [
      [0.1, 0.12, 0.28],
      [0.05, 0.14, 0.45],
      [0, 0.22, 1],
    ].map(([lag = 0, d = 0, o = 1]) => ({
      d,
      at: (u: number) => {
        const v = frac(u - lag)
        const run = (t: number): Pose => P(0.07 * Math.sin(TAU * 4 * t), 0.26 - 0.52 * t)
        let p: Pose
        if (v < 0.32) p = run(v / 0.32)
        else if (v < 0.5) {
          const t = (v - 0.32) / 0.18
          p = P(0.26 * Math.sin(Math.PI * t), -0.26 * Math.cos(Math.PI * t))
        } else if (v < 0.82) p = run((v - 0.5) / 0.32)
        else {
          const t = (v - 0.82) / 0.18
          p = P(-0.26 * Math.sin(Math.PI * t), -0.26 * Math.cos(Math.PI * t))
        }
        return { ...rotZ(p, 25 * DEG), o }
      },
    })),
  description: 'A bee dances a waggle run and loops back, two followers tagging along.',
}

export const mitosis: Design = {
  id: 'mitosis',
  name: 'Mitosis',
  loop: 2000,
  rest: 0.7,
  dots: () =>
    [
      [-1, -1],
      [-1, 1],
      [1, -1],
      [1, 1],
    ].map(([sx = 0, sy = 0]) => ({
      d: 0.3,
      at: (u: number) => {
        const a = easeOutBack(clamp01((u - 0.12) / 0.2))
        const b = easeOutBack(clamp01((u - 0.46) / 0.2))
        const out = smooth((u - 0.8) / 0.17)
        // Each division first stretches the cell along its axis, then it pops apart.
        const pull1 = Math.exp(-(((u - 0.11) / 0.045) ** 2))
        const pull2 = Math.exp(-(((u - 0.45) / 0.045) ** 2))
        return {
          ...P(sx * (0.15 * a + 0.14 * out), sy * (0.15 * b + 0.14 * out)),
          s: 1 - 0.18 * a - 0.14 * b,
          sx: 1 + 0.35 * pull1 - 0.1 * pull2,
          sy: 1 - 0.1 * pull1 + 0.35 * pull2,
          o: smooth(u / 0.06) * (1 - out),
        }
      },
    })),
  description:
    'One cell stretches and pops into two, then four; they drift off and a new cell appears.',
}

export const murmuration: Design = {
  id: 'murmuration',
  name: 'Murmuration',
  loop: 6000,
  depth: 0.14,
  dots: () =>
    [
      [0, 0, 0],
      [-0.09, 0.05, 0.08],
      [-0.08, -0.06, -0.06],
      [-0.17, 0, 0.02],
      [-0.16, 0.1, -0.08],
      [0.07, 0.04, -0.04],
      [-0.05, -0.11, 0.1],
    ].map(([ox = 0, oy = 0, oz = 0], k) => ({
      d: 0.17,
      at: (u: number) => {
        const cx = 0.2 * Math.sin(TAU * u)
        const cy = 0.13 * Math.sin(TAU * 2 * u)
        const heading = Math.atan2(0.26 * Math.cos(TAU * 2 * u), 0.2 * Math.cos(TAU * u))
        const spread = 0.8 + 0.4 * Math.sin(TAU * 3 * u + k * 0.4)
        const squash = 1 - 0.55 * Math.sin(TAU * 2 * u + 0.5) ** 2
        const f = rotZ(P(ox * spread * 1.7, oy * spread * squash * 1.4, oz), heading)
        return P(
          cx + f.x + 0.015 * Math.sin(TAU * (5 + k) * u),
          cy + f.y + 0.015 * Math.cos(TAU * (4 + k) * u),
          f.z,
        )
      },
    })),
  description: 'A small flock wheeling as one, stretching and bunching as it turns.',
}

export const drop: Design = {
  id: 'drop',
  name: 'Drop',
  loop: 2200,
  dots: () => [
    {
      d: 0.17,
      at: (u) => {
        const v = frac(u + 0.15)
        const t = clamp01(v / 0.3)
        return { ...P(0, -0.46 + 0.48 * t * t), o: v < 0.3 ? smooth(v / 0.06) : 0 }
      },
    },
    {
      d: 0.13,
      at: (u) => {
        const t = (u - 0.19) / 0.3
        return { ...P(0, 0.02 - 1.2 * clamp01(t) * (1 - clamp01(t))), o: t > 0 && t < 1 ? 1 : 0 }
      },
    },
    ...range(6).map((k) => ({
      d: 0.13,
      at: (u: number) => {
        const t = clamp01((u - 0.15) / 0.72)
        const r = 0.44 * (1 - (1 - t) ** 3)
        const a = (TAU * k) / 6 + 0.3
        return {
          ...P(r * Math.cos(a), 0.02 + 0.4 * r * Math.sin(a)),
          o: u > 0.15 ? (1 - t) ** 1.3 : 0,
        }
      },
    })),
  ],
  description: 'A drop falls, ripples spread, and a little droplet jumps back up.',
}

// ---------- a formula underneath ----------

export const knot: Design = {
  id: 'knot',
  name: 'Knot',
  loop: 3600,
  depth: 0.21,
  dots: () =>
    range(6).map((k) => ({
      d: 0.19,
      at: (u) => {
        const t = TAU * (u + k / 6)
        const p = P(
          0.14 * (Math.sin(t) + 2 * Math.sin(2 * t)),
          0.14 * (Math.cos(t) - 2 * Math.cos(2 * t)) + 0.07,
          -0.21 * Math.sin(3 * t),
        )
        return rotY(p, 0.5 * Math.sin(TAU * u))
      },
    })),
  description: 'Six dots running along a trefoil knot while the knot sways.',
}

export const mobius: Design = {
  id: 'mobius',
  name: 'Möbius',
  loop: 4000,
  depth: 0.3,
  dots: () =>
    range(6).map((k) => ({
      d: 0.18,
      at: (u) => {
        const t = 2 * TAU * (u + k / 6)
        const w = 0.14 * Math.cos(t / 2)
        return orbit(
          P((0.3 + w) * Math.cos(t), (0.3 + w) * Math.sin(t), 0.14 * Math.sin(t / 2)),
          60 * DEG,
          -10 * DEG,
        )
      },
    })),
  description: 'Dots running along the single edge of a twisted band.',
}

export const heart: Design = {
  id: 'heart',
  name: 'Heart',
  loop: 3600,
  dots: () => [
    ...[1, 2, 3].map((arms) => ({
      d: 0.1,
      at: (u: number) => ({ ...heartAt(TAU * u, arms), o: 0.35 }),
    })),
    ...[7, 6, 5, 4, 3, 2, 1, 0].map((j) => ({
      d: 0.2 - 0.013 * j,
      at: (u: number) => ({
        ...heartAt(TAU * u - 0.3 * j, Number.POSITIVE_INFINITY),
        o: 1 - 0.11 * j,
      }),
    })),
  ],
  description:
    'A dot drawing a heart, pulled along by a chain of spinning arms (Fourier epicycles).',
}

export const snake: Design = {
  id: 'snake',
  name: 'Snake',
  loop: 2400,
  dots: () =>
    [3, 2, 1, 0].map((i) => ({
      d: 0.2,
      at: (u) => {
        const m = moore()
        const s = 16 * u - i
        const k = Math.floor(s)
        const f = smooth(s - k)
        const a = m[((k % 16) + 16) % 16] ?? P(0, 0)
        const b = m[(((k + 1) % 16) + 16) % 16] ?? P(0, 0)
        return {
          ...P(lerp(a.x, b.x, f), lerp(a.y, b.y, f)),
          s: [1, 0.9, 0.8, 0.72][i] ?? 1,
          o: [1, 0.68, 0.45, 0.28][i] ?? 1,
        }
      },
    })),
  description: 'A four-dot snake hopping through a 4 × 4 grid along the Moore curve.',
}

export const nautilus: Design = {
  id: 'nautilus',
  name: 'Nautilus',
  loop: 3200,
  dots: () =>
    eight.map((k) => ({
      d: 0.22,
      at: (u) => {
        const age = frac(u + k / 8)
        const turn = TAU * 1.45 * age
        const r = 0.035 * Math.exp((Math.log((1 + Math.sqrt(5)) / 2) / (Math.PI / 2)) * turn)
        return {
          ...ring(r, turn + (k % 2) * Math.PI - TAU * u),
          s: 0.3 + 0.7 * Math.min(1, r / 0.45),
          o: smooth(age / 0.14) * (1 - smooth((age - 0.8) / 0.2)),
        }
      },
    })),
  description: 'Dots unwinding from the centre along two golden logarithmic spiral arms.',
}

export const globe: Design = {
  id: 'globe',
  name: 'Globe',
  loop: 5000,
  depth: 0.38,
  dots: () =>
    range(12).map((i) => {
      const z = 1 - (2 * (i + 0.5)) / 12
      const rr = Math.sqrt(1 - z * z)
      const a = i * GOLDEN
      return {
        d: 0.15,
        at: (u: number) =>
          rotX(
            rotY(P(0.38 * rr * Math.cos(a), 0.38 * z, 0.38 * rr * Math.sin(a)), TAU * u),
            20 * DEG,
          ),
      }
    }),
  description: 'Twelve dots spread evenly over a turning ball (a Fibonacci sphere).',
}

export const squircle: Design = {
  id: 'squircle',
  name: 'Squircle',
  loop: 3600,
  dots: () =>
    eight.map((k) => ({
      d: 0.19,
      at: (u) => {
        const n = 2 * 2.6 ** Math.sin(TAU * u)
        const t = TAU * (k / 8 + u)
        const c = Math.cos(t)
        const s = Math.sin(t)
        return P(
          0.38 * Math.sign(c) * Math.abs(c) ** (2 / n),
          0.38 * Math.sign(s) * Math.abs(s) ** (2 / n),
        )
      },
    })),
  description:
    'A ring of dots reshaping through circle, rounded square and four-pointed star (Lamé curves).',
}

export const butterfly: Design = {
  id: 'butterfly',
  name: 'Butterfly',
  loop: 4800,
  depth: 0.3,
  dots: () =>
    [8, 7, 6, 5, 4, 3, 2, 1, 0].map((j) => ({
      d: 0.21 - 0.012 * j,
      at: (u) => ({ ...lorenz(frac(u - 0.016 * j)), o: 1 - 0.1 * j }),
    })),
  description:
    'A dot spiralling round one wing and flipping to the other, after the Lorenz attractor.',
}

// ---------- funky dots ----------

export const juggle: Design = {
  id: 'juggle',
  name: 'Juggler',
  loop: 1500,
  dots: () => [juggleBall(0), juggleBall(1 / 3), juggleBall(2 / 3)],
  description: 'Three dots juggled in a cascade, crossing in the middle.',
}

export const chase: Design = {
  id: 'chase',
  name: 'Chase',
  loop: 1700,
  dots: () =>
    range(5).map((k) => ({
      d: 0.21,
      at: (u) => {
        const v = frac(u - k * 0.1)
        return ring(0.36, TAU * v - 0.75 * Math.sin(TAU * v) - Math.PI / 2)
      },
    })),
  description: 'Five dots whirl round, bunching at the top and spreading as they speed down.',
}

export const counter: Design = {
  id: 'counter',
  name: 'Counter-spin',
  loop: 2400,
  dots: () =>
    range(6).map((k) => ({
      d: 0.21,
      at: (u) => {
        const a = k < 3
        const breathe = 0.07 * Math.cos(TAU * 2 * u)
        const p = ring(
          a ? 0.3 + breathe : 0.3 - breathe,
          (a ? 1 : -1) * TAU * (u + k / 3) + (a ? 0 : Math.PI / 3),
        )
        return { ...p, o: a ? 1 : 0.6 }
      },
    })),
  description: 'Two triangles of dots turning opposite ways and breathing through each other.',
}

export const vortex: Design = {
  id: 'vortex',
  name: 'Vortex',
  loop: 2400,
  dots: () =>
    range(6).map((k) => ({
      d: 0.24,
      at: (u) => {
        const v = frac(u + k / 6)
        const p = ring(0.42 * (1 - v) ** 0.9, (k % 2) * Math.PI + TAU * 1.1 * v)
        return {
          ...p,
          s: 0.45 + 0.55 * (1 - v),
          o: smooth(v / 0.18) * (1 - smooth((v - 0.7) / 0.3)),
        }
      },
    })),
  description:
    'Dots appear at the rim and spiral into the centre in two arms, like water down a drain.',
}

export const twist: Design = {
  id: 'twist',
  name: 'Twist',
  tall: true,
  loop: 2400,
  depth: 0.16,
  dots: () =>
    eight.map((k) => ({
      d: 0.22,
      at: (u) => {
        const a = TAU * u + ((k >> 1) * Math.PI) / 4 + (k % 2) * Math.PI
        return P(0.16 * Math.cos(a), g(k).y, 0.16 * Math.sin(a))
      },
    })),
  description: "Today's eight dots become a turning double helix.",
}

export const shuffle: Design = {
  id: 'shuffle',
  name: 'Shuffle',
  tall: true,
  loop: 2000,
  depth: 0.16,
  rest: 0.9,
  dots: () =>
    eight.map((k) => ({
      d: 0.22,
      at: (u) => {
        const a = Math.PI * smooth((u - (k >> 1) * 0.11) / 0.34) + (k % 2 ? 0 : Math.PI)
        return P(0.16 * Math.cos(a), g(k).y, 0.16 * Math.sin(a))
      },
    })),
  description:
    'Row by row, the two dots swap sides, one passing in front of the other, then the mark rests.',
}

export const fireflies: Design = {
  id: 'fireflies',
  name: 'Fireflies',
  loop: 4800,
  depth: 0.3,
  dots: () => [
    {
      d: 0.25,
      at: (u) =>
        P(0.34 * Math.sin(TAU * 2 * u + 0.3), 0.3 * Math.sin(TAU * 3 * u), 0.3 * Math.cos(TAU * u)),
    },
    {
      d: 0.25,
      at: (u) =>
        P(
          0.34 * Math.sin(TAU * 3 * u + 1.8),
          0.3 * Math.sin(TAU * 2 * u + 0.6),
          0.3 * Math.sin(TAU * 2 * u),
        ),
    },
    {
      d: 0.25,
      at: (u) =>
        P(
          0.34 * Math.sin(TAU * u + 3.4),
          0.3 * Math.sin(TAU * 4 * u + 2.2),
          0.3 * Math.cos(TAU * 3 * u + 1),
        ),
    },
  ],
  description: 'Three dots drifting on Lissajous paths, swapping front and back.',
}
