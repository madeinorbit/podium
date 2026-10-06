import { headerView } from '@podium/client-graph/header-views'
import type { RepoView } from '@podium/client-core/values'
import { launchOptionViews } from '@podium/client-graph/launch-option-views'
import type { MobxPool } from '@podium/client-graph/pool'
import type { MachineWire } from '@podium/model'
import { useCallback } from 'react'
import { useMobilePoolProjection } from './mobile-pool'

const EMPTY = { repo: undefined as RepoView | undefined, machines: [] as MachineWire[] }
export function useLaunchInputs(repoPath: string) {
  const read = useCallback(
    (pool: MobxPool) => ({
      repo: headerView(pool).repository(repoPath),
      machines: headerView(pool).machines(),
    }),
    [repoPath],
  )
  return useMobilePoolProjection(read, EMPTY)
}

const readRepositoryCount = (pool: MobxPool) => headerView(pool).repositoryCount()
export function useLaunchRepositoryCount() {
  return useMobilePoolProjection(readRepositoryCount, 0)
}

const readRepositoryPaths = (pool: MobxPool) => launchOptionViews(pool).repositoryPaths()
const NO_REPOSITORIES: string[] = []
export function useLaunchRepositoryPaths() {
  return useMobilePoolProjection(readRepositoryPaths, NO_REPOSITORIES)
}
