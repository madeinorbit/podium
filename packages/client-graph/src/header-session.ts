import type { SessionView } from '@podium/client-core/session-values'
import { computingDeadlineOf } from './shared/session-facts'

export type WorkingSession = Pick<SessionView, 'sessionId' | 'title' | 'name' | 'displayRef' | 'agentKind'>

export const EMPTY_HOST_AGGREGATE = {
  count: 0, idleSplit: { idle: 0, parkable: 0, protected: 0 },
  phases: { working: 0, idle: 0, waiting: 0, other: 0 },
}
export type HeaderAggregate = typeof EMPTY_HOST_AGGREGATE

export const headerWorkingDeadline = computingDeadlineOf

/** Each resident session contributes independently. The deadline atom changes
 * only when evidence expires, so a minute tick never scans the idle fleet. */
export function headerWorkingSession(row: SessionView | undefined, passed: (at: number) => boolean): WorkingSession | null {
  const deadline = headerWorkingDeadline(row)
  if (!row || deadline === undefined || passed(deadline)) return null
  return { sessionId: row.sessionId, title: row.title, name: row.name,
    displayRef: row.displayRef, agentKind: row.agentKind }
}

export function headerHostSession(row: SessionView | undefined) {
  if (!row || !['live', 'starting', 'reconnecting'].includes(row.status)) return null
  return { cwd: row.cwd, machineId: row.machineId, archived: !!row.archived,
    status: row.status, phase: row.agentState?.phase, resumable: !!row.resumable }
}

/** Rail location ignores activity phase; changing phase cannot rescan repos. */
export function headerDockSession(row: SessionView | undefined) {
  if (!row) return undefined
  return { sessionId: row.sessionId, issueId: row.issueId, cwd: row.cwd, machineId: row.machineId,
    archived: row.archived, lastActiveAt: row.lastActiveAt }
}
