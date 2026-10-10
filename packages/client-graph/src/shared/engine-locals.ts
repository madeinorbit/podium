import type { LocalsSourceHandle } from './locals-source'
import { createLocalsSource } from './locals-source'
import type { SliceLocals } from './slice-types'

/** The runtime's selection, read by key (POD-5433): a batch
 *  that moves neither does not wake this source. */
export interface LocalsEngine {
  onLocals(keys: readonly ('selectedIssueId')[], listener: () => void): () => void
  readLocal<K extends keyof EngineLocalValues>(key: K): EngineLocalValues[K]
}

interface EngineLocalValues {
  selectedIssueId: string | null
}

const KEYS = ['selectedIssueId'] as const

export function localsOfEngine(engine: Pick<LocalsEngine, 'readLocal'>): SliceLocals {
  return { selectedIssueId: engine.readLocal('selectedIssueId') ?? null }
}

export function createEngineLocals(engine: LocalsEngine): LocalsSourceHandle {
  return createLocalsSource(
    () => localsOfEngine(engine),
    (wake) => engine.onLocals(KEYS, wake),
  )
}
