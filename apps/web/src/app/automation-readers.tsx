import { createAutomationViews, EMPTY_EXCLUSIONS } from '@podium/client-graph/automation-views'
import { omitGone } from '@podium/client-graph/lookup'
import type { MobxPool } from '@podium/client-graph'
import { useOpeningView } from '@podium/client-graph/react'
import { LOADING } from '@podium/client-graph/worklist/rollup'
import { createContext, useContext, useCallback, type ReactNode } from 'react'
import { useWorklistPool, useWorklistPoolProjection } from './store-worklist-pool'

const AutomationOpeningContext = createContext<ReturnType<typeof createAutomationViews> | null>(
  null,
)
export function AutomationOpening({ children }: { children: ReactNode }) {
  const view = useOpeningView(useWorklistPool(), createAutomationViews)
  return (
    <AutomationOpeningContext.Provider value={view}>{children}</AutomationOpeningContext.Provider>
  )
}
function useAutomationOpening() {
  const inherited = useContext(AutomationOpeningContext)
  const own = useOpeningView(useWorklistPool(), createAutomationViews, !inherited)
  return inherited ?? own
}

const EMPTY_LIST = { automations: [], pending: 1 }
const EMPTY_TARGETS = { ids: [], excluded: EMPTY_EXCLUSIONS, pending: 1 }
const EMPTY_REPOS = { repos: [], pending: 1 }
export function useAutomationList() {
  const view = useAutomationOpening()
  const read = useCallback((_pool: MobxPool) => view?.list() ?? EMPTY_LIST, [view])
  return useWorklistPoolProjection(read, EMPTY_LIST)
}
export function useAutomation(id: string | null | undefined) {
  const read = useCallback((pool: MobxPool) => {
    if (id == null) return undefined
    const model = omitGone(pool.model('automation', id))
    return model === LOADING ? undefined : model
  }, [id])
  return useWorklistPoolProjection(read, undefined)
}
export function useAutomationTargets(currentPath: string | null) {
  const view = useAutomationOpening()
  const read = useCallback(
    (pool: MobxPool) => view?.targets(currentPath) ?? EMPTY_TARGETS,
    [view, currentPath],
  )
  return useWorklistPoolProjection(read, EMPTY_TARGETS)
}
export function useAutomationTarget(id: string | undefined) {
  const view = useAutomationOpening()
  const read = useCallback(
    (pool: MobxPool) => (id === undefined ? undefined : view?.target(id)),
    [view, id],
  )
  return useWorklistPoolProjection(read, undefined)
}
export function useAutomationTargetMachine(path: string) {
  const view = useAutomationOpening()
  const read = useCallback((pool: MobxPool) => view?.targetMachine(path), [view, path])
  return useWorklistPoolProjection(read, undefined)
}
export function useAutomationTargetForPath(path: string, savedPath: string | null) {
  const view = useAutomationOpening()
  const read = useCallback(
    (pool: MobxPool) => view?.targetForPath(path, savedPath),
    [view, path, savedPath],
  )
  return useWorklistPoolProjection(read, undefined)
}
export function useAutomationRunSession(id: string | undefined) {
  const view = useAutomationOpening()
  const read = useCallback((pool: MobxPool) => view?.session(id), [view, id])
  const row = useWorklistPoolProjection(read, LOADING)
  return row === LOADING ? undefined : row
}
export function useSpecsRepositories() {
  const view = useAutomationOpening()
  const read = useCallback((_pool: MobxPool) => view?.repositories() ?? EMPTY_REPOS, [view])
  return useWorklistPoolProjection(read, EMPTY_REPOS)
}
