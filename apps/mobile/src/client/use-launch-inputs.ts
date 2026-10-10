import { headerView } from '@podium/client-graph/header-views'
import type { RepoView } from '@podium/client-core/values'
import { createLaunchWorkPicker, launchOptionViews, type LaunchWorkMode } from '@podium/client-graph/launch-option-views'
import { LOADING } from '@podium/client-graph/loading'
import { isGone } from '@podium/client-graph/lookup'
import { headerEntities } from '@podium/client-graph/header-entities'
import type { MobxPool } from '@podium/client-graph/pool'
import type { MachineWire } from '@podium/model'
import { useCallback, useEffect, useMemo } from 'react'
import { useMobilePool, useMobilePoolProjection } from './mobile-pool'

const EMPTY = { repo: undefined as RepoView | undefined, machines: [] as MachineWire[] }
export function useLaunchInputs(repoPath: string) {
  const read = useCallback(
    (pool: MobxPool) => launchOptionViews(pool).origin(repoPath),
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
export function useLaunchRepositoryPaths() {
  const picker = useLaunchWorkPicker('paths')
  const read = useCallback((pool: MobxPool) => {
    const catalog = pool.row('commandCatalog', 'catalog')
    if (catalog === LOADING && !headerEntities(pool).orders.has('repository')) return LOADING
    if (isGone(catalog)) return catalog
    return picker?.opened ? picker.repositoryPaths : headerEntities(pool).repositoryGroupIds().flatMap(id => launchOptionViews(pool).repository(id)?.path ?? [])
  }, [picker])
  return useMobilePoolProjection(read, LOADING)
}
