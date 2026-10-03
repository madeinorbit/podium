import type { MobxPool } from '@podium/client-graph/pool'
import { reposToViews } from '@podium/client-core/viewmodels'
import type { GitRepositoryWire, MachineWire } from '@podium/model'
import { useMobilePoolProjection } from './mobile-pool'

const EMPTY = { repos: [] as GitRepositoryWire[], machines: [] as MachineWire[] }
/** Existing resident header membership; entity values come only through pool.row. */
function readInputs(pool: MobxPool) {
  return {
    repos: pool.headerViews.ids('repository').flatMap(id => {
      const row = pool.row('repository', id) as GitRepositoryWire | undefined
      return row && typeof row !== 'symbol' ? [row] : []
    }),
    machines: pool.headerViews.machines(),
  }
}
export function useLaunchInputs() { return useMobilePoolProjection(readInputs, EMPTY) }

/** The existing cold scalar answers history; only the visible repository
 * catalog is materialized for this picker. */
function readRepositoryPaths(pool: MobxPool): string[] {
  const repos = reposToViews(readInputs(pool).repos).map(repo => ({
    repo,
    at: pool.queries.activity({
      kind: 'commandRootActivity',
      roots: [repo.path, ...repo.worktrees.map(tree => tree.path)],
      match: 'within',
    }),
  }))
  return repos.sort((a, b) => b.at - a.at ||
    a.repo.path.localeCompare(b.repo.path, undefined, { sensitivity: 'base' }))
    .map(({ repo }) => repo.path)
}
const NO_REPOSITORIES: string[] = []
export function useLaunchRepositoryPaths() {
  return useMobilePoolProjection(readRepositoryPaths, NO_REPOSITORIES)
}
