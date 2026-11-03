/** Full-only pixel geometry. Links arrive in stored dependent -> dependency
 * order; the painted direction is dependency dot -> dependent arrowhead. */
export type DependencyPoint = { right: number; y: number }
export type DependencyLink = { dependentId: string; dependencyId: string }
/** The strip right of the rows that the lines live in (POD-6245): while lines
 * show, the rows end this far before the panel edge, so a line never crosses
 * text. Hooks of 9/14/19px start 3px past the row. The CSS opens the same
 * width (`.flight-full-groups[data-edge-gutter]`). */
export const FULL_EDGE_GUTTER = 28

export function dependencyPoint(
  rect: Pick<DOMRectReadOnly, 'right' | 'top' | 'height'>,
  origin: Pick<DOMRectReadOnly, 'left' | 'top'>,
  scale: number,
): DependencyPoint {
  return {
    right: (rect.right - origin.left) / scale,
    y: (rect.top + rect.height / 2 - origin.top) / scale,
  }
}

type Point = { x: number; y: number }
const lerp = (a: Point, b: Point, t: number): Point => ({
  x: a.x + (b.x - a.x) * t,
  y: a.y + (b.y - a.y) * t,
})
/** A cubic Bezier as its four control points. */
type Cubic = readonly [Point, Point, Point, Point]
function pointAt([p0, p1, p2, p3]: Cubic, t: number): Point {
  const u = 1 - t
  return {
    x: u * u * u * p0.x + 3 * u * u * t * p1.x + 3 * u * t * t * p2.x + t * t * t * p3.x,
    y: u * u * u * p0.y + 3 * u * u * t * p1.y + 3 * u * t * t * p2.y + t * t * t * p3.y,
  }
}
/** The curve from its start to `t` (de Casteljau), still a cubic. */
function headOf([p0, p1, p2, p3]: Cubic, t: number): Cubic {
  const a = lerp(p0, p1, t),
    b = lerp(p1, p2, t),
    c = lerp(p2, p3, t),
    ab = lerp(a, b, t),
    bc = lerp(b, c, t)
  return [p0, a, ab, lerp(ab, bc, t)]
}
/** The parameter where the curve is `distance` px (straight line) short of its end. */
function shortOf(curve: Cubic, distance: number): number {
  const end = curve[3]
  for (let t = 0.995; t > 0; t -= 0.005) {
    const point = pointAt(curve, t)
    if (Math.hypot(point.x - end.x, point.y - end.y) >= distance) return t
  }
  return 0
}

/** A start dot's radius (2) plus its stroke and a hair of air: an arrowhead
 * that ends on a row which also starts a link stops here, just touching it. */
export const DOT_CLEARANCE = 3.5

export function dependencyHook(
  dependency: DependencyPoint,
  dependent: DependencyPoint,
  index: number,
  /** The dependent row shows a start dot of its own; stop short of it. */
  stopAtDot = false,
) {
  const x = Math.max(dependency.right, dependent.right) + 3
  const hook = 9 + (index % 3) * 5
  const full: Cubic = [
    { x, y: dependency.y },
    { x: x + hook, y: dependency.y },
    { x: x + hook, y: dependent.y },
    { x, y: dependent.y },
  ]
  const curve = stopAtDot ? headOf(full, shortOf(full, DOT_CLEARANCE)) : full
  const [, c1, c2, tip] = curve
  return {
    x,
    sourceY: dependency.y,
    targetY: dependent.y,
    hook,
    path: `M${x} ${dependency.y} C${round(c1.x)} ${round(c1.y)}, ${round(c2.x)} ${round(c2.y)}, ${round(tip.x)} ${round(tip.y)}`,
    arrow: arrowhead(curve),
  }
}

const ARROW_BACK = 4
const ARROW_HALF = 3
/** How far back along the curve the arrowhead takes its direction from. */
const ARROW_AIM = 6
const round = (value: number) => Math.round(value * 10) / 10

/**
 * The arrowhead follows the line where the line meets it. The hook's tangent
 * is horizontal only at its very end: over the arrowhead's last few pixels the
 * curve still runs mostly up or down, so a flat `<` had one arm lying across
 * the line. Aim along the chord from the point ARROW_AIM px back on the curve
 * to the tip instead; that is the direction the eye reads.
 */
function arrowhead(curve: Cubic): string {
  const tip = curve[3]
  const back = pointAt(curve, shortOf(curve, ARROW_AIM))
  const length = Math.hypot(tip.x - back.x, tip.y - back.y) || 1
  // Unit direction of travel into the tip, and its normal.
  const dx = (tip.x - back.x) / length,
    dy = (tip.y - back.y) / length
  const arm = (side: 1 | -1) =>
    `${round(tip.x - ARROW_BACK * dx - side * ARROW_HALF * dy)} ${round(tip.y - ARROW_BACK * dy + side * ARROW_HALF * dx)}`
  return `M${arm(1)} L${round(tip.x)} ${round(tip.y)} L${arm(-1)}`
}

export function dependencyEdges(
  links: readonly DependencyLink[],
  points: ReadonlyMap<string, DependencyPoint>,
  expanded: boolean,
  activeId: string | null,
) {
  const shown = links.flatMap((link, index) => {
    const highlighted = link.dependencyId === activeId || link.dependentId === activeId
    const source = points.get(link.dependencyId),
      target = points.get(link.dependentId)
    return source && target && (expanded || highlighted)
      ? [{ link, index, source, target, highlighted }]
      : []
  })
  // Rows that draw a start dot: an arrow ending on one stops short of the dot.
  const dots = new Set(shown.map(({ link }) => link.dependencyId))
  return shown.map(({ link, index, source, target, highlighted }) => ({
    ...link,
    ...dependencyHook(source, target, index, dots.has(link.dependentId)),
    highlighted,
  }))
}
