import { legacySessionPaneRead } from '@podium/client-core/perf'
import { useStoreHandle } from '@podium/client-core/react'
import { sessionById } from '@podium/client-core/store'
import type { SessionView } from '@podium/client-core/session-values'
import type { SessionId, MachineWire } from '@podium/model/browser'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { resolveIssueReference } from '@podium/client-core/viewmodels'
import type { IssueStage } from '@podium/model/browser'
import { useReplicaIssues, useStoreSelector } from '@/app/store'
import { useWorklistPool, useWorklistPoolProjection } from '@/app/store-worklist-pool'
import type { MobxPool } from '@podium/client-graph'
import { sessionPaneDataLayer } from './session-pane-data-layer'
import { effectiveIssueColorHex, issueColorHex } from '@/lib/issueColors'
import type { SessionPaneRows } from '@podium/client-graph/session-pane-schema'

const EMPTY_MACHINES: MachineWire[] = []
const EMPTY_WINDOW: SessionPaneRows['sessionPaneWindow'] = { panelMode: {}, dockShells: {}, reposLoaded: false, pendingSpawnIds: new Set() }
function useLegacyPaneSession(id: SessionId | undefined): SessionView | undefined {
  return useStoreSelector(s => legacySessionPaneRead(s.replica ?? s, 'session', () => id === undefined ? undefined : sessionById(s.sessions).get(id)))
}
function usePoolPaneSession(id: SessionId | undefined): SessionView | undefined {
  const read = useCallback((pool: MobxPool) => pool.sessionPanes.session(id), [id])
  return useWorklistPoolProjection(read, undefined)
}
/** The choice is latched once before mounting any screen. Neither branch
 * subscribes to, or invokes, the other read path. */
export function usePaneSession(id: SessionId | undefined): SessionView | undefined {
  const useRead = sessionPaneDataLayer() === 'pool' ? usePoolPaneSession : useLegacyPaneSession
  return useRead(id)
}
function useLegacyPaneMachines(): MachineWire[] {
  return useStoreSelector(s => legacySessionPaneRead(s.replica ?? s, 'machines', () => s.machines))
}
const machinesRead = (pool: MobxPool) => pool.sessionPanes.machines()
function usePoolPaneMachines(): MachineWire[] { return useWorklistPoolProjection(machinesRead, EMPTY_MACHINES) }
export function usePaneMachines(): MachineWire[] {
  const useRead = sessionPaneDataLayer() === 'pool' ? usePoolPaneMachines : useLegacyPaneMachines
  return useRead()
}
function windowRead(pool: MobxPool) {
  return pool.sessionPanes.window()
}
export function usePoolPaneWindow() { return useWorklistPoolProjection(windowRead, EMPTY_WINDOW) }
function useLegacySpawnConfirmed(id: SessionId) { return useStoreSelector(s => legacySessionPaneRead(s.replica ?? s, 'spawn', () => !s.pendingSpawnIds.has(id))) }
function usePoolSpawnConfirmed(id: SessionId) {
  const read = useCallback((pool: MobxPool) => pool.sessionPanes.spawnConfirmed(id), [id])
  return useWorklistPoolProjection(read, false)
}
export function usePaneSpawnConfirmed(id: SessionId) {
  const useRead = sessionPaneDataLayer() === 'pool' ? usePoolSpawnConfirmed : useLegacySpawnConfirmed
  return useRead(id)
}

function useLegacyPanePanelModes() {
  return useStoreSelector(s => legacySessionPaneRead(s.replica ?? s, 'panelMode', () => s.panelMode))
}
function usePoolPanePanelModes() { return usePoolPaneWindow().panelMode }
export function usePanePanelModes() {
  const useRead = sessionPaneDataLayer() === 'pool' ? usePoolPanePanelModes : useLegacyPanePanelModes
  return useRead()
}
function useLegacyDockInputs(cwd: string, pending: string | null) {
  return useStoreSelector(s => legacySessionPaneRead(s.replica ?? s, 'dock', () => ({
    mapped: s.dockShells[cwd],
    session: s.sessions.find(row => row.sessionId === s.dockShells[cwd]),
    pendingPresent: !!pending && s.sessions.some(row => row.sessionId === pending),
    hasSessions: s.sessions.length > 0,
    reposLoaded: s.reposLoaded, loading: false,
  })), (a, b) => a.mapped === b.mapped && a.session === b.session && a.pendingPresent === b.pendingPresent && a.hasSessions === b.hasSessions && a.reposLoaded === b.reposLoaded)
}
function usePoolDockInputs(cwd: string, pending: string | null) {
  const read = useCallback((pool: MobxPool) => pool.sessionPanes.dock(cwd, pending), [cwd, pending])
  return useWorklistPoolProjection(read, { mapped: undefined, session: undefined, pendingPresent: false, hasSessions: false, reposLoaded: false, loading: true })
}
export function useDockPaneInputs(cwd: string, pending: string | null) {
  const useRead = sessionPaneDataLayer() === 'pool' ? usePoolDockInputs : useLegacyDockInputs
  return useRead(cwd, pending)
}

function useLegacyPaneOwnership(session: SessionView | undefined) {
  const issues = useReplicaIssues()
  return useStoreSelector(s => legacySessionPaneRead(s.replica ?? s, 'ownership', () => {
    const selectedIssueId = s.selectedIssueId
    const selected = selectedIssueId ? issues.find(i => i.id === selectedIssueId && !i.archived && !i.deletedAt) : undefined
    const stamp = issues.find(i => !i.deletedAt && !i.archived && (session?.issueId === i.id ||
      (i.worktreePath !== null && session?.cwd !== undefined &&
        (session.cwd === i.worktreePath || session.cwd.startsWith(`${i.worktreePath}/`)))))
    return { selectedIssueId, stampIssue: stamp, issueHex: effectiveIssueColorHex(selected, id => issues.find(i => i.id === id)) }
  }), (a, b) => a.selectedIssueId === b.selectedIssueId && a.stampIssue === b.stampIssue && a.issueHex === b.issueHex)
}
function usePoolPaneOwnership(session: SessionView | undefined) {
  const read = useCallback((pool: MobxPool) => pool.sessionPanes.ownership(session, issueColorHex), [session])
  return useWorklistPoolProjection(read, { selectedIssueId: null, stampIssue: undefined, issueHex: undefined })
}
export function usePaneOwnership(session: SessionView | undefined) {
  const useRead = sessionPaneDataLayer() === 'pool' ? usePoolPaneOwnership : useLegacyPaneOwnership
  return useRead(session)
}

export interface PaneReferenceStages {
  resolveStage(ref: string): IssueStage | null
  subscribe(paint: () => void): () => void
}
const EMPTY_REFERENCE_STAGES: PaneReferenceStages = {
  resolveStage: () => null,
  subscribe: () => () => {},
}

function useLegacyPaneReferenceStages(): PaneReferenceStages {
  const owner = useStoreHandle()
  const issues = useReplicaIssues()
  legacySessionPaneRead(owner, 'referenceIssues', () => issues)
  return useMemo(() => ({
    resolveStage: (ref: string) => resolveIssueReference(ref, issues)?.stage ?? null,
    subscribe: EMPTY_REFERENCE_STAGES.subscribe,
  }), [issues])
}

function usePoolPaneReferenceStages(): PaneReferenceStages {
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

export function usePaneReferenceStages(): PaneReferenceStages {
  const useRead = sessionPaneDataLayer() === 'pool' ? usePoolPaneReferenceStages : useLegacyPaneReferenceStages
  return useRead()
}
