/**
 * Handler for the `mail.ask` contract (L3) — the seance [spec:SP-34d7
 * read-toolkit tier 4], moved verbatim out of `MessageGate` by POD-729.
 *
 * WHY THIS ONE MATTERED MOST OF THE FIVE. `ask` is the only member of the
 * hand-written remainder that reaches message DELIVERY: it calls
 * `MessageDeliveryService.send` directly. Leaving it in the switch would have
 * left exactly the thing this issue exists to remove — a live send path that no
 * contract policy governs, reachable from two transports, sitting one refactor
 * away from drifting out of step with `mail.send`'s gate.
 *
 * Implemented AS A MESSAGE: a `kind:'question'` row at next-turn + wake whose
 * server-rendered envelope constrains the receiver to answer-then-resume; a dead
 * or parked target wakes via harness-native resume so the predecessor's full
 * context answers, and only the answer (the ack) crosses back. Authz is the
 * session-target gate — the SAME one `mail.send` uses, not a copy — and the send
 * pipeline's clamps, wake cooldown and hop brake apply unchanged: a question is
 * never exempt. The wait is BOUNDED: the answer, or "no answer yet" plus a
 * status snapshot.
 */

import type { ContractInput, mailAskContract } from '@podium/commands'
import { senderFromPrincipal } from '../service'
import type { MailHandlerContext } from './context'

export async function askHandler(
  ctx: MailHandlerContext,
  input: ContractInput<typeof mailAskContract>,
): Promise<unknown> {
  const { caller, deps, access } = ctx
  access.assertSessionTargetAccess(caller, input.sessionId, 'messages.ask')
  const svc = deps.messages()
  const r = svc.send(senderFromPrincipal(caller.principal), {
    to: { kind: 'session', id: input.sessionId },
    body: input.question,
    kind: 'question',
    urgency: 'next-turn',
    lifecycle: 'wake',
  })
  const sleep = deps.sleep ?? undefined
  const ack = await svc.awaitAck(r.message.id, {
    timeoutMs: (input.timeoutSeconds ?? 30) * 1000,
    ...(deps.awaitPollMs !== undefined ? { pollMs: deps.awaitPollMs } : {}),
    ...(sleep ? { sleep } : {}),
  })
  const target = deps.listSessions().find((s) => s.sessionId === input.sessionId)
  const snapshot = target
    ? {
        sessionId: target.sessionId,
        status: target.status,
        ...(target.agentState?.phase ? { phase: target.agentState.phase } : {}),
        ...(target.issueId ? { issueId: target.issueId } : {}),
      }
    : null
  if (ack) {
    return {
      answered: true,
      questionId: r.message.id,
      answer: ack.body,
      ackId: ack.id,
      snapshot,
    }
  }
  return {
    answered: false,
    questionId: r.message.id,
    reason: 'no answer yet — the question is delivered/queued; check back or await the ack',
    ...(r.message.clampedFrom ? { clamped: true } : {}),
    snapshot,
  }
}
