import { withKeyedInputs } from '@podium/client-core/test-support/keyed-inputs'

import { createKernelReplica, createSideCache, memoryStorage } from '@podium/client-core/replica'
import { allIssueViewModels } from '../../../diagnostics/reference/issue-view-models'
import { createWorklistPool } from '@podium/client-graph/create'
import { checkSidebar, poolSidebarSnapshot } from '../../../diagnostics/sidebar-check'
import { createEngineLocals } from '@podium/client-graph/shared/engine-locals'
import { createRowSource } from '../../../shared/src/row-source'
import { runInAction } from 'mobx'
import { describe, expect, it } from 'vitest'
import { seedCacheFromCorpus } from '../../../shared/src/scenarios'
import { buildCorpus } from '../fixture'
import { sidebarReplayStore } from './sidebar-replay'

function boot() {
  const corpus = buildCorpus(1, 4443)
  const cache = seedCacheFromCorpus(corpus)
  const replica = createKernelReplica({
    cache,
    side: createSideCache({ storage: memoryStorage(), enumerateKeys: () => [] }),
  })
  return { corpus, cache, replica }
}

describe('normalized-only corpus acceptance', () => {
  it('materializes the fixture facts from normalized records alone', () => {
    const { corpus, replica } = boot()
    const after = allIssueViewModels(replica)
    expect(after).toHaveLength(corpus.issues.length)
    const expectedById = new Map(corpus.issues.map((row) => [row.id, row]))
    for (const row of after) {
      const expected = expectedById.get(row.id)!
      for (const field of [
        'isDraftVessel',
        'intentOrigin',
        'asked',
        'readAt',
        'tuckedAt',
        'pinned',
        'gitState',
        'description',
      ] as const) {
        expect(row[field], `${row.id}.${field}`).toEqual(expected[field])
      }
    }
  })
  it('the pool sidebar and its six fields need only projections and new kinds', () => {
    const { corpus, replica } = boot()
    const store = sidebarReplayStore(corpus, replica)
    const runtime = withKeyedInputs({
      getSnapshot: () => store,
      subscribe: () => () => {},
      pendingOverlaysByRow: () => new Map(),
    })
    const rows = createRowSource(runtime, replica, { mode: 'pooled' })
    const locals = createEngineLocals(runtime)
    const handle = createWorklistPool(rows.source, locals.source)
    try {
      for (let round = 0; round < 64; round++) {
        runInAction(() => poolSidebarSnapshot(handle.pool))
        if (!handle.pool.hydrate()) break
      }
      expect(
        runInAction(() =>
          checkSidebar(handle.pool, store, {
            pinnedRepos: corpus.pins.repos,
            pinnedWorktrees: corpus.pins.worktrees,
          }),
        ),
      ).toMatchObject({ differences: 0, pending: 0 })
      const models = new Map(allIssueViewModels(replica).map((row) => [row.id, row]))
      for (const record of rows.source.snapshot('issue')) {
        const row = record.value as unknown as Record<string, unknown>
        const model = models.get(record.id as never)!
        for (const field of [
          'readAt',
          'tuckedAt',
          'pinned',
          'gitState',
          'repoPath',
          'asked',
          'intentOrigin',
          'isDraftVessel',
        ]) {
          expect(row[field], `${record.id}.${field}`).toEqual(Reflect.get(model, field))
        }
        expect(row).not.toHaveProperty('commentCount')
      }
    } finally {
      handle.dispose()
      locals.dispose()
      rows.dispose()
    }
  })
})
