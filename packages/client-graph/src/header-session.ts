import type { SessionView } from '@podium/client-core/session-values'
import { CONFIRMED_AGENT_ACTIVITY_MAX_AGE_MS, isAgentComputing } from '@podium/model/browser'
import { measureHeader } from '@podium/client-core/perf'

export type WorkingSession = Pick<SessionView, 'sessionId' | 'title' | 'name' | 'displayRef' | 'agentKind'>

export const EMPTY_HOST_AGGREGATE = {
  count: 0, idleSplit: { idle: 0, parkable: 0, protected: 0 },
  phases: { working: 0, idle: 0, waiting: 0, other: 0 },
}
export type HeaderAggregate = typeof EMPTY_HOST_AGGREGATE

export function headerWorkingDeadline(row: SessionView | undefined): number | undefined {
  if (!row || row.status !== 'live' || !isAgentComputing(row)) return undefined
  const activity = Math.max(...[row.agentState?.stateObservedAt, row.lastActiveAt, row.agentState?.since]
    .map((stamp) => Date.parse(stamp ?? '')).filter(Number.isFinite))
  return Number.isFinite(activity) ? activity + CONFIRMED_AGENT_ACTIVITY_MAX_AGE_MS : undefined
}

/** Each resident session contributes independently. The deadline atom changes
 * only when evidence expires, so a minute tick never scans the idle fleet. */
export function headerWorkingSession(row: SessionView | undefined, passed: (at: number) => boolean): WorkingSession | null {
  return measureHeader('pool.workingSession', () => {
    const deadline = headerWorkingDeadline(row)
    if (!row || deadline === undefined || passed(deadline)) return null
    return { sessionId: row.sessionId, title: row.title, name: row.name,
      displayRef: row.displayRef, agentKind: row.agentKind }
  })
}

export function headerHostSession(row: SessionView | undefined) {
  return measureHeader('pool.hostSession', () => {
    if (!row || !['live', 'starting', 'reconnecting'].includes(row.status)) return null
    return { cwd: row.cwd, machineId: row.machineId, archived: !!row.archived,
      status: row.status, phase: row.agentState?.phase, resumable: !!row.resumable }
  })
}

/** Rail location ignores activity phase; changing phase cannot rescan repos. */
export function headerDockSession(row: SessionView | undefined) {
  if (!row) return undefined
  return { sessionId: row.sessionId, issueId: row.issueId, cwd: row.cwd, machineId: row.machineId,
    archived: row.archived, lastActiveAt: row.lastActiveAt }
}
