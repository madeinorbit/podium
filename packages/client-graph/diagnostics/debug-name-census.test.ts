import { autorun, getDependencyTree, runInAction } from 'mobx'
import { expect, it } from 'vitest'
import { startCensus } from '../../../tests/worklist/harness/src/mobx-census'
import { cachedGroup } from '../src/cached'
import { createObservableTables } from '../src/tables'

// The census traps constructors: all imports must share one MobX instance.
// Keep it separate from the build-mode tests that reset the module registry.
it('keeps table names and cached-group owner attribution in the census', () => {
  const census = startCensus()
  let stop: (() => void) | undefined
  try {
    const tables = createObservableTables()
    class CensusRow { readonly id = 'I1' }
    const row = new CensusRow()
    const group = cachedGroup('facts', (target: CensusRow) => tables.issue.has(target.id))
    runInAction(() => tables.issue.set(row.id, {}))
    stop = autorun(() => group(row))
    expect(getDependencyTree(stop).dependencies?.[0]?.name).toBe('CensusRow@I1.facts')
    const snapshot = census.snapshot()
    expect(snapshot.entries).toContainEqual(expect.objectContaining({
      kind: 'map', name: 'pool.issue', size: 1,
    }))
    expect(snapshot.entries).toContainEqual(expect.objectContaining({
      kind: 'computed', sub: 'declared', owner: { cls: 'CensusRow', id: 'I1' },
    }))
  } finally {
    stop?.()
    census.stop()
  }
})
