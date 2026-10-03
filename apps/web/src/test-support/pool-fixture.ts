/** Historical synthetic UI fixtures feed the real pool at the test boundary. */

import { allIssueViewModels } from '@podium/client-core/replica'
import type { Store } from '@podium/client-core/engine'
import { reposToViews } from '@podium/client-core/viewmodels'
import { MobxPool } from '@podium/client-graph'
import { ISSUE_BOARD_ENTITIES } from '@podium/client-graph/issue-board-schema'
import { createIssueBoardSource } from '@podium/client-graph/issue-board-source'
import { createPoolProjection } from '@podium/client-graph/runtime-pool'
import { useMemo, useSyncExternalStore } from 'react'
import { afterEach } from 'vitest'
import { useStoreSelector } from '@/app/store'
import { normalizedFixtureIssues } from './normalized-issues'

let pool: MobxPool | null = null
let signature: string | undefined
let seededIssues: readonly unknown[] = []

afterEach(() => {
  pool?.dispose()
  pool = null
  signature = undefined
  seededIssues = []
})

/** Historical page tests supplied their fixture row as a prop. */
export function seedPoolFixture(issues: readonly unknown[]) {
  seededIssues = issues
}

function useFixturePool() {
  const state = useStoreSelector((state) => state) as Store & { issues?: readonly unknown[] }
  const fixtureIssues = state.issues?.length ? state.issues : seededIssues
  const nextSignature = JSON.stringify([
    fixtureIssues,
    state.issueProjections,
    state.issueUserStates,
    state.sessions,
    state.repos,
    state.machines,
    state.selectedIssueId,
    state.coarseNow,
  ])
  if (!pool) {
    pool = new MobxPool({
      selectedIssueId: state.selectedIssueId ?? null,
      coarseNow: state.coarseNow ?? Date.now(),
    })
    pool.sources.register(ISSUE_BOARD_ENTITIES, createIssueBoardSource(pool))
    pool.sources.register(['issueExit'], { read: () => ({ kind: undefined }), dispose() {} })
  }
  if (signature !== nextSignature) {
    signature = nextSignature
    const issues =
      state.replica && state.issueProjections
        ? allIssueViewModels(state.replica, state.issueProjections, state.issueUserStates)
        : normalizedFixtureIssues({ ...state, issues: fixtureIssues })
    const worktrees = reposToViews(state.repos ?? []).flatMap((repo) =>
      repo.worktrees.map((tree) => ({
        ...tree,
        repoPath: repo.path,
        repoName: repo.name,
        repoId: repo.repoId,
        projectRoot: tree.path === repo.path,
      })),
    )
    pool.apply({
      type: 'replace',
      rows: [
        ...issues.map((value) => ({ kind: 'issue' as const, id: value.id, value })),
        ...(state.sessions ?? []).map((value) => ({
          kind: 'session' as const,
          id: value.sessionId,
          value,
        })),
        ...worktrees.map((value) => ({ kind: 'worktree' as const, id: value.path, value })),
      ],
    })
    pool.applyLocals(
      { selectedIssueId: state.selectedIssueId ?? null, coarseNow: state.coarseNow ?? Date.now() },
      new Set(['selectedIssueId', 'coarseNow']),
    )
    pool.header.apply(
      (state.machines ?? []).map((value) => ({ kind: 'machine', id: value.id, value })),
    )
    pool.header.order(
      'machine',
      (state.machines ?? []).map((value) => value.id),
    )
    const repositories = (state.repos ?? []).map((value) => ({
      kind: 'repository' as const,
      id: JSON.stringify([value.machineId ?? '', value.path]),
      value,
    }))
    pool.header.apply(repositories)
    pool.header.order(
      'repository',
      repositories.map((value) => value.id),
    )
  }
  return pool
}

export const fixturePoolHooks = {
  useWorklistPool: useFixturePool,
  useWorklistPoolProjection<T>(read: (pool: MobxPool) => T, _empty: T): T {
    const current = useFixturePool()
    const projection = useMemo(() => createPoolProjection(current, read), [current, read])
    return useSyncExternalStore(projection.subscribe, projection.getSnapshot)
  },
}
