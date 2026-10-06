/** Counts collection-field comparisons for one active selection click. */
import { MobxPool } from '@podium/client-graph/pool'
import { createPoolProjection } from '@podium/client-graph/runtime-pool'

export function projectionComparisonMechanism(scale: 1 | 4) {
  const pool = new MobxPool({ selectedIssueId: null, coarseNow: 0 })
  let derivations = 0,
    comparedFields = 0
  const projection = createPoolProjection(pool, (current) => {
    derivations++
    return {
      rows: Array.from({ length: 40 * scale }, (_, value) =>
        Object.defineProperty({}, 'value', {
          enumerable: true,
          get: () => {
            comparedFields++
            return value
          },
        }),
      ),
      selected: current.selection.size,
    }
  })
  projection.getSnapshot()
  const stop = projection.subscribe(() => {})
  try {
    derivations = comparedFields = 0
    pool.applyLocals({ selectedIssueId: 'one', coarseNow: 0 }, new Set(['selectedIssueId']))
    return { scale, derivations, comparedFields }
  } finally {
    stop()
    pool.dispose()
  }
}

if (process.argv[1]?.endsWith('projection-comparison-mechanism.ts')) {
  for (const scale of [1, 4] as const)
    console.info(JSON.stringify(projectionComparisonMechanism(scale)))
}
