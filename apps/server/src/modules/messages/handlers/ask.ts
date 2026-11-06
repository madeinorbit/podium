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
  return await askAnswer(ctx, input, await askSend(ctx, input))
}

/** What the question's write records: the question, as it was stored. */
export interface AskSent {
  readonly questionId: string
  readonly clamped?: true
}

/**
 * THE WRITE HALF (POD-6525): the gate, and the question stored as a message.
 * On the sync write entry point this is the command's handler, in its unit of
 * work; its delivery follows the commit.
 */
export async function askSend(
  ctx: MailHandlerContext,
  input: ContractInput<typeof mailAskContract>,
): Promise<AskSent> {
  const { caller, deps, access } = ctx
  await access.assertSessionTargetAccess(caller, input.sessionId, 'messages.ask')
  const svc = deps.messages
  const r = await svc.send(senderFromPrincipal(caller.principal), {
    to: { kind: 'session', id: input.sessionId },
    body: input.question,
    kind: 'question',
    urgency: 'next-turn',
    lifecycle: 'wake',
    ...(ctx.inEntry ? { terminalInUnit: true } : {}),
  })
  return { questionId: r.message.id, ...(r.message.clampedFrom ? { clamped: true as const } : {}) }
}

/**
 * THE WAIT (POD-6525): the bounded wait for the answer, and the target's
 * status. Never part of a write: an adapter runs it after the question's write
 * committed, and a replay of that write waits again on the same question.
 */
export async function askAnswer(
  ctx: MailHandlerContext,
  input: ContractInput<typeof mailAskContract>,
  sent: AskSent,
): Promise<unknown> {
  const { deps } = ctx
  const svc = deps.messages
  const sleep = deps.sleep ?? undefined
  const ack = await svc.awaitAck(sent.questionId, {
    timeoutMs: (input.timeoutSeconds ?? 30) * 1000,
    ...(deps.awaitPollMs !== undefined ? { pollMs: deps.awaitPollMs } : {}),
    ...(sleep ? { sleep } : {}),
  })
  const target = await deps.sessionById(input.sessionId)
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
      questionId: sent.questionId,
      answer: ack.body,
      ackId: ack.id,
      snapshot,
    }
  }
  return {
    answered: false,
    questionId: sent.questionId,
    reason: 'no answer yet — the question is delivered/queued; check back or await the ack',
    ...(sent.clamped ? { clamped: true } : {}),
    snapshot,
  }
}
