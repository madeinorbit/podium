/**
 * From a design to the pictures an animated image needs, with no DOM: where every dot is at a moment, how soon the
 * picture repeats, the lowest frame rate that still moves smoothly, and the frames of one loop cut down to the
 * distinct pictures and how long each is held. Ported from POD-5558's gallery (sheet(), dotsAt(), period(), autoFps()).
 */
import { clamp01, frac, lerp } from './kit'
import type { Design, Dot, Picture } from './types'

const BACK = { s: 0.6, o: 0.4 }
const dotsCache = new WeakMap<Design, readonly Dot[]>()
const dotsOf = (d: Design): readonly Dot[] => {
  let dots = dotsCache.get(d)
  if (!dots) {
    dots = d.dots()
    dotsCache.set(d, dots)
  }
  return dots
}

/** A dot's size and opacity at loop position u, with depth turned into "smaller and fainter behind". */
function pose(d: Design, dot: Dot, u: number) {
  const p = dot.at(u)
  const back = d.back ?? BACK
  const front = d.depth ? clamp01(((p.z ?? 0) / d.depth + 1) / 2) : 1
  const s = lerp(back.s, 1, front) * (p.s ?? 1)
  return {
    x: p.x,
    y: p.y,
    sx: s * (p.sx ?? 1),
    sy: s * (p.sy ?? 1),
    o: clamp01(lerp(back.o, 1, front) * (p.o ?? 1)),
  }
}

/** Every dot drawn at time t (ms): [x, y, rx, ry, opacity] in em from the mark's centre. */
export function dotsAt(d: Design, t: number): Picture {
  const out: [number, number, number, number, number][] = []
  for (const s of d.still ?? [])
    if ((s.o ?? 1) >= 0.01) out.push([s.x, s.y, s.d / 2, s.d / 2, s.o ?? 1])
  for (const dot of dotsOf(d)) {
    const q = pose(d, dot, frac(t / (dot.loop ?? d.loop)))
    if (q.o >= 0.01) out.push([q.x, q.y, (dot.d / 2) * q.sx, (dot.d / 2) * q.sy, q.o])
  }
  return out
}

const alike = (a: Picture, b0: Picture): boolean => {
  const b: (Picture[number] | null)[] = [...b0]
  return (
    a.length === b.length &&
    a.every((p) => {
      const i = b.findIndex(
        (q) =>
          q !== null && p.every((v, j) => Math.abs(v - (q[j] ?? 0)) < (j === 4 ? 0.01 : 0.002)),
      )
      if (i >= 0) b[i] = null
      return i >= 0
    })
  )
}

const periods = new WeakMap<Design, number>()
/** How soon the picture repeats: six equal dots a sixth of a turn on look as they did, so one loop can be a sixth. */
export function period(d: Design): number {
  const known = periods.get(d)
  if (known !== undefined) return known
  let found = d.loop
  for (let k = 12; k > 1; k--) {
    let same = true
    for (let s = 0; s < 48 && same; s++)
      same = alike(dotsAt(d, (s / 48) * d.loop), dotsAt(d, (s / 48 + 1 / k) * d.loop))
    if (same) {
      found = d.loop / k
      break
    }
  }
  periods.set(d, found)
  return found
}

const SMOOTH_FPS = [20, 24, 30, 40]
const STEP_PX = 0.6
const STEP_O = 0.12
const smoothCache = new WeakMap<Design, number>()
/**
 * The lowest frame rate at which a design still moves smoothly at 12 px: from one frame to the next, no visible dot
 * moves (position plus size) more than 0.6 px or fades more than 0.12.
 */
export function smoothFps(d: Design): number {
  const known = smoothCache.get(d)
  if (known !== undefined) return known
  const P = period(d)
  let found = 40
  for (const fps of SMOOTH_FPS) {
    const F = Math.max(2, Math.round((P / 1000) * fps))
    let ok = true
    let prev = dotsAt(d, 0)
    for (let f = 1; f <= F && ok; f++) {
      const cur = dotsAt(d, (f / F) * P)
      // Compare each dot with the nearest dot of the frame before: dots that trade places look the same.
      ok = cur.every(([x, y, rx, ry, o]) => {
        let best = Number.POSITIVE_INFINITY
        let fade = 0
        for (const [x0, y0, rx0, ry0, o0] of prev) {
          const step = Math.hypot(x - x0, y - y0) + Math.abs(Math.max(rx, ry) - Math.max(rx0, ry0))
          if (step < best) {
            best = step
            fade = Math.abs(o - o0)
          }
        }
        return o < 0.05 || (best * 12 <= STEP_PX && fade <= STEP_O)
      })
      prev = cur
    }
    if (ok) {
      found = fps
      break
    }
  }
  smoothCache.set(d, found)
  return found
}

