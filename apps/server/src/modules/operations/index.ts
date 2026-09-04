import { OperationCleanupJanitor } from './cleanup-janitor'
import { type OperationClock, OperationEngine, systemOperationClock } from './engine'
import { OperationKindRegistry } from './kinds'
import type { OperationRow, OperationStore } from './store'

export * from './actor'
export * from './cleanup-janitor'
export * from './engine'
export * from './kinds'
export * from './lifecycle'
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
  readonly cleanupJanitor: OperationCleanupJanitor
}

export function createOperations(deps: {
  store: OperationStore
  clock?: OperationClock
  onChanged?: (row: OperationRow, previousState: string | undefined) => void
  cleanupContextFor?: (row: OperationRow) => unknown | Promise<unknown>
  startCleanupJanitor?: boolean
}): OperationsModule {
  const kinds = new OperationKindRegistry()
  const clock = deps.clock ?? systemOperationClock
  const engine = new OperationEngine({
    store: deps.store,
    registry: kinds,
    clock,
    ...(deps.onChanged ? { onChanged: deps.onChanged } : {}),
  })
  const cleanupJanitor = new OperationCleanupJanitor({
    engine,
    clock,
    contextFor: deps.cleanupContextFor ?? (() => undefined),
  })
  if (deps.startCleanupJanitor ?? true) cleanupJanitor.start()
  return { kinds, engine, cleanupJanitor }
}
