import { shallowEqual } from '@podium/client-core/store'
import type { SessionId, SessionMeta } from '@podium/model'
import { useEffect, useRef } from 'react'
import { useStoreSelector } from '@/app/store'

type DockShellLifecycleSession = Pick<
  SessionMeta,
  'sessionId' | 'agentKind' | 'archived' | 'status'
>

/** A dock shell cannot be revived in place once its process has stopped. */
export function dockShellIsDead(
  session: Pick<DockShellLifecycleSession, 'archived' | 'status'>,
): boolean {
  return session.archived || session.status === 'exited' || session.status === 'hibernated'
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
export function DockShellLifecycle(): null {
  const { dockShells, sessions, trpc } = useStoreSelector(
    (state) => ({
      dockShells: state.dockShells,
      sessions: state.sessions,
      trpc: state.trpc,
    }),
    shallowEqual,
  )
  const requested = useRef(new Set<SessionId>())

  useEffect(() => {
    const staleIds = staleDockShellIds(dockShells, sessions)
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
  }, [dockShells, sessions, trpc])

  return null
}
