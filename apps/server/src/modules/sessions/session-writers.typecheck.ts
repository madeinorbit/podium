/**
 * SESSION WRITES NAME THEIR WRITER (ADR 12 D9, POD-6601), held by the server
 * typecheck: a session store writer takes its commit's write scope, and a
 * session write through the service takes the writer of whoever asked. Never
 * executed; each `@ts-expect-error` fails the build if the call compiles.
 */

import type { SessionId } from '@podium/model'
import type { SessionStore } from '../../store'
import type { SessionRow } from '../../store/types'
import type { SessionLifecycle } from './lifecycle'
import type { Session } from './session'

export async function sessionWritesNeedAWriter(
  store: SessionStore,
  sessions: SessionLifecycle,
  row: SessionRow,
  session: Session,
  sessionId: SessionId,
): Promise<void> {
  // @ts-expect-error a session row is written with its commit's scope
  await store.sessions.upsertSession(row)
  // @ts-expect-error an offer row too
  await store.sessions.clearOffer(sessionId)
  // @ts-expect-error a read mark too
  await store.sessions.markSessionUnread('user' as never, sessionId)
  // @ts-expect-error the service writes with the writer of whoever asked
  await sessions.renameSession({ sessionId, name: 'x' })
  // @ts-expect-error an archive too
  await sessions.setArchived({ sessionId, archived: true })
  // @ts-expect-error and the repository underneath
  await sessions.repository.persist(session)
}
