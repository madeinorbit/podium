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
    arrow: `M${x + 4} ${dependent.y - 3} L${x} ${dependent.y} L${x + 4} ${dependent.y + 3}`,
  }
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
