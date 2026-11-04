/** Full-only pixel geometry. Links arrive in stored dependent -> dependency
 * order; the painted direction is dependency dot -> dependent arrowhead. */
export type DependencyPoint = { right: number; y: number }
export type DependencyLink = { dependentId: string; dependencyId: string }
/** The strip at a row's right end that the lines run in: they start this far
 * inside the row, and hooks of 9/14/19px stay inside it. The words under it
 * fade while lines show (POD-6245). */
export const FULL_EDGE_INSET = 28

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
  const x = Math.max(dependency.right, dependent.right) - FULL_EDGE_INSET + 3
  const hook = 9 + (index % 3) * 5
  const full: Cubic = [
    { x, y: dependency.y },
    { x: x + hook, y: dependency.y },
    { x: x + hook, y: dependent.y },
    { x, y: dependent.y },
  ]
  const curve = stopAtDot ? headOf(full, shortOf(full, DOT_CLEARANCE)) : full
  return {
    x,
    sourceY: dependency.y,
    targetY: dependent.y,
    hook,
    curve,
    path: pathOf(curve),
    arrow: arrowhead(curve),
  }
}

function pathOf([p0, c1, c2, tip]: Cubic): string {
  return `M${round(p0.x)} ${round(p0.y)} C${round(c1.x)} ${round(c1.y)}, ${round(c2.x)} ${round(c2.y)}, ${round(tip.x)} ${round(tip.y)}`
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
  return arrowAlong(curve[3], arrival(curve))
}
/** Unit direction of travel into the curve's end, read over ARROW_AIM px. */
function arrival(curve: Cubic): Point {
  const tip = curve[3]
  const back = pointAt(curve, shortOf(curve, ARROW_AIM))
  return unit({ x: tip.x - back.x, y: tip.y - back.y })
}
function unit(v: Point): Point {
  const length = Math.hypot(v.x, v.y) || 1
  return { x: v.x / length, y: v.y / length }
}
/** An arrowhead at `tip` pointing along unit direction `d`. */
function arrowAlong(tip: Point, d: Point): string {
  const arm = (side: 1 | -1) =>
    `${round(tip.x - ARROW_BACK * d.x - side * ARROW_HALF * d.y)} ${round(tip.y - ARROW_BACK * d.y + side * ARROW_HALF * d.x)}`
  return `M${arm(1)} L${round(tip.x)} ${round(tip.y)} L${arm(-1)}`
}

/** Where this many lines or more arrive at one row they merge into one
 * arrowhead instead of stacking that many on one point (POD-6245). */
export const FAN_IN = 3
/** How far behind the shared tip each merging line's last control point sits:
 * the stretch over which the lines bend into one direction and blend. */
const MERGE_REACH = 14

export type DependencyEdge = DependencyLink &
  ReturnType<typeof dependencyHook> & { highlighted: boolean }
/** One arrowhead shared by every line arriving at a fan-in row. */
export type DependencyHead = { dependentId: string; arrow: string; highlighted: boolean }

export function dependencyDrawing(
  links: readonly DependencyLink[],
  points: ReadonlyMap<string, DependencyPoint>,
  expanded: boolean,
  activeId: string | null,
): { edges: DependencyEdge[]; heads: DependencyHead[] } {
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
  const incoming = new Map<string, typeof shown>()
  for (const item of shown) {
    const list = incoming.get(item.link.dependentId) ?? []
    list.push(item)
    incoming.set(item.link.dependentId, list)
  }
  const ordered: { index: number; edge: DependencyEdge }[] = []
  const heads: DependencyHead[] = []
  for (const [dependentId, arriving] of incoming) {
    if (arriving.length < FAN_IN) {
      for (const { link, index, source, target, highlighted } of arriving)
        ordered.push({
          index,
          edge: {
            ...link,
            ...dependencyHook(source, target, index, dots.has(dependentId)),
            highlighted,
          },
        })
      continue
    }
    // FAN-IN. Every line bends into the average of the directions the lines
    // would arrive in on their own: its last control point sits on one ray
    // behind the shared tip, so all of them meet the tip along one tangent
    // and blend into a single line just before it. One arrowhead, along it.
    const naturals = arriving.map(({ index, source, target }) =>
      dependencyHook(source, target, index),
    )
    const d = unit(
      naturals
        .map((hook) => arrival(hook.curve))
        .reduce((sum, v) => ({ x: sum.x + v.x, y: sum.y + v.y }), { x: 0, y: 0 }),
    )
    const target = arriving[0]!.target
    const x = Math.max(...naturals.map((hook) => hook.x))
    const clearance = dots.has(dependentId) ? DOT_CLEARANCE : 0
    const tip = { x: x - d.x * clearance, y: target.y - d.y * clearance }
    const bend = { x: tip.x - d.x * MERGE_REACH, y: tip.y - d.y * MERGE_REACH }
    arriving.forEach(({ link, index, highlighted }, n) => {
      const hook = naturals[n]!
      const curve: Cubic = [hook.curve[0], hook.curve[1], bend, tip]
      ordered.push({
        index,
        edge: { ...link, ...hook, curve, path: pathOf(curve), arrow: '', highlighted },
      })
    })
    heads.push({
      dependentId,
      arrow: arrowAlong(tip, d),
      highlighted: arriving.some(({ highlighted }) => highlighted),
    })
  }
  // Keep the links' own order; callers sort only by highlight.
  ordered.sort((a, b) => a.index - b.index)
  return { edges: ordered.map(({ edge }) => edge), heads }
}

/** The lines alone, for callers that draw no fan-in heads. */
export function dependencyEdges(
  links: readonly DependencyLink[],
  points: ReadonlyMap<string, DependencyPoint>,
  expanded: boolean,
  activeId: string | null,
): DependencyEdge[] {
  return dependencyDrawing(links, points, expanded, activeId).edges
}
