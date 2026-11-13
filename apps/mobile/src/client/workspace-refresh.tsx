import type { SyncPhase, SyncProgressStore } from '@podium/client-core/replica-assembly'
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react'
import type { NativeConnectivity } from './native-connectivity'

export { watchSyncResume as watchWorkspaceResume } from '@podium/client-core/replica-assembly'

/** The existing shared lifecycle, passed through without a second store. */
export const WorkspaceSyncContext = createContext<SyncProgressStore | null>(null)
const subscribeIdle = () => () => {}
const ready = (): SyncPhase => 'ready'
const foreground = () => true
const WorkspaceVisibilityContext = createContext<NativeConnectivity['visibility'] | undefined>(
  undefined,
)

export function useWorkspaceSyncPhase(): SyncPhase {
  const store = useContext(WorkspaceSyncContext)
  return useSyncExternalStore(
    store?.subscribe ?? subscribeIdle,
    store ? () => store.getSnapshot().phase : ready,
  )
}

export const UPDATED_SUBTITLE_MS = 3_000
export const UPDATING_SUBTITLE = 'Updating…'
export const UPDATED_SUBTITLE = 'Updated just now'
export const OFFLINE_SUBTITLE = 'Offline · Showing saved data'

const isSettled = (phase: SyncPhase): boolean =>
  phase === 'ready' || phase === 'offline' || phase === 'error'

/**
 * Where the user's own pull stands. Pure UI state: a pull on an already-live
 * replica changes nothing in the shared sync lifecycle, yet the person who
 * pulled still expects the header to acknowledge it.
 */
export type WorkspacePullStatus = 'idle' | 'running' | 'updated'

interface WorkspacePull {
  readonly status: WorkspacePullStatus
  /** A list began a user-initiated refresh. */
  begin(): void
  /** That refresh finished; `phase` is the shared sync phase it ended on. */
  settle(phase: SyncPhase): void
  /** The pulling list went away before its refresh settled. */
  cancel(): void
}

const WorkspacePullContext = createContext<WorkspacePull | null>(null)

/**
 * Provides the shared sync store plus the brief acknowledgement of a pull.
 * Sync facts still come only from the shared store; this adds no data state.
 */
export function WorkspaceRefreshProvider({
  store,
  visibility,
  children,
}: {
  store: SyncProgressStore
  visibility?: NativeConnectivity['visibility'] | undefined
  children: ReactNode
}) {
  const [status, setStatus] = useState<WorkspacePullStatus>('idle')
  const begin = useCallback(() => setStatus('running'), [])
  const settle = useCallback(
    (phase: SyncPhase) => setStatus(phase === 'ready' ? 'updated' : 'idle'),
    [],
  )
  const cancel = useCallback(
    () => setStatus((current) => (current === 'running' ? 'idle' : current)),
    [],
  )

  useEffect(() => {
    if (status !== 'updated') return
    const timer = setTimeout(() => setStatus('idle'), UPDATED_SUBTITLE_MS)
    return () => clearTimeout(timer)
  }, [status])

  const pull = useMemo(() => ({ status, begin, settle, cancel }), [status, begin, settle, cancel])
  return (
    <WorkspaceSyncContext value={store}>
      <WorkspaceVisibilityContext value={visibility}>
        <WorkspacePullContext value={pull}>{children}</WorkspacePullContext>
      </WorkspaceVisibilityContext>
    </WorkspaceSyncContext>
  )
}

/** The pull lifecycle for refresh controls; null outside the sync boundary. */
export function useWorkspacePull(): WorkspacePull | null {
  return useContext(WorkspacePullContext)
}

/** Only the brief completion label is local UI state; sync facts stay shared. */
export function useWorkspaceRefreshSubtitle(): string | undefined {
  const phase = useWorkspaceSyncPhase()
  const visibility = useContext(WorkspaceVisibilityContext)
  const visible = useSyncExternalStore(
    visibility?.subscribe ?? subscribeIdle,
    visibility?.isVisible ?? foreground,
  )
  const pullStatus = useContext(WorkspacePullContext)?.status ?? 'idle'
  const previous = useRef(phase)
  const wasVisible = useRef(visible)
  const [showUpdated, setShowUpdated] = useState(false)

  useEffect(() => {
    const completed =
      visible && phase === 'ready' && (phase !== previous.current || !wasVisible.current)
    previous.current = phase
    wasVisible.current = visible
    setShowUpdated(completed)
    if (completed) {
      const timer = setTimeout(() => setShowUpdated(false), UPDATED_SUBTITLE_MS)
      return () => clearTimeout(timer)
    }
  }, [phase, visible])

  // Prime the native subtitle before suspension, including the switcher snapshot
  // shown before JS wakes. The socket closes by design while we are away.
  if (!visible) return UPDATING_SUBTITLE
  if (!isSettled(phase)) return UPDATING_SUBTITLE

  // A user pull is acknowledged regardless of whether the shared phase moved.
  if (pullStatus === 'running') return UPDATING_SUBTITLE

  // A failure is current sync state, so it lasts until the shared phase changes.
  if (phase === 'offline' || phase === 'error') return OFFLINE_SUBTITLE
  if (pullStatus === 'updated') return UPDATED_SUBTITLE
  return showUpdated ? UPDATED_SUBTITLE : undefined
}
