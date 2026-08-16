import { type OperationClock, OperationEngine, systemOperationClock } from './engine'
import { OperationKindRegistry } from './kinds'
import type { OperationRow, OperationStore } from './store'

export * from './engine'
export * from './kinds'
export * from './store'
export * from './trpc'

/**
 * The durable operations module (POD-2097): a kind registry and the engine that
 * drives it, composed together because neither is useful alone.
 *
 * BOTH HALVES ARE NAMED ON THE MODULE SEAM on purpose. The engine is what
 * transports call; the registry is what a FEATURE calls, once, at composition
 * time, to say "this is what an `update` operation is". Hiding the registry
 * behind the engine would make registration a reach-through, and the point of
 * the seam is that a new kind arrives in a diff a reviewer can see.
 *
 * This issue registers no kinds at all — the `update` kind is the next issue —
 * so a server built from this alone has the whole machine and nothing to drive:
 * `operations.active` answers null and boot adoption finds nothing.
 */
export interface OperationsModule {
  readonly kinds: OperationKindRegistry
  readonly engine: OperationEngine
}

export function createOperations(deps: {
  store: OperationStore
  clock?: OperationClock
  onChanged?: (row: OperationRow) => void
}): OperationsModule {
  const kinds = new OperationKindRegistry()
  const engine = new OperationEngine({
    store: deps.store,
    registry: kinds,
    clock: deps.clock ?? systemOperationClock,
    ...(deps.onChanged ? { onChanged: deps.onChanged } : {}),
  })
  return { kinds, engine }
}
