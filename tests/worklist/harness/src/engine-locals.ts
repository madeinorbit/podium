/** Historical corpus adapter: time is fixture input, never a runtime local. */
import { localsOfEngine as selectedLocals, type LocalsEngine } from '@podium/client-graph/shared/engine-locals'
import { createLocalsSource } from '@podium/client-graph/shared/locals-source'
import { referenceState } from '../../diagnostics/reference-state'

type FixtureEngine = LocalsEngine & { fixtureClock?: { now(): number; subscribe(tick: (now: number) => void): () => void } }
export { type LocalsEngine }
export function localsOfEngine(engine: FixtureEngine) {
  return { ...selectedLocals(engine), coarseNow: engine.fixtureClock?.now() ?? referenceState(engine as never).coarseNow }
}
export function createEngineLocals(engine: FixtureEngine) {
  return createLocalsSource(() => localsOfEngine(engine), wake => {
    const selection = engine.onLocals(['selectedIssueId'], wake)
    const clock = engine.fixtureClock?.subscribe(wake)
    return () => { selection(); clock?.() }
  })
}
