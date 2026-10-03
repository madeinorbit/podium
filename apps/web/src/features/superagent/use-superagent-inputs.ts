import type { SessionId } from '@podium/model'
import type { SessionView } from '@podium/client-core/session-values'
import { useStoreHandle } from '@podium/client-core/react'
import { superagentFocus, superagentThread } from '@podium/client-graph/superagent'
import type { MobxPool } from '@podium/client-graph'
import { useCallback } from 'react'
import { type Store } from '@/app/store'
import { useWorklistPoolProjection } from '@/app/store-worklist-pool'

type SuperagentAccess = Pick<Store, 'hub' | 'trpc' | 'refreshSuperThreads' | 'readPosition' |
  'setPane' | 'setSelectedWorktree' | 'setSelectedIssueId' | 'setView' | 'setSuperThreadId' | 'setSuperOpen'>
function access(s: Store): SuperagentAccess {
  return { hub: s.hub, trpc: s.trpc, refreshSuperThreads: s.refreshSuperThreads, readPosition: s.readPosition,
    setPane: s.setPane, setSelectedWorktree: s.setSelectedWorktree, setSelectedIssueId: s.setSelectedIssueId,
    setView: s.setView, setSuperThreadId: s.setSuperThreadId, setSuperOpen: s.setSuperOpen }
}
export function useSuperagentAccess() { return access(useStoreHandle().getSnapshot() as Store) }
export function useSuperagentThread(id: string) {
  const read = useCallback((pool: MobxPool) => superagentThread(pool, id), [id])
  return useWorklistPoolProjection(read, { thread: undefined, loading: true })
}
export function useSuperagentSession(id: SessionId | undefined): SessionView | undefined {
  const read = useCallback((pool: MobxPool) => pool.sessionPanes.session(id), [id])
  return useWorklistPoolProjection(read, undefined)
}
const focus = (pool: MobxPool) => superagentFocus(pool)
export function useSuperagentFocus() { return useWorklistPoolProjection(focus, { repos: [], selectedWorktree: null, paneA: null, sessions: [], loading: true }) }
