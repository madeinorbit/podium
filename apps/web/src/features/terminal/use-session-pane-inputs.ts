import { useUiValue } from '@podium/client-core/react'
import type { SessionView } from '@podium/client-core/session-values'
import type { SessionIssueOutcome } from '@podium/client-core/values'
import type { IssueModel, MobxPool, SessionModel } from '@podium/client-graph'
import type { SessionPaneRows } from '@podium/client-graph/session-pane-schema'
import type { SessionPanes } from '@podium/client-graph/session-pane-view'
import { LOADING } from '@podium/client-graph/worklist/rollup'
import { assertReactiveRead } from '@podium/mobx-helpers'
import {
  asSessionId,
  type IssueId,
  type IssueStatus,
  type MachineFacts,
  type SessionId,
} from '@podium/model/browser'
import { useCallback, useEffect, useRef, useState } from 'react'
import { useWorklistPool, useWorklistPoolProjection } from '@/app/store-worklist-pool'

/** The lazy runtime installs the view before publishing the pool to hooks. */
function sessionPanes(pool: MobxPool): SessionPanes {
  const view = pool.sources.peekView<SessionPanes>('sessionPanes')
  if (!view) throw new Error('Session panes require their pool screen')
  return view
}

const EMPTY_MACHINES: MachineFacts[] = []
const EMPTY_WINDOW: SessionPaneRows['sessionPaneWindow'] = {
  panelMode: {},
  dockShells: {},
}
export function usePaneSession(id: SessionId | undefined): SessionView | undefined {
  const read = useCallback((pool: MobxPool) => sessionPanes(pool).session(id), [id])
  return useWorklistPoolProjection(read, undefined)
}
/** The session is running and its machine is known offline right now: the
 *  derived condition (ADR 12 D1), read off the shared session model. */
export function usePaneReconnecting(id: SessionId | undefined): boolean {
  const read = useCallback(
    (pool: MobxPool) => (id ? pool.sessionObject(id).reconnecting : false),
    [id],
  )
  return useWorklistPoolProjection(read, false)
}
const machinesRead = (pool: MobxPool) => sessionPanes(pool).machines()
/** How the session's issue ended, when that is what stopped it (POD-2151). */
export function usePaneIssueOutcome(id: SessionId): SessionIssueOutcome | null {
  const read = useCallback(
    (pool: MobxPool) => sessionPanes(pool).loaded(id)?.issueOutcome ?? null,
    [id],
  )
  return useWorklistPoolProjection(read, null)
}
export function usePaneMachines(): MachineFacts[] {
  return useWorklistPoolProjection(machinesRead, EMPTY_MACHINES)
}
function windowRead(pool: MobxPool) {
  return sessionPanes(pool).window()
}
export function usePoolPaneWindow() {
  return useWorklistPoolProjection(windowRead, EMPTY_WINDOW)
}
export function usePaneSpawnConfirmed(id: SessionId) {
  const read = useCallback((pool: MobxPool) => sessionPanes(pool).spawnConfirmed(id), [id])
  return useWorklistPoolProjection(read, false)
}
export function usePanePanelModes() {
  // UiStore owns this choice. The session row can become available before
  // the optional pane-window source installs; its empty fallback must never
  // replace a saved choice while that source is loading.
  return useUiValue('panelMode')
}
export interface DockPaneInputs {
  mapped: SessionId | undefined
  session: SessionModel | undefined
  pendingPresent: boolean
  hasSessions: boolean
  loading: boolean
}
const EMPTY_DOCK: DockPaneInputs = {
  mapped: undefined,
  session: undefined,
  pendingPresent: false,
  hasSessions: false,
  loading: true,
}
/** Read inside the dock shell's observer: each answer is its own field, so a
 * heartbeat on the mapped shell wakes nothing here. */
export function useDockPaneInputs(cwd: string, pending: string | null): DockPaneInputs {
  if (import.meta.env.DEV) assertReactiveRead('useDockPaneInputs')
  const pool = useWorklistPool()
  if (!pool) return EMPTY_DOCK
  const panes = sessionPanes(pool),
    controls = panes.window()
  const mappedId = controls.dockShells[cwd]
  const mapped = mappedId === undefined ? undefined : asSessionId(mappedId)
  const present = mapped ? panes.pane(pool.sessionObject(mapped)).present : undefined
  return {
    mapped,
    session: present === true && mapped ? pool.sessionObject(mapped) : undefined,
    pendingPresent: !!panes.loaded(pending),
    hasSessions: panes.hasSessions(),
    loading: present === LOADING,
  }
}
/** The terminal's birth grid, read inside the dock terminal's observer. */
export function usePaneGeometry(id: SessionId): SessionView['geometry'] | undefined {
  if (import.meta.env.DEV) assertReactiveRead('usePaneGeometry')
  const pool = useWorklistPool()
  return pool ? sessionPanes(pool).loaded(id)?.session.geometry : undefined
}
const selectedIssueRead = (pool: MobxPool) => sessionPanes(pool).selectedIssueId
/** The selected issue: a selection fact, independent of the pane's session. */
export function usePaneSelectedIssueId(): IssueId | null {
  return useWorklistPoolProjection(selectedIssueRead, null)
}
/** The issue a session pane stamps, read inside the stamp's observer. */
export function usePaneStampIssue(id: SessionId): IssueModel | undefined {
  if (import.meta.env.DEV) assertReactiveRead('usePaneStampIssue')
  const pool = useWorklistPool()
  const stamp = pool ? sessionPanes(pool).loaded(id)?.stampIssue : undefined
  return stamp === LOADING ? undefined : stamp
}

export interface PaneReferenceStages {
  setActive(active: boolean): void
  beginPaint(): void
  endPaint(): void
  resolveStatus(ref: string): IssueStatus | null
  subscribe(paint: () => void): () => void
}
const EMPTY_REFERENCE_STAGES: PaneReferenceStages = {
  setActive: () => {},
  beginPaint: () => {},
  endPaint: () => {},
  resolveStatus: () => null,
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
