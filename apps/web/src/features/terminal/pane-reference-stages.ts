import type { MobxPool } from '@podium/client-graph'
import { createPoolProjection } from '@podium/client-graph/runtime-pool'
import { parseAnyRef } from '@podium/protocol'
import type { PaneReferenceStages } from './use-session-pane-inputs'

/** Demand subscriptions cover only references this terminal has displayed.
 * The existing pool resolves cold identities and owns every row read. */
export function createPaneReferenceStages(
  pool: MobxPool,
): PaneReferenceStages & { dispose(): void } {
  const changes = new Set<() => void>()
  const watched = new Map<
    string,
    { stage(): ReturnType<PaneReferenceStages['resolveStage']>; stop(): void }
  >()
  let disposed = false
  return {
    resolveStage(token) {
      if (disposed) return null
      const parsed = parseAnyRef(token.trim())
      if (parsed?.kind !== 'issue') return null
      const key = `${parsed.prefix}-${parsed.seq}`
      let entry = watched.get(key)
      if (!entry) {
        const projection = createPoolProjection(pool, (pool) => {
          const model = pool.references.read(key)
          return typeof model === 'symbol' ? null : (model?.stage ?? null)
        })
        entry = { stage: projection.getSnapshot, stop: () => {} }
        watched.set(key, entry)
        entry.stop = projection.subscribe(() => {
          for (const paint of changes) paint()
        })
      }
      return entry.stage()
    },
    subscribe(paint) {
      if (disposed) return () => {}
      changes.add(paint)
      return () => {
        changes.delete(paint)
      }
    },
    dispose() {
      disposed = true
      for (const entry of watched.values()) entry.stop()
      watched.clear()
      changes.clear()
    },
  }
}
