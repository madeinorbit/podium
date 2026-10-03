import type { SessionId } from '@podium/model'
import type { SessionView } from '@podium/client-core/session-values'
import { useStoreHandle } from '@podium/client-core/react'
import { sessionById, shallowEqual } from '@podium/client-core/store'
import { superagentSlice, threadById } from '@podium/client-core/viewmodels'
import { superagentFocus, superagentThread } from '@podium/client-graph/superagent'
import type { MobxPool } from '@podium/client-graph'
import { useCallback } from 'react'
import { useSlice, useStoreSelector, type Store } from '@/app/store'
import { useWorklistPoolProjection } from '@/app/store-worklist-pool'
import { legacySuperagentRead, superagentDataLayer } from './data-layer'

type SuperagentAccess = Pick<Store, 'hub' | 'trpc' | 'refreshSuperThreads' | 'readPosition' |
  'setPane' | 'setSelectedWorktree' | 'setSelectedIssueId' | 'setView' | 'setSuperThreadId' | 'setSuperOpen'>
function access(s: Store): SuperagentAccess {
  return { hub: s.hub, trpc: s.trpc, refreshSuperThreads: s.refreshSuperThreads, readPosition: s.readPosition,
    setPane: s.setPane, setSelectedWorktree: s.setSelectedWorktree, setSelectedIssueId: s.setSelectedIssueId,
    setView: s.setView, setSuperThreadId: s.setSuperThreadId, setSuperOpen: s.setSuperOpen }
}
function useLegacyAccess() { return useStoreSelector(access, shallowEqual) }
function usePoolAccess() { return access(useStoreHandle().getSnapshot() as Store) }
export function useSuperagentAccess(): SuperagentAccess {
  const useRead = superagentDataLayer() === 'pool' ? usePoolAccess : useLegacyAccess
  return useRead()
}

function useLegacyThread(id: string) { return { thread: threadById(useSlice(superagentSlice).threads, id), loading: false } }
function usePoolThread(id: string) {
  const read = useCallback((pool: MobxPool) => superagentThread(pool, id), [id])
  return useWorklistPoolProjection(read, { thread: undefined, loading: true })
}
export function useSuperagentThread(id: string) {
  const useRead = superagentDataLayer() === 'pool' ? usePoolThread : useLegacyThread
  return useRead(id)
}

function useLegacySession(id: SessionId | undefined): SessionView | undefined {
  return useStoreSelector(s => legacySuperagentRead(s.replica ?? s, 'session', () =>
    id === undefined ? undefined : sessionById(s.sessions).get(id)))
}
function usePoolSession(id: SessionId | undefined): SessionView | undefined {
  const read = useCallback((pool: MobxPool) => pool.sessionPanes.session(id), [id])
  return useWorklistPoolProjection(read, undefined)
}
export function useSuperagentSession(id: SessionId | undefined): SessionView | undefined {
  const useRead = superagentDataLayer() === 'pool' ? usePoolSession : useLegacySession
  return useRead(id)
}

function useLegacyFocus() {
  const controls = useStoreSelector(s => legacySuperagentRead(s.replica ?? s, 'focus', () =>
    ({ repos: s.repos, selectedWorktree: s.selectedWorktree, paneA: s.paneA })), shallowEqual)
  const session = useLegacySession((controls.paneA ?? undefined) as SessionId | undefined)
  return { ...controls, sessions: session ? [session] : [], loading: false }
}
const focus = (pool: MobxPool) => superagentFocus(pool)
function usePoolFocus() { return useWorklistPoolProjection(focus, { repos: [], selectedWorktree: null, paneA: null, sessions: [], loading: true }) }
export function useSuperagentFocus() {
  const useRead = superagentDataLayer() === 'pool' ? usePoolFocus : useLegacyFocus
  return useRead()
}
