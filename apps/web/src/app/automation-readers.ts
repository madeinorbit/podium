import { automationViews, EMPTY_EXCLUSIONS } from '@podium/client-graph/automation-views'
import { LOADING } from '@podium/client-graph/worklist/rollup'
import { useCallback } from 'react'
import { useWorklistPoolProjection } from './store-worklist-pool'

const EMPTY_LIST = { automations: [], automationRuns: [], runGroups: {}, pending: 1 }
const EMPTY_TARGETS = { ids: [], excluded: EMPTY_EXCLUSIONS, pending: 1 }
const EMPTY_REPOS = { repos: [], pending: 1 }
const poolList = (pool: Parameters<typeof automationViews>[0]) => automationViews(pool).list()
const poolRepos = (pool: Parameters<typeof automationViews>[0]) =>
  automationViews(pool).repositories()
export function useAutomationList() {
  return useWorklistPoolProjection(poolList, EMPTY_LIST)
}
export function useAutomationTargets(currentPath: string | null) {
  const read = useCallback(
    (pool: Parameters<typeof automationViews>[0]) => automationViews(pool).targets(currentPath),
    [currentPath],
  )
  return useWorklistPoolProjection(read, EMPTY_TARGETS)
}
export function useAutomationTarget(id: string | undefined) {
  const read = useCallback(
    (pool: Parameters<typeof automationViews>[0]) => id === undefined ? undefined : automationViews(pool).target(id),
    [id],
  )
  return useWorklistPoolProjection(read, undefined)
}
export function useAutomationTargetMachine(path: string) {
  const read = useCallback(
    (pool: Parameters<typeof automationViews>[0]) => automationViews(pool).targetMachine(path),
    [path],
  )
  return useWorklistPoolProjection(read, undefined)
}
export function useAutomationTargetForPath(path: string, savedPath: string | null) {
  const read = useCallback(
    (pool: Parameters<typeof automationViews>[0]) => automationViews(pool).targetForPath(path, savedPath),
    [path, savedPath],
  )
  return useWorklistPoolProjection(read, undefined)
}
export function useAutomationRunSession(id: string | undefined) {
  const read = useCallback(
    (pool: Parameters<typeof automationViews>[0]) => automationViews(pool).session(id),
    [id],
  )
  const row = useWorklistPoolProjection(read, LOADING)
  return row === LOADING ? undefined : row
}
export function useSpecsRepositories() {
  return useWorklistPoolProjection(poolRepos, EMPTY_REPOS)
}
