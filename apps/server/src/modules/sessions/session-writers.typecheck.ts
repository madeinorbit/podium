/**
 * SESSION WRITES NAME THEIR WRITER (ADR 12 D9, POD-6601), held by the server
 * typecheck: a session store writer takes its commit's write scope, and a
 * session write through the service takes the writer of whoever asked. Never
 * executed; each `@ts-expect-error` fails the build if the call compiles.
 */

import type { SessionId, UserId } from '@podium/model'
import type { SessionStore } from '../../store'
import type { SessionsRepository } from '../../store/sessions'
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

/**
 * PER-USER STATE IS KEYED BY USER (POD-1076), in the repository's own
 * signatures: each pin, snooze and tab-order accessor takes the user whose
 * state it is. A signature that dropped the parameter would make every caller
 * pass one instance-wide account and re-create the singleton. Moved here from
 * `scripts/audit-session-commands.ts` (`per-user-keying`, POD-6595).
 */
type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false
type Holds<T extends true> = T
export type PerUserStateIsKeyedByUser = [
  Holds<Same<Parameters<SessionsRepository['listPins']>[0], UserId>>,
  Holds<Same<Parameters<SessionsRepository['setPin']>[0], UserId>>,
  Holds<Same<Parameters<SessionsRepository['listSnoozes']>[0], UserId>>,
  Holds<Same<Parameters<SessionsRepository['setSnooze']>[1], UserId>>,
  Holds<Same<Parameters<SessionsRepository['clearSnooze']>[1], UserId>>,
  Holds<Same<Parameters<SessionsRepository['listTabOrders']>[0], UserId>>,
  Holds<Same<Parameters<SessionsRepository['setTabOrder']>[0], UserId>>,
]
