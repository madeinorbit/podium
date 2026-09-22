/**
 * POD-4608 (L1e) — the engine-backed locals source every fenced arm receives.
 *
 * Selection and the coarse clock are engine writes: `setSelectedIssueId` (#3)
 * and the runtime's injectable coarse clock (#8, POD-4550). Every engine
 * publication is a signal; the drain reads the two fields from the store and
 * notifies with the keys that moved, so a row write notifies nothing, a tick
 * names `coarseNow` and a click names `selectedIssueId`.
 *
 * THE FOLD LATCH. The engine holds no `selectedIssueWasFolded` (the app's list
 * computes it at the click), so this source never sets it. `engineLocals`
 * (`fence-scenarios.ts`), which the row-view oracle reads, omits it too.
 *
 * RELOAD. Bound to one runtime: after `ScenarioEngine.reload()` create a new
 * one, as for the row source.
 */

import type { LocalsSourceHandle } from '../../shared/src/locals-source'
import { createLocalsSource } from '../../shared/src/locals-source'
import type { SliceLocals } from '../../shared/src/slice-types'

/** The engine surface this source reads. The real runtime satisfies it by shape. */
export interface LocalsEngine {
  subscribe(listener: () => void): () => void
  getSnapshot(): { selectedIssueId?: string | null; coarseNow: number }
}

/** Selection and clock as the engine store holds them. */
export function localsOfEngine(engine: LocalsEngine): SliceLocals {
  const store = engine.getSnapshot()
  return { selectedIssueId: store.selectedIssueId ?? null, coarseNow: store.coarseNow }
}

export function createEngineLocals(engine: LocalsEngine): LocalsSourceHandle {
  return createLocalsSource(
    () => localsOfEngine(engine),
    (wake) => engine.subscribe(wake),
  )
}
