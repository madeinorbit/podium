/**
 * The issue explorer's navigation stack, as pure functions.
 *
 * The stack is a list of issue ids, deepest last. An EMPTY stack is the task
 * list — level 0 — which is why "go back far enough and you land on the full
 * list" needs no special case: it is just popping to depth 0.
 */

/** Depth 0 is the list; depth N is the Nth pushed issue. */
export type ExplorerStack = readonly string[]

/** Push a level. Pushing the issue already on top is a no-op, so a double click
 *  on a relation row cannot stack the same task twice. */
export function pushLevel(stack: ExplorerStack, id: string): string[] {
  if (stack[stack.length - 1] === id) return [...stack]
  return [...stack, id]
}

/** Pop back to `depth` levels (0 = the list). Depths past the end are ignored,
 *  so a crumb click that races a reset cannot grow the stack. */
export function popToDepth(stack: ExplorerStack, depth: number): string[] {
  if (depth < 0) return []
  if (depth >= stack.length) return [...stack]
  return stack.slice(0, depth)
}

/**
 * Retarget from outside — a Flight Deck session click, a mission switch.
 *
 * External targeting RESETS the chain rather than extending it: the trail must
 * describe how the operator got somewhere, and a click in another column is not
 * a step in that trail. Retargeting to the task already showing keeps the
 * existing stack, so clicking around inside one task's sessions does not
 * repeatedly throw away the relations you walked from it.
 */
export function resetTo(stack: ExplorerStack, id: string | null): string[] {
  if (!id) return [...stack]
  if (stack.length === 1 && stack[0] === id) return [...stack]
  return [id]
}

/** One rendered breadcrumb: the list root, an issue, or the elision between. */
export type Crumb =
  | { kind: 'root'; depth: 0 }
  | { kind: 'issue'; id: string; depth: number }
  | { kind: 'gap' }

/**
 * The trail as rendered. Always rooted at the list, and clamped to `max` nodes
 * by eliding the middle — the root and where you are now are the two the
 * operator navigates by; the steps between are reachable by walking back.
 */
export function crumbTrail(stack: ExplorerStack, max = 3): Crumb[] {
  const full: Crumb[] = [
    { kind: 'root', depth: 0 },
    ...stack.map((id, i) => ({ kind: 'issue' as const, id, depth: i + 1 })),
  ]
  if (full.length <= max) return full
  const tail = full.slice(full.length - (max - 1))
  return [full[0] as Crumb, { kind: 'gap' }, ...tail]
}
