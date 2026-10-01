import type { LocalsSourceHandle } from './locals-source'
import { createLocalsSource } from './locals-source'
import type { SliceLocals } from './slice-types'

/** The runtime's selection and coarse clock, without a second clock or store. */
export interface LocalsEngine {
  subscribe(listener: () => void): () => void
  getSnapshot(): { selectedIssueId?: string | null; coarseNow: number }
}

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
