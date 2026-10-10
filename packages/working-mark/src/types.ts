/** Where a dot is at one moment, in em from the mark's centre; z toward the viewer. `s` scales the dot, `sx`/`sy`
 *  stretch it, `o` is its opacity. */
export interface Pose {
  x: number
  y: number
  z?: number
  s?: number
  sx?: number
  sy?: number
  o?: number
}

/** A moving dot: its diameter in em and its pose at loop position u in [0, 1). `loop` overrides the design's. */
export interface Dot {
  d: number
  loop?: number
  at: (u: number) => Pose
}

/** A dot that never moves. */
export interface StillDot {
  d: number
  x: number
  y: number
  o?: number
}

export interface Design {
  id: string
  name: string
  /** One loop, in ms. */
  loop: number
  /** Drawn in a 0.66 × 1 cell (today's mark) instead of a square. */
  tall?: boolean
  /** The radius that turns z into "how far behind": at z = −depth a dot is drawn at `back`'s size and opacity. */
  depth?: number
  back?: { s: number; o: number }
  /** Where in the loop (0–1) the mark rests for reduced motion. */
  rest?: number
  still?: readonly StillDot[]
  /** Built on first use, so an imported design costs nothing until it is drawn. */
  dots: () => readonly Dot[]
  description: string
}

/** A picture: every visible dot as [x, y, rx, ry, opacity], in em from the centre. */
export type Picture = readonly (readonly [number, number, number, number, number])[]
