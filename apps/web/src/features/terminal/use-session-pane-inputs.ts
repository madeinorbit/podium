import { sessionPaneView } from '@podium/client-graph/session-pane'
import type { SessionView } from '@podium/client-core/session-values'
import type { MobxPool } from '@podium/client-graph'
import type { SessionPaneRows } from '@podium/client-graph/session-pane-schema'
import type { IssueStage, MachineWire, SessionId } from '@podium/model/browser'
import { useCallback, useEffect, useRef, useState } from 'react'
import { useWorklistPool, useWorklistPoolProjection } from '@/app/store-worklist-pool'
import { issueColorHex } from '@/lib/issueColors'

const EMPTY_MACHINES: MachineWire[] = []
const EMPTY_WINDOW: SessionPaneRows['sessionPaneWindow'] = {
  panelMode: {},
  dockShells: {},
  reposLoaded: false,
}
export function usePaneSession(id: SessionId | undefined): SessionView | undefined {
  const read = useCallback((pool: MobxPool) => sessionPaneView(pool).session(id), [id])
  return useWorklistPoolProjection(read, undefined)
}
const machinesRead = (pool: MobxPool) => sessionPaneView(pool).machines()
export function usePaneMachines(): MachineWire[] {
  return useWorklistPoolProjection(machinesRead, EMPTY_MACHINES)
}
function windowRead(pool: MobxPool) {
  return sessionPaneView(pool).window()
}
export function usePoolPaneWindow() {
  return useWorklistPoolProjection(windowRead, EMPTY_WINDOW)
}
export function usePaneSpawnConfirmed(id: SessionId) {
  const read = useCallback((pool: MobxPool) => sessionPaneView(pool).spawnConfirmed(id), [id])
  return useWorklistPoolProjection(read, false)
}
export function usePanePanelModes() {
  return usePoolPaneWindow().panelMode
}
export function useDockPaneInputs(cwd: string, pending: string | null) {
  const read = useCallback((pool: MobxPool) => sessionPaneView(pool).dock(cwd, pending), [cwd, pending])
  return useWorklistPoolProjection(read, {
    mapped: undefined,
    session: undefined,
    pendingPresent: false,
    hasSessions: false,
    reposLoaded: false,
    loading: true,
  })
}
export function usePaneOwnership(session: SessionView | undefined) {
  const read = useCallback(
    (pool: MobxPool) => sessionPaneView(pool).ownership(session, issueColorHex),
    [session],
  )
  return useWorklistPoolProjection(read, {
    selectedIssueId: null,
    stampIssue: undefined,
    issueHex: undefined,
  })
}

export interface PaneReferenceStages {
  setActive(active: boolean): void
  beginPaint(): void
  endPaint(): void
  resolveStage(ref: string): IssueStage | null
  subscribe(paint: () => void): () => void
}
const EMPTY_REFERENCE_STAGES: PaneReferenceStages = {
  setActive: () => {},
  beginPaint: () => {},
  endPaint: () => {},
  resolveStage: () => null,
  subscribe: () => () => {},
}

export function usePaneReferenceStages(active: boolean): PaneReferenceStages {
  const pool = useWorklistPool()
  const [stages, setStages] = useState(EMPTY_REFERENCE_STAGES)
  const activeRef = useRef(active)
  activeRef.current = active
  useEffect(() => {
    let disposed = false
    let reader:
      | ReturnType<typeof import('./pane-reference-stages')['createPaneReferenceStages']>
      | undefined
    setStages(EMPTY_REFERENCE_STAGES)
    if (pool) {
      void import('./pane-reference-stages').then(({ createPaneReferenceStages }) => {
        if (disposed) return
        reader = createPaneReferenceStages(pool)
        reader.setActive(activeRef.current)
        setStages(reader)
      })
    }
    return () => {
      disposed = true
      reader?.dispose()
    }
  }, [pool])
  useEffect(() => {
    stages.setActive(active)
  }, [stages, active])
  return stages
}