/** One loop as an animated image needs it: the distinct pictures and how long each is held. */
export interface Sheet {
  /** The repeating period, ms. */
  P: number
  /** Frames in the period. */
  F: number
  fps: number
  /** The cell, cut tight to where the design ever draws, in CSS px from the mark's centre. */
  left: number
  top: number
  cellW: number
  cellH: number
  cells: Picture[]
  /** Each run of equal frames: its picture and when it starts and ends, as fractions of the period. */
  holds: { cell: number; from: number; to: number }[]
}

const pictureKey = (dots: Picture): string =>
  dots
    .map(
      ([x, y, rx, ry, o]) =>
        `${x.toFixed(3)} ${y.toFixed(3)} ${rx.toFixed(3)} ${ry.toFixed(3)} ${o.toFixed(2)}`,
    )
    .sort()
    .join('|')

const MAX_FRAMES = 240
const sheets = new WeakMap<Design, Map<string, Sheet>>()
/**
 * The frames of one period at `fps`, for a mark `px` tall on a screen with `dpr` device pixels per CSS px. Frames
 * that look the same share one picture, and a run of equal frames is one hold. The cell is cut tight to where the
 * design ever draws plus one device pixel for the anti-aliased edge, rounded out to whole CSS px from the centre, so
 * every frame lands on the same pixel grid.
 */
export function sheetOf(d: Design, px: number, fps: number, dpr: number): Sheet {
  let byKey = sheets.get(d)
  if (!byKey) {
    byKey = new Map()
    sheets.set(d, byKey)
  }
  const key = `${px} ${fps} ${dpr}`
  const known = byKey.get(key)
  if (known) return known
  const P = period(d)
  const F = Math.min(MAX_FRAMES, Math.max(2, Math.round((P / 1000) * fps)))
  const cells: Picture[] = []
  const index = new Map<string, number>()
  const cellOf = Array.from({ length: F }, (_, f) => {
    const pic = dotsAt(d, (f / F) * P)
    const k = pictureKey(pic)
    let i = index.get(k)
    if (i === undefined) {
      i = cells.length
      index.set(k, i)
      cells.push(pic)
    }
    return i
  })
  let l = Number.POSITIVE_INFINITY
  let t = Number.POSITIVE_INFINITY
  let r = Number.NEGATIVE_INFINITY
  let b = Number.NEGATIVE_INFINITY
  for (const pic of cells)
    for (const [x, y, rx, ry] of pic) {
      l = Math.min(l, x - rx)
      t = Math.min(t, y - ry)
      r = Math.max(r, x + rx)
      b = Math.max(b, y + ry)
    }
  if (!Number.isFinite(l)) l = t = r = b = 0
  const left = Math.floor(l * px - 1 / dpr)
  const top = Math.floor(t * px - 1 / dpr)
  const cellW = Math.max(1, Math.ceil(r * px + 1 / dpr) - left)
  const cellH = Math.max(1, Math.ceil(b * px + 1 / dpr) - top)
  const holds: Sheet['holds'] = []
  for (let f = 0; f < F; f++) {
    if (f > 0 && cellOf[f] === cellOf[f - 1]) continue
    let g = f
    while (g + 1 < F && cellOf[g + 1] === cellOf[f]) g++
    holds.push({ cell: cellOf[f] ?? 0, from: f / F, to: (g + 1) / F })
  }
  const out = { P, F, fps, left, top, cellW, cellH, cells, holds }
  byKey.set(key, out)
  return out
}

/** The picture a design rests on for reduced motion and while paused. */
export const restingPicture = (d: Design): Picture => dotsAt(d, (d.rest ?? 0) * d.loop)
