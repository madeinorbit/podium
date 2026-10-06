import { reaction, runInAction } from 'mobx'
import { expect, it } from 'vitest'
import { LOADING } from '@podium/client-graph/worklist/rollup'
import { settableLocals } from '@podium/client-graph/shared/locals-source'
import { buildCorpus } from '../../../harness/src/fixture'
import { createReplaySource } from '../../../harness/src/count-harness'
import { harnessMobxPoolArm } from '../../../harness/src/adapters/mobx-pool'
import { startCensus } from '../../../harness/src/mobx-census'
import { installMobxWarnTrap } from '../../../harness/src/mobx-trap'

installMobxWarnTrap()

it('maintenance summary probes build no atoms and preserve an observed cold reader', () => {
  const corpus = buildCorpus(1)
  const replay = createReplaySource({
    issues: corpus.sliceIssues.map(value => ({ kind: 'issue', id: value.id, value })),
    sessions: corpus.sliceSessions.map(value => ({ kind: 'session', id: value.sessionId, value })),
    worktrees: corpus.sliceWorktrees.map(value => ({ kind: 'worktree', id: value.path, value })),
  })
  const locals = settableLocals({ selectedIssueId: null, coarseNow: corpus.fixedNow })
  const handle = harnessMobxPoolArm.create(replay.source, locals.source, undefined, { schedule: () => () => {} })
  const pool = handle.pool
  const cold = pool.residency!.ids('issue')[0]!
  const seen: unknown[] = []
  const stop = reaction(() => pool.row('issue', cold), row => seen.push(row), { fireImmediately: true })
  const census = startCensus()
  try {
    expect(seen).toEqual([LOADING])
    runInAction(() => {
      for (let index = 0; index < 100; index += 1) {
        expect(pool.row('issue', `absent-${index}`, 'mark')).toBeUndefined()
        expect(pool.row('issue', `absent-${index}`, 'summary')).toBeUndefined()
        expect(pool.row('issue', cold, 'mark')).toBe(LOADING)
        void pool.row('issue', cold, 'summary')
      }
    })
    expect(census.snapshot().entries.filter(entry => entry.kind === 'atom')).toEqual([])
    census.stop()
    expect(pool.hydrate()).toBeGreaterThan(0)
    expect(seen).toHaveLength(2)
    expect(seen[1]).not.toBe(LOADING)
    expect(seen[1]).toBeDefined()
  } finally { census.stop(); stop(); handle.dispose(); locals.dispose() }
})
