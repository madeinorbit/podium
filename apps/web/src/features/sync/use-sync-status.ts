import {
  HIDDEN_SYNC,
  type StableSync,
  type SyncCondition,
  type SyncDisplay,
  type SyncSignals,
  stepStableSync,
} from '@podium/client-graph/sync-status'
import { useEffect, useReducer, useRef, useSyncExternalStore } from 'react'
import { useHeaderOutboxSize } from '@/app/header-data'
import { usePoolMessageNoticeCount, usePoolRecovery } from '@/features/chat/use-pool-notices'
import { connectionSeverity, useConnectionHealth } from '@/features/machines/ConnectionIndicator'
import type { SyncProgressStore } from '@/lib/sync-progress'

/**
 * The five raw sync signals, read where each one lives today: the connection
 * from the LiveStore (POD-5798), catch-up progress from the replica's progress
 * store, the rest from pool projections; the condition logic itself is shared in
 * `@podium/client-graph/sync-status`.
 */
export function useSyncSignals(progress: SyncProgressStore): SyncSignals {
  const connection = connectionSeverity(useConnectionHealth())
  const replica = useSyncExternalStore(progress.subscribe, progress.getSnapshot)
  const queued = useHeaderOutboxSize()
  const refused = usePoolRecovery().length
  const undelivered = usePoolMessageNoticeCount()
  return { connection, replica, queued, refused, undelivered }
}

/**
 * What the strip shows for a raw condition, after hysteresis. Holds one timer,
 * for the next deadline the state machine names (the deadline pattern in
 * docs/agents/frontend-data.md rule 10), never an interval.
 */
export function useStableSync(
  raw: SyncCondition | null,
  now: () => number = Date.now,
): SyncDisplay {
  const state = useRef<StableSync>(HIDDEN_SYNC)
  const [version, bump] = useReducer((n: number) => n + 1, 0)
  // biome-ignore lint/correctness/useExhaustiveDependencies: `version` re-runs the step when a deadline fires
  useEffect(() => {
    const out = stepStableSync(state.current, raw, now())
    const changed = out.state.shown !== state.current.shown
    state.current = out.state
    if (changed) bump()
    if (out.nextAt === null) return
    const timer = setTimeout(bump, Math.max(0, out.nextAt - now()))
    return () => clearTimeout(timer)
  }, [raw, version, now])
  return state.current.shown
}
