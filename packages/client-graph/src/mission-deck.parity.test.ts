import { createKernelReplica, createSideCache, memoryStorage } from '@podium/client-core/replica'
import { sessionViews } from '@podium/client-core/session-values'
import { missionRootFor, reposToViews } from '@podium/client-core/values'
import { dedupeSessions } from '../diagnostics/reference-state'
import { allIssueViewModels } from '../diagnostics/reference/issue-view-models'
import { checkMissionView } from '../diagnostics/mission-view-check'
import { buildCorpus } from '../../worklist-proto/harness/src/fixture/corpus'
import { seedCacheFromCorpus } from '../../worklist-proto/shared/src/scenarios'
import { autorun } from 'mobx'
import { expect, it } from 'vitest'
import { MobxPool } from './pool'

for (const scale of [1, 4] as const) it(`matches the synthetic corpus directly at ${scale}x in every spine mode`, () => {
  const corpus = buildCorpus(scale)
  const replica = createKernelReplica({ cache: seedCacheFromCorpus(corpus),
    side: createSideCache({ storage: memoryStorage(), enumerateKeys: () => [] }) })
  const issues = allIssueViewModels(replica)
  const repos = [...replica.rows('repos')], machines = [...replica.rows('machines')]
  const sessions = dedupeSessions(sessionViews([...replica.rows('sessions')], {
    userId: 'operator', userStates: [...replica.rows('sessionUserStates')], machines, repos,
  }))
  const paths = reposToViews(repos).flatMap(repo => repo.worktrees.map(tree => tree.path))
  const pool = new MobxPool({ selectedIssueId: null, coarseNow: corpus.fixedNow }, undefined,
    { load: () => undefined, worklist: 'demand' })
  pool.apply({ type: 'replace', rows: [
    ...issues.map(value => ({ kind: 'issue' as const, id: value.id, value })),
    ...sessions.map(value => ({ kind: 'session' as const, id: value.sessionId, value })),
    ...repos.map(value => ({ kind: 'repo' as const, id: value.id, value })),
    ...machines.map(value => ({ kind: 'machine' as const, id: value.id, value })),
  ] })
  try {
    const roots = new Set(issues.map(issue => missionRootFor(issues, issue.id)?.id))
    for (const root of roots) for (const mode of ['full', 'working', 'needs-you'] as const) {
      let result!: ReturnType<typeof checkMissionView>
      const stop = autorun(() => { result = checkMissionView(pool, issues, sessions, root ?? null, mode, paths) })
      try {
        expect(result.pending, `${root} ${mode}`).toBe(0)
        expect(result.differences, JSON.stringify(result.first)).toBe(0)
      } finally { stop() }
    }
  } finally { pool.dispose() }
})
