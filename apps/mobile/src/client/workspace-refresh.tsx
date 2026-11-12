import type { SyncPhase, SyncProgressStore } from '@podium/client-core/replica-assembly'
import { createContext, useContext, useEffect, useRef, useState, useSyncExternalStore } from 'react'

/** The existing shared lifecycle, passed through without a second store. */
export const WorkspaceSyncContext = createContext<SyncProgressStore | null>(null)
const subscribeIdle = () => () => {}
const ready = (): SyncPhase => 'ready'

export function useWorkspaceSyncPhase(): SyncPhase {
  const store = useContext(WorkspaceSyncContext)
  return useSyncExternalStore(
    store?.subscribe ?? subscribeIdle,
    store ? () => store.getSnapshot().phase : ready,
  )
}

export const UPDATED_SUBTITLE_MS = 3_000

/** Only the brief completion label is local UI state; sync facts stay shared. */
export function useWorkspaceRefreshSubtitle(): string | undefined {
  const phase = useWorkspaceSyncPhase()
  const previous = useRef(phase)
  const [showResult, setShowResult] = useState(false)

  useEffect(() => {
    const settled = ['ready', 'offline', 'error'].includes(phase)
    const completed = settled && phase !== previous.current
    previous.current = phase
    setShowResult(completed)
    if (completed) {
      const timer = setTimeout(() => setShowResult(false), UPDATED_SUBTITLE_MS)
      return () => clearTimeout(timer)
    }
  }, [phase])

  if (phase === 'offline' || phase === 'error') {
    return showResult ? 'Offline · Showing saved data' : undefined
  }
  if (phase !== 'ready') return 'Updating…'
  return showResult ? 'Updated just now' : undefined
}
