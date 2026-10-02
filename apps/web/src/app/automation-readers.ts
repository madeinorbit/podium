import { useStoreHandle } from '@podium/client-core/react'
import { shallowEqual } from '@podium/client-core/store'
import { machineViewsFromWire } from '@podium/client-core/viewmodels'
import { automationViews, EMPTY_EXCLUSIONS } from '@podium/client-graph/automation-views'
import { LOADING } from '@podium/client-graph/worklist/rollup'
import { useCallback, useMemo } from 'react'
import { automationTargetChoices, userAutomations } from '@/features/automations/automation-form'
import { automationsDataLayer, recordLegacyAutomationRead, specsDataLayer } from '@/lib/automations-data-layer'
import { useStoreSelector } from './store'
import { useWorklistPoolProjection } from './store-worklist-pool'
import type { Trpc } from './trpc'

const EMPTY_LIST = { automations: [], automationRuns: [], runGroups: {}, pending: 1 }
const EMPTY_TARGETS = { repos: [], choices: [], excluded: EMPTY_EXCLUSIONS, pending: 1 }
const EMPTY_REPOS = { repos: [], pending: 1 }
const poolList = (pool: Parameters<typeof automationViews>[0]) => automationViews(pool).list()
const poolRepos = (pool: Parameters<typeof automationViews>[0]) => automationViews(pool).repositories()

function useLegacyList() {
  const owner = useStoreHandle<Trpc>()
  const rows = useStoreSelector(state => {
    recordLegacyAutomationRead(owner, 'list')
    return { automations: state.automations, automationRuns: state.automationRuns }
  }, shallowEqual)
  return { automations: userAutomations(rows.automations), automationRuns: rows.automationRuns, runGroups: undefined, pending: 0 }
}
function usePoolList() { return useWorklistPoolProjection(poolList, EMPTY_LIST) }
export const useAutomationList = automationsDataLayer() === 'pool' ? usePoolList : useLegacyList

function useLegacyTargets(currentPath: string | null) {
  const owner = useStoreHandle<Trpc>()
  const rows = useStoreSelector(state => {
    recordLegacyAutomationRead(owner, 'targets')
    return { repos: state.repos, sessions: state.sessions ?? [], machines: state.machines ?? [] }
  }, shallowEqual)
  return useMemo(() => ({ repos: rows.repos, pending: 0,
    ...automationTargetChoices(rows.repos, rows.sessions, machineViewsFromWire(rows.machines), currentPath),
  }), [rows.repos, rows.sessions, rows.machines, currentPath])
}
function usePoolTargets(currentPath: string | null) {
  const read = useCallback((pool: Parameters<typeof automationViews>[0]) => automationViews(pool).targets(currentPath), [currentPath])
  return useWorklistPoolProjection(read, EMPTY_TARGETS)
}
export const useAutomationTargets = automationsDataLayer() === 'pool' ? usePoolTargets : useLegacyTargets

function useLegacyRunSession(id: string | undefined) {
  const owner = useStoreHandle<Trpc>()
  // Count at the actual selector boundary, including every publication.
  return useStoreSelector(state => {
    recordLegacyAutomationRead(owner, 'runSession')
    return id ? state.sessions.find(session => session.sessionId === id) : undefined
  })
}
function usePoolRunSession(id: string | undefined) {
  const read = useCallback((pool: Parameters<typeof automationViews>[0]) => automationViews(pool).session(id), [id])
  const row = useWorklistPoolProjection(read, LOADING)
  return row === LOADING ? undefined : row
}
export const useAutomationRunSession = automationsDataLayer() === 'pool' ? usePoolRunSession : useLegacyRunSession

function useLegacyRepos() {
  const owner = useStoreHandle<Trpc>()
  const repos = useStoreSelector(state => {
    recordLegacyAutomationRead(owner, 'specs')
    return state.repos
  })
  return { repos, pending: 0 }
}
function usePoolRepos() { return useWorklistPoolProjection(poolRepos, EMPTY_REPOS) }
export const useSpecsRepositories = specsDataLayer() === 'pool' ? usePoolRepos : useLegacyRepos
