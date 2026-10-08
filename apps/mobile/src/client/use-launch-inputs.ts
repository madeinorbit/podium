import { headerView } from '@podium/client-graph/header-views'
import type { RepoView } from '@podium/client-core/values'
import { createLaunchWorkPicker, type LaunchWorkMode } from '@podium/client-graph/launch-option-views'
import type { MobxPool } from '@podium/client-graph/pool'
import type { MachineWire } from '@podium/model'
import { useCallback, useEffect, useMemo } from 'react'
import { useMobilePool, useMobilePoolProjection } from './mobile-pool'

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

/** Each mounted launcher takes recency once. Its metadata projections stay live. */
export function useLaunchWorkPicker(mode: LaunchWorkMode = 'work') {
  const pool = useMobilePool()
  const picker = useMemo(() => pool ? createLaunchWorkPicker(pool) : undefined, [pool])
  useEffect(() => { picker?.open(mode) }, [picker, mode])
  return picker
}
const NO_REPOSITORIES: string[] = []
export function useLaunchRepositoryPaths() {
  const picker = useLaunchWorkPicker('paths')
  const read = useCallback(() => picker?.opened ? picker.repositoryPaths : NO_REPOSITORIES, [picker])
  return useMobilePoolProjection(read, NO_REPOSITORIES)
}
