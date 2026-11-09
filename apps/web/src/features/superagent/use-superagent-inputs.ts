import { useUi, useSocketHub, useRequestClient } from '@podium/client-core/react'
import { useClientRuntime } from '@podium/client-core/react'
import type { SessionView } from '@podium/client-core/session-values'
import type { MobxPool } from '@podium/client-graph'
import { loadedPaneSession } from '@podium/client-graph/session-pane'
import { superagentFocus, superagentThread } from '@podium/client-graph/superagent'
import type { SessionId } from '@podium/model'
import { useCallback } from 'react'
import { useWorklistPoolProjection } from '@/app/store-worklist-pool'

export function useSuperagentAccess() {
  const ui = useUi()
  const owner = useClientRuntime()
  return {
    hub: useSocketHub(),
    trpc: useRequestClient<import('@/app/trpc').Trpc>(),
    readPosition: owner.readPosition,
    setPane: ui.setPane,
    setSelectedWorktree: ui.setSelectedWorktree,
    setSelectedIssueId: ui.setSelectedIssueId,
    setView: ui.setView,
    setSuperThreadId: ui.setSuperThreadId,
    setSuperOpen: ui.setSuperOpen,
  }
}
export function useSuperagentThread(id: string) {
  const read = useCallback((pool: MobxPool) => superagentThread(pool, id), [id])
  return useWorklistPoolProjection(read, { thread: undefined, loading: true })
}
export function useSuperagentSession(id: SessionId | undefined): SessionView | undefined {
  const read = useCallback((pool: MobxPool) => loadedPaneSession(pool, id), [id])
  return useWorklistPoolProjection(read, undefined)
}
const focus = (pool: MobxPool) => superagentFocus(pool)
export function useSuperagentFocus() {
  return useWorklistPoolProjection(focus, {
    repos: [],
    selectedWorktree: null,
    paneA: null,
    sessions: [],
    loading: true,
  })
}
