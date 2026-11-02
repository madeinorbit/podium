/** Full-only pixel geometry. Links arrive in stored dependent -> dependency
 * order; the painted direction is dependency dot -> dependent arrowhead. */
export type DependencyPoint = { right: number; y: number }
export type DependencyLink = { dependentId: string; dependencyId: string }
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

export function dependencyHook(
  dependency: DependencyPoint,
  dependent: DependencyPoint,
  index: number,
) {
  const x = Math.max(dependency.right, dependent.right) - FULL_EDGE_GUTTER + 3
  const hook = 9 + (index % 3) * 5
  return {
    x,
    sourceY: dependency.y,
    targetY: dependent.y,
    hook,
    path: `M${x} ${dependency.y} C${x + hook} ${dependency.y}, ${x + hook} ${dependent.y}, ${x} ${dependent.y}`,
    arrow: arrowhead(x, dependency.y, x + hook, dependent.y),
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
function arrowhead(x: number, fromY: number, hookX: number, toY: number): string {
  const at = (t: number) => {
    const u = 1 - t
    // Cubic with control points (hookX, fromY) and (hookX, toY), ends at x.
    return {
      x: u * u * u * x + 3 * u * t * hookX + t * t * t * x,
      y: u * u * u * fromY + 3 * u * u * t * fromY + 3 * u * t * t * toY + t * t * t * toY,
    }
  }
  let back = at(0)
  for (let t = 0.99; t > 0; t -= 0.01) {
    const point = at(t)
    if (Math.hypot(point.x - x, point.y - toY) >= ARROW_AIM) {
      back = point
      break
    }
  }
  const length = Math.hypot(x - back.x, toY - back.y) || 1
  // Unit direction of travel into the tip, and its normal.
  const dx = (x - back.x) / length,
    dy = (toY - back.y) / length
  const arm = (side: 1 | -1) =>
    `${round(x - ARROW_BACK * dx - side * ARROW_HALF * dy)} ${round(toY - ARROW_BACK * dy + side * ARROW_HALF * dx)}`
  return `M${arm(1)} L${x} ${toY} L${arm(-1)}`
}

export function dependencyEdges(
  links: readonly DependencyLink[],
  points: ReadonlyMap<string, DependencyPoint>,
  expanded: boolean,
  activeId: string | null,
) {
  return links.flatMap((link, index) => {
    const source = points.get(link.dependencyId),
      target = points.get(link.dependentId)
    const highlighted = link.dependencyId === activeId || link.dependentId === activeId
    if (!source || !target || (!expanded && !highlighted)) return []
    return [{ ...link, ...dependencyHook(source, target, index), highlighted }]
  })
}
