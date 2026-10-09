import { omitGone } from '@podium/client-graph/lookup'
import type { SessionView } from '@podium/client-core/session-values'
import type { MobxPool } from '@podium/client-graph'
import type { SessionId } from '@podium/model'
import { useCallback, useEffect, useRef } from 'react'
import { useRuntimeActions, useRuntimeLocal } from '@/app/keyed-runtime'
import { useWorklistPoolProjection } from '@/app/store-worklist-pool'

type DockShellLifecycleSession = Pick<
  SessionView,
  'sessionId' | 'agentKind' | 'archived' | 'status'
>

/** A dock shell is dead only when its process is gone for good. A hibernated
 *  shell is PARKED, not dead (POD-4429): the row and cwd are intact and the
 *  same session id resumes in place, so the dock must not archive or replace
 *  it. Only 'archived' and 'exited' remain dead for the dock. */
export function dockShellIsDead(
  session: Pick<DockShellLifecycleSession, 'archived' | 'status'>,
): boolean {
  return session.archived || session.status === 'exited'
}

/** A hibernated dock shell is parked: resumable in place via the same session
 *  id (POD-4429). Never stale, never archived by the lifecycle. */
export function dockShellIsParked(
  session: Pick<DockShellLifecycleSession, 'archived' | 'status'>,
): boolean {
  return !session.archived && session.status === 'hibernated'
}

/** Unarchived, dead shells still owned by this device's dock mapping. */
export function staleDockShellIds(
  dockShells: Readonly<Record<string, SessionId>>,
  sessions: readonly DockShellLifecycleSession[],
): SessionId[] {
  const mappedIds = new Set<SessionId>(Object.values(dockShells))
  return sessions
    .filter(
      (session) =>
        mappedIds.has(session.sessionId) &&
        session.agentKind === 'shell' &&
        !session.archived &&
        dockShellIsDead(session),
    )
    .map((session) => session.sessionId)
}

/**
 * Retire dead dock-owned shells while the application is mounted, independently
 * of whether the Shell panel itself is open. The device-local mapping remains
 * in place so opening the panel can recognize the dead row and replace it.
 */
const ACTIONS = ['trpc'] as const
const EMPTY_IDS: SessionId[] = []

/** Ask only about mapped identities, using the pool's declared cold fields. */
export function useStaleDockShellIds(): SessionId[] {
  const dockShells = useRuntimeLocal('dockShells')
  const read = useCallback(
    (pool: MobxPool) => {
      const sessions = [...new Set(Object.values(dockShells))]
        .filter((id) => !pool.queries.collapsed(id))
        .sort((a, b) => {
          const left = pool.queries.orderKey(a),
            right = pool.queries.orderKey(b)
          return left < right ? -1 : left > right ? 1 : a.localeCompare(b)
        })
        .flatMap((id) => {
          const row = omitGone(pool.row('session', id, 'summary-fields'))
          return row && typeof row !== 'symbol' ? [row as unknown as DockShellLifecycleSession] : []
        })
      return staleDockShellIds(dockShells, sessions)
    },
    [dockShells],
  )
  return useWorklistPoolProjection(read, EMPTY_IDS)
}

export function DockShellLifecycle(): null {
  const { trpc } = useRuntimeActions(ACTIONS)
  const staleIds = useStaleDockShellIds()
  const requested = useRef(new Set<SessionId>())

  useEffect(() => {
    const stale = new Set(staleIds)
    for (const sessionId of requested.current) {
      if (!stale.has(sessionId)) requested.current.delete(sessionId)
    }
    for (const sessionId of staleIds) {
      if (requested.current.has(sessionId)) continue
      requested.current.add(sessionId)
      void trpc.sessions.setArchived
        .mutate({ sessionId, archived: true })
        .catch(() => requested.current.delete(sessionId))
    }
  }, [staleIds, trpc])

  return null
}
