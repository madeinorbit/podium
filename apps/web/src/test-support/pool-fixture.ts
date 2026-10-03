/** Historical synthetic UI fixtures feed the real pool at the test boundary. */
import { reposToViews } from '@podium/client-core/viewmodels'
import { MobxPool } from '@podium/client-graph'
import { createPoolProjection } from '@podium/client-graph/runtime-pool'
import { useMemo, useSyncExternalStore } from 'react'
import { afterEach } from 'vitest'
import { useStoreSelector } from '@/app/store'
import { normalizedFixtureIssues } from './normalized-issues'

let pool: MobxPool | null = null
let signature: string | undefined

afterEach(() => { pool?.dispose(); pool = null; signature = undefined })

function readFixturePool() {
  const state = useStoreSelector(state => state)
  const nextSignature = JSON.stringify([state.issues, state.sessions, state.repos, state.machines, state.selectedIssueId, state.coarseNow])
  if (!pool) pool = new MobxPool({ selectedIssueId: state.selectedIssueId ?? null, coarseNow: state.coarseNow ?? Date.now() })
  if (signature !== nextSignature) {
    signature = nextSignature
    const issues = normalizedFixtureIssues(state)
    const worktrees = reposToViews(state.repos ?? []).flatMap(repo => repo.worktrees.map(tree => ({
      ...tree, repoPath: repo.path, repoName: repo.name, repoId: repo.repoId, projectRoot: tree.path === repo.path,
    })))
    pool.apply({ type: 'replace', rows: [
      ...issues.map(value => ({ kind: 'issue' as const, id: value.id, value })),
      ...(state.sessions ?? []).map(value => ({ kind: 'session' as const, id: value.sessionId, value })),
      ...worktrees.map(value => ({ kind: 'worktree' as const, id: value.path, value })),
    ] })
    pool.applyLocals({ selectedIssueId: state.selectedIssueId ?? null, coarseNow: state.coarseNow ?? Date.now() }, new Set(['selectedIssueId', 'coarseNow']))
    pool.header.apply((state.machines ?? []).map(value => ({ kind: 'machine', id: value.id, value })))
    pool.header.order('machine', (state.machines ?? []).map(value => value.id))
  }
  return pool
}

export const fixturePoolHooks = {
  useWorklistPool: readFixturePool,
  useWorklistPoolProjection<T>(read: (pool: MobxPool) => T, _empty: T): T {
    const current = readFixturePool()
    const projection = useMemo(() => createPoolProjection(current, read), [current, read])
    return useSyncExternalStore(projection.subscribe, projection.getSnapshot)
  },
}
