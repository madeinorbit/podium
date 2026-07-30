/**
 * Handler for the `mail.pendingReminders` contract (L3) — the stop hook's
 * single-reminder query (POD-729, moved verbatim out of `MessageGate`).
 *
 * The mailbox is the CAPABILITY's session, never a caller-supplied id, which is
 * why the contract answers ADR 3 Amendment 1 D20 with `callerSuppliedTargetId:
 * false`: there is no address on the wire to probe. A principal with no session
 * (an operator's tRPC call) gets an EMPTY list rather than a refusal — the same
 * answer a session with nothing pending gets, so the two stay indistinguishable.
 */

import type { MailHandlerContext } from './context'

export function pendingRemindersHandler(
  ctx: MailHandlerContext,
): { id: string; from: string; body: string }[] {
  const sessionId = ctx.caller.capability.actorSessionId
  if (!sessionId) return []
  return ctx.deps.messages().pendingReminders(sessionId)
}
