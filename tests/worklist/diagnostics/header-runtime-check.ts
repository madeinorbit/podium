import { headerRequests } from '@podium/client-graph/header-requests'
import { headerView } from '@podium/client-graph/header-views'
import { referenceState } from './reference-state'
import type { PodiumClientApi } from '@podium/client-core/api'
import type { ClientRuntime } from '@podium/client-core/engine'
import { runInAction } from 'mobx'
import type { MobxPool } from '@podium/client-graph/pool'
import { checkHeader } from './header-check'

/** Both flags are frozen by the app. Comparison is an explicit timer job and
 * shares the existing runtime, pool, and teardown. Diagnostics never hydrate. */
export function startHeaderCheck(runtime: ClientRuntime<PodiumClientApi>, pool: MobxPool,
  report: (value: { state: string; checks: number; differences: number; pending?: number; first?: { sectionIndex: number; field: string } | null }) => void,
  intervalMs = 5000): () => void {
  if (!Number.isFinite(intervalMs) || intervalMs <= 0) throw new Error('Header check interval must be positive')
  let disposed = false, checks = 0
  report({ state: 'waiting', checks, differences: 0 })
  const timer = setInterval(() => {
    if (disposed) return
    try {
      // POD-5798: live readings come from the LiveStore, history and lifecycle
      // from the header's request answers.
      const requests = headerRequests(pool)
      const result = runInAction(() => checkHeader(pool, referenceState(runtime), {
        metrics: headerView(pool).metrics(), quotas: headerView(pool).quotas(),
        history: requests?.history ?? undefined, lifecycle: requests?.lifecycle ?? undefined,
        connection: runtime.live.connection, outboxSize: runtime.live.outbox.pending,
        liveOnline: [...runtime.live.machineConditions].flatMap(([id, reading]) =>
          reading.known && reading.value.online ? [id] : []),
      }))
      checks++
      report({ state: result.pending ? 'waiting' : result.differences ? 'different' : 'match', checks,
        differences: result.differences, pending: result.pending,
        first: result.first ? { sectionIndex: result.first.sectionIndex, field: result.first.field } : null })
    } catch { report({ state: 'error', checks, differences: 0 }) }
  }, intervalMs)
  return () => { if (!disposed) { disposed = true; clearInterval(timer); report({ state: 'off', checks, differences: 0 }) } }
}
