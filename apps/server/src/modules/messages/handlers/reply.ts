/**
 * Handler for the `mail.reply` contract (L3).
 *
 * Recipient-ship IS the authorization: the destination is derived from a row the
 * caller has already been authorized to read, never chosen by the caller, which
 * is why no scope target and no `--outside-scope` confirmation apply.
 */

import type { ContractInput, mailReplyContract } from '@podium/commands'
import { senderFromPrincipal } from '../service'
import type { MailHandlerContext } from './context'

export function replyHandler(
  ctx: MailHandlerContext,
  input: ContractInput<typeof mailReplyContract>,
): unknown {
  const { caller, deps, access } = ctx
  const svc = deps.messages
  const original = svc.message(input.id)
  if (!original) throw new Error(`unknown message ${input.id}`)
  // Only the RECIPIENT (or the operator) replies — the reply routes to the
  // original's sender, so recipient-ship is the natural authz boundary.
  if (caller.capability.scope.kind !== 'all' && !access.isRecipient(caller.capability, original)) {
    throw new Error('only the recipient of a message may reply to it')
  }
  const r = svc.sendReply(senderFromPrincipal(caller.principal), {
    inReplyTo: original.id,
    body: input.body,
    kind: input.kind ?? 'ack',
  })
  return {
    id: r.message.id,
    ok: r.ok,
    acked: (input.kind ?? 'ack') === 'ack',
    ...(r.queued !== undefined ? { queued: r.queued } : {}),
    ...(r.reason !== undefined ? { reason: r.reason } : {}),
    disposition: r.disposition,
  }
}
