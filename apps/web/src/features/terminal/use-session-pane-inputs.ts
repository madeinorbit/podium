import { assertReactiveRead } from '@podium/mobx-helpers'
import { sessionPaneView } from '@podium/client-graph/session-pane'
import type { SessionView } from '@podium/client-core/session-values'
import type { IssueModel, MobxPool, SessionModel } from '@podium/client-graph'
import type { SessionPaneRows } from '@podium/client-graph/session-pane-schema'
import { LOADING } from '@podium/client-graph/worklist/rollup'
import type { IssueId, IssueStage, MachineWire, SessionId } from '@podium/model/browser'
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
export interface DockPaneInputs {
  mapped: string | undefined
  session: SessionModel | undefined
  pendingPresent: boolean
  hasSessions: boolean
  reposLoaded: boolean
  loading: boolean
}
const EMPTY_DOCK: DockPaneInputs = {
  mapped: undefined,
  session: undefined,
  pendingPresent: false,
  hasSessions: false,
  reposLoaded: false,
  loading: true,
}
/** Read inside the dock shell's observer: each answer is its own field, so a
 * heartbeat on the mapped shell wakes nothing here. */
export function useDockPaneInputs(cwd: string, pending: string | null): DockPaneInputs {
  if (import.meta.env.DEV) assertReactiveRead('useDockPaneInputs')
  const pool = useWorklistPool()
  if (!pool) return EMPTY_DOCK
  const panes = sessionPaneView(pool),
    controls = panes.window()
  const mapped = controls.dockShells[cwd]
  const present = mapped ? panes.pane(pool.sessionObject(mapped)).present : undefined
  return {
    mapped,
    session: present === true && mapped ? pool.sessionObject(mapped) : undefined,
    pendingPresent: !!panes.loaded(pending),
    hasSessions: panes.hasSessions(),
    reposLoaded: controls.reposLoaded,
    loading: present === LOADING,
  }
}
/** The terminal's birth grid, read inside the dock terminal's observer. */
export function usePaneGeometry(id: SessionId): SessionView['geometry'] {
  if (import.meta.env.DEV) assertReactiveRead('usePaneGeometry')
  const pool = useWorklistPool()
  return pool ? sessionPaneView(pool).loaded(id)?.geometry : undefined
}
const selectedIssueRead = (pool: MobxPool) => sessionPaneView(pool).selectedIssueId
/** The selected issue: a selection fact, independent of the pane's session. */
export function usePaneSelectedIssueId(): IssueId | null {
  return useWorklistPoolProjection(selectedIssueRead, null)
}
const issueHexRead = (pool: MobxPool) => sessionPaneView(pool).issueHex(issueColorHex)
/** The selected issue's inherited tint, independent of the pane's session. */
export function usePaneIssueHex(): string | undefined {
  return useWorklistPoolProjection(issueHexRead, undefined)
}
/** The issue a session pane stamps, read inside the stamp's observer. */
export function usePaneStampIssue(id: SessionId): IssueModel | undefined {
  if (import.meta.env.DEV) assertReactiveRead('usePaneStampIssue')
  const pool = useWorklistPool()
  const stamp = pool ? sessionPaneView(pool).loaded(id)?.stampIssue : undefined
  return stamp === LOADING ? undefined : stamp
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
