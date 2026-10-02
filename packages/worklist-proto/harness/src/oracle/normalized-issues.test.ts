import {
  allIssueViewModels,
  createKernelReplica,
  createSideCache,
  memoryStorage,
} from '@podium/client-core/replica'
import { createWorklistPool } from '@podium/client-graph/create'
import { checkSidebar, poolSidebarSnapshot } from '@podium/client-graph/diagnostics/sidebar-check'
import { createEngineLocals } from '@podium/client-graph/shared/engine-locals'
import { createRowSource } from '@podium/client-graph/shared/row-source'
import { runInAction } from 'mobx'
import { describe, expect, it } from 'vitest'
import { seedCacheFromCorpus } from '../../../shared/src/scenarios'
import { buildCorpus } from '../fixture'
import { sidebarReplayStore } from './sidebar-replay'

function boot(withOld: boolean) {
  const corpus = buildCorpus(1, 4443)
  const cache = seedCacheFromCorpus(corpus)
  if (!withOld) for (const issue of corpus.issues) cache.drop('issue', issue.id)
  const replica = createKernelReplica({
    cache,
    side: createSideCache({ storage: memoryStorage(), enumerateKeys: () => [] }),
  })
  return { corpus, cache, replica }
}

describe('normalized-only corpus acceptance', () => {
  it('is field-for-field identical across the corpus with and without old rows', () => {
    const full = boot(true),
      normalized = boot(false)
    const before = allIssueViewModels(full.replica),
      after = allIssueViewModels(normalized.replica)
    expect(after).toHaveLength(full.corpus.issues.length)
    const byId = new Map(before.map((row) => [row.id, row]))
    const oldById = new Map(full.corpus.issues.map((row) => [row.id, row]))
    for (const row of after) {
      const previous = byId.get(row.id)!
      for (const field of new Set([...Object.keys(row), ...Object.keys(previous)])) {
        expect(Reflect.get(row, field), `${row.id}.${field}`).toEqual(Reflect.get(previous, field))
      }
      const old = oldById.get(row.id)!
      expect(row.isDraftVessel, row.id).toBe(old.draft ?? false)
      expect(row.intentOrigin, row.id).toBe(old.origin ?? 'human')
      expect(row.asked?.question, row.id).toBe(old.humanQuestion)
      expect(row.asked?.options, row.id).toEqual(old.humanQuestionOptions)
      expect(row.asked?.at, row.id).toBe(old.humanQuestionAskedAt)
      expect(row.asked?.by, row.id).toBe(old.humanQuestionAskedBy)
      expect(row.readAt, row.id).toBe(old.readAt ?? null)
      expect(row.tuckedAt, row.id).toBe(old.tuckedAt ?? null)
      expect(row.pinned, row.id).toBe(old.pinned ?? false)
      expect(row.gitState, row.id).toEqual(old.gitState)
      expect(row.description, row.id).toBe(old.description)
    }
  })
  it('the pool sidebar and its six fields need only projections and new kinds', () => {
    const { corpus, replica } = boot(false)
    const store = { ...sidebarReplayStore(corpus, replica), issues: [] }
    const runtime = {
      getSnapshot: () => store,
      subscribe: () => () => {},
      pendingOverlaysByRow: () => new Map(),
    }
    const rows = createRowSource(runtime, replica, { mode: 'overlaid' })
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
