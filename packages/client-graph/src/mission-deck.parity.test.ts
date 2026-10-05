import { createKernelReplica, createSideCache, memoryStorage } from '@podium/client-core/replica'
import { sessionViews } from '@podium/client-core/session-values'
import { deriveHandoffNow, missionRootFor } from '@podium/client-core/values'
import { dedupeSessions } from '../diagnostics/reference-state'
import { allIssueViewModels } from '../diagnostics/reference/issue-view-models'
import { checkMissionView } from '../diagnostics/mission-view-check'
import { buildCorpus } from '../../worklist-proto/harness/src/fixture/corpus'
import { seedCacheFromCorpus } from '../../worklist-proto/shared/src/scenarios'
import { autorun } from 'mobx'
import { expect, it } from 'vitest'
import { MobxPool } from './pool'
import { missionView } from './mission-view'
import { LOADING } from './loading'

for (const scale of [1, 4] as const) it(`matches the synthetic corpus directly at ${scale}x in every spine mode`, () => {
  const corpus = buildCorpus(scale)
  const replica = createKernelReplica({ cache: seedCacheFromCorpus(corpus),
    side: createSideCache({ storage: memoryStorage(), enumerateKeys: () => [] }) })
  const issues = allIssueViewModels(replica)
  const repos = [...replica.rows('repos')], machines = [...replica.rows('machines')]
  const rawSessions = sessionViews([...replica.rows('sessions')], {
    userId: 'operator', userStates: [...replica.rows('sessionUserStates')], machines, repos,
  })
  const sessions = dedupeSessions(rawSessions)
  const paths = issues.flatMap(issue => issue.worktreePath ? [issue.worktreePath] : [])
  const rows = [
    ...issues.map(value => ({ kind: 'issue' as const, id: value.id, value })),
    ...rawSessions.map(value => ({ kind: 'session' as const, id: value.sessionId, value })),
    ...repos.map(value => ({ kind: 'repo' as const, id: value.id, value })),
    ...machines.map(value => ({ kind: 'machine' as const, id: value.id, value })),
  ]
  // Direct value parity uses full rows, as the existing rendered-corpus test
  // does. The separate loading test covers cold rows and ancestor rollups.
  const pool = new MobxPool({ selectedIssueId: null, coarseNow: corpus.fixedNow })
  pool.apply({ type: 'replace', rows })
  try {
    // Run the raw-member and retired-crew regressions before the ordinary
    // roots; the remainder still covers every root at each scale.
    const roots = new Set([scale === 4 ? 'i11834' : 'i2696', ...issues.map(issue => missionRootFor(issues, issue.id)?.id)])
    for (const root of roots) for (const mode of ['full', 'working', 'needs-you'] as const) {
      let result!: ReturnType<typeof checkMissionView>
      let handoff: ReturnType<typeof deriveHandoffNow> | undefined
      const stop = autorun(() => {
        result = checkMissionView(pool, issues, sessions, root ?? null, mode, paths)
        if (result.first?.section === 'handoff' && root) {
          const actual = missionView(pool).handoff(root)
          handoff = actual === LOADING ? undefined : actual.current
        }
      })
      try {
        expect(result.pending, `${root} ${mode}: ${JSON.stringify(result)}`).toBe(0)
        if (scale === 4 && root === 'i11834') {
          // f83bd8c29c already differs from the old client-core helper here:
          // its reader sees the staffed spin-off outside the mission's crew.
          // Preserve that displayed sentence, and allow only this exact field.
          expect(handoff).toEqual([{ kind: 'stalled', issueId: root, text: 'Work continued in POD-13127' }])
          expect(result.differences).toBe(1)
          expect(result.first).toEqual({ section: 'handoff', sectionIndex: 4, rowIndex: null,
            expectedId: 'handoff', actualId: 'handoff', field: 'current[0].text' })
        } else expect(result.differences, `${root} ${mode}: ${JSON.stringify(result.first)}`).toBe(0)
      } finally { stop() }
    }
  } finally { pool.dispose() }
}, 600_000)
