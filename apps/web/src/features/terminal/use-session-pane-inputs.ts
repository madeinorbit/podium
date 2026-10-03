
import type { SessionView } from '@podium/client-core/session-values'
import type { SessionId, MachineWire } from '@podium/model/browser'
import { useCallback, useEffect, useState } from 'react'
import type { IssueStage } from '@podium/model/browser'
import { useWorklistPool, useWorklistPoolProjection } from '@/app/store-worklist-pool'
import type { MobxPool } from '@podium/client-graph'
import { issueColorHex } from '@/lib/issueColors'
import type { SessionPaneRows } from '@podium/client-graph/session-pane-schema'

const EMPTY_MACHINES: MachineWire[] = []
const EMPTY_WINDOW: SessionPaneRows['sessionPaneWindow'] = { panelMode: {}, dockShells: {}, reposLoaded: false, pendingSpawnIds: new Set() }
export function usePaneSession(id: SessionId | undefined): SessionView | undefined {
  const read = useCallback((pool: MobxPool) => pool.sessionPanes.session(id), [id])
  return useWorklistPoolProjection(read, undefined)
}
const machinesRead = (pool: MobxPool) => pool.sessionPanes.machines()
export function usePaneMachines(): MachineWire[] { return useWorklistPoolProjection(machinesRead, EMPTY_MACHINES) }
function windowRead(pool: MobxPool) {
  return pool.sessionPanes.window()
}
export function usePoolPaneWindow() { return useWorklistPoolProjection(windowRead, EMPTY_WINDOW) }
export function usePaneSpawnConfirmed(id: SessionId) {
  const read = useCallback((pool: MobxPool) => pool.sessionPanes.spawnConfirmed(id), [id])
  return useWorklistPoolProjection(read, false)
}
export function usePanePanelModes() { return usePoolPaneWindow().panelMode }
export function useDockPaneInputs(cwd: string, pending: string | null) {
  const read = useCallback((pool: MobxPool) => pool.sessionPanes.dock(cwd, pending), [cwd, pending])
  return useWorklistPoolProjection(read, { mapped: undefined, session: undefined, pendingPresent: false, hasSessions: false, reposLoaded: false, loading: true })
}
export function usePaneOwnership(session: SessionView | undefined) {
  const read = useCallback((pool: MobxPool) => pool.sessionPanes.ownership(session, issueColorHex), [session])
  return useWorklistPoolProjection(read, { selectedIssueId: null, stampIssue: undefined, issueHex: undefined })
}

export interface PaneReferenceStages {
  resolveStage(ref: string): IssueStage | null
  subscribe(paint: () => void): () => void
}
const EMPTY_REFERENCE_STAGES: PaneReferenceStages = {
  resolveStage: () => null,
  subscribe: () => () => {},
}

export function usePaneReferenceStages(): PaneReferenceStages {
  const pool = useWorklistPool()
  const [stages, setStages] = useState(EMPTY_REFERENCE_STAGES)
  useEffect(() => {
    let disposed = false
    let reader: ReturnType<typeof import('./pane-reference-stages')['createPaneReferenceStages']> | undefined
    setStages(EMPTY_REFERENCE_STAGES)
    if (pool) {
      void import('./pane-reference-stages').then(({ createPaneReferenceStages }) => {
        if (disposed) return
        reader = createPaneReferenceStages(pool)
        setStages(reader)
      })
    }
    return () => { disposed = true; reader?.dispose() }
  }, [pool])
  return stages
}
