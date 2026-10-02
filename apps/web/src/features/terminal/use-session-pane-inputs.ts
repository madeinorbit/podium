import { legacySessionPaneRead } from '@podium/client-core/perf'
import { sessionById } from '@podium/client-core/viewmodels'
import type { SessionView } from '@podium/client-core/session-values'
import type { SessionId, MachineWire } from '@podium/model/browser'
import { useCallback } from 'react'
import { useStoreSelector } from '@/app/store'
import { useWorklistPoolProjection } from '@/app/store-worklist-pool'
import type { MobxPool } from '@podium/client-graph'
import { paneSession, paneMachines, paneWindow, paneHasSessions, paneSpawnConfirmed } from '@podium/client-graph/session-pane'
import { LOADING } from '@podium/client-graph/worklist/rollup'
import { sessionPaneDataLayer } from './session-pane-data-layer'
import type { SessionPaneRows } from '@podium/client-graph/session-pane-schema'

const EMPTY_MACHINES: MachineWire[] = []
const EMPTY_WINDOW: SessionPaneRows['sessionPaneWindow'] = { panelMode: {}, dockShells: {}, reposLoaded: false, pendingSpawnIds: new Set() }
function useLegacyPaneSession(id: SessionId | undefined): SessionView | undefined {
  return useStoreSelector(s => legacySessionPaneRead(s.replica ?? s, 'session', () => id === undefined ? undefined : sessionById(s.sessions).get(id)))
}
function usePoolPaneSession(id: SessionId | undefined): SessionView | undefined {
  const read = useCallback((pool: MobxPool) => {
    const row = paneSession(pool, id)
    return row === LOADING ? undefined : row
  }, [id])
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
function usePoolPaneMachines(): MachineWire[] { return useWorklistPoolProjection(paneMachines, EMPTY_MACHINES) }
export function usePaneMachines(): MachineWire[] {
  const useRead = sessionPaneDataLayer() === 'pool' ? usePoolPaneMachines : useLegacyPaneMachines
  return useRead()
}
function windowRead(pool: MobxPool) {
  const value = paneWindow(pool)
  return !value || value === LOADING ? EMPTY_WINDOW : value
}
export function usePoolPaneWindow() { return useWorklistPoolProjection(windowRead, EMPTY_WINDOW) }
function useLegacySpawnConfirmed(id: SessionId) { return useStoreSelector(s => legacySessionPaneRead(s.replica ?? s, 'spawn', () => !s.pendingSpawnIds.has(id))) }
function usePoolSpawnConfirmed(id: SessionId) {
  const read = useCallback((pool: MobxPool) => paneSpawnConfirmed(pool, id), [id])
  return useWorklistPoolProjection(read, false)
}
export function usePaneSpawnConfirmed(id: SessionId) {
  const useRead = sessionPaneDataLayer() === 'pool' ? usePoolSpawnConfirmed : useLegacySpawnConfirmed
  return useRead(id)
}
export function usePoolPaneHasSessions() { return useWorklistPoolProjection(paneHasSessions, false) }
