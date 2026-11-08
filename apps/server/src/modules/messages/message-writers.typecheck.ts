/**
 * MESSAGE WRITES NAME THEIR WRITER (ADR 12 D9, POD-6602), held by the server
 * typecheck: a messages store writer takes its commit's write scope, and a
 * messages write through the delivery service takes the writer of whoever
 * asked. Never executed; each `@ts-expect-error` fails the build if the call
 * compiles.
 */

import type { SessionId } from '@podium/model'
import type { WriteScope } from '@podium/sync'
import type { SessionStore } from '../../store'
import type { MessageRow } from '../../store/types'
import type { InboxPrincipalReference, SessionInbox } from '../sessions/inbox'
import type { MessageMailbox } from './mailbox'
import type { MessageDeliveryService, MessageSender } from './service'

export async function messageWritesNeedAWriter(
  store: SessionStore,
  service: MessageDeliveryService,
  mailbox: MessageMailbox,
  row: MessageRow,
  from: MessageSender,
  sessionId: SessionId,
  scope: WriteScope,
  inbox: SessionInbox,
  principal: InboxPrincipalReference,
): Promise<void> {
  // @ts-expect-error a message row is stored with its commit's scope
  await store.messages.addMessage(row)
  // @ts-expect-error a delivery-status move too
  await store.messages.markDispatched(row.id, sessionId, row.createdAt)
  // @ts-expect-error a stamp beside the status too
  await store.messages.requestRetract(row.id, row.createdAt)
  // @ts-expect-error the janitor's expiry too
  await store.messages.expireObserved({
    id: row.id,
    createdAt: row.createdAt,
    lifecycle: row.lifecycle,
    expiresAt: row.expiresAt,
  })
  // @ts-expect-error a send is written with the writer of whoever asked
  await service.send(from, { to: { kind: 'session', id: sessionId }, body: 'x' })
  // @ts-expect-error a retract too
  await service.cancel(row.id)
  // @ts-expect-error a notice's dismissal too
  await service.dismissNotice(row.id)
  // @ts-expect-error a removal's failures are part of the removal's own write
  await service.failMessagesToRemovedSessions([sessionId])
  // @ts-expect-error and the pull path underneath
  await mailbox.readInbox([{ kind: 'session', id: sessionId }], { consume: sessionId })
  // @ts-expect-error the session inbox has no writer of its own: a send carries one
  await inbox.queueText({ sessionId, text: 'x' })
  // @ts-expect-error a direct send too
  await inbox.sendText({ sessionId, text: 'x' })
  // @ts-expect-error a stored configure too
  await inbox.configureSession({ sessionId, model: 'm' })
  // @ts-expect-error an answer's admission too
  await inbox.answerAskUserQuestion({ sessionId, principal })
  // With them, each compiles.
  await store.messages.addMessage(scope, row)
  await service.failMessagesToRemovedSessions(scope, [sessionId])
}
