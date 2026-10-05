import { reposToViews } from '@podium/client-core/values'
import type { MobxPool } from '@podium/client-graph/pool'
import type { GitRepositoryWire, MachineWire } from '@podium/model'
import { useMobilePoolProjection } from './mobile-pool'

const EMPTY = { repos: [] as GitRepositoryWire[], machines: [] as MachineWire[] }
/** Existing resident header membership; entity values come only through pool.row. */
function readRepositories(pool: MobxPool) {
  return pool.headerViews.ids('repository').flatMap((id) => {
      const row = pool.row('repository', id) as GitRepositoryWire | undefined
      return row && typeof row !== 'symbol' ? [row] : []
    })
}
function readInputs(pool: MobxPool) {
  return {
    repos: readRepositories(pool),
    machines: pool.headerViews.machines(),
  }
}
export function useLaunchInputs() {
  return useMobilePoolProjection(readInputs, EMPTY)
}

const readRepositoryCount = (pool: MobxPool) => pool.headerViews.repositoryCount()
export function useLaunchRepositoryCount() {
  return useMobilePoolProjection(readRepositoryCount, 0)
}

/** The existing cold scalar answers history; only the visible repository
 * catalog is materialized for this picker. */
function readRepositoryPaths(pool: MobxPool): string[] {
  const repos = reposToViews(readRepositories(pool)).map((repo) => ({
    repo,
    at: pool.queries.activity({
      kind: 'commandRootActivity',
      roots: [repo.path, ...repo.worktrees.map((tree) => tree.path)],
      match: 'within',
    }),
  }))
  return repos
    .sort(
      (a, b) =>
        b.at - a.at || a.repo.path.localeCompare(b.repo.path, undefined, { sensitivity: 'base' }),
    )
    .map(({ repo }) => repo.path)
}
const NO_REPOSITORIES: string[] = []
export function useLaunchRepositoryPaths() {
  return useMobilePoolProjection(readRepositoryPaths, NO_REPOSITORIES)
}
