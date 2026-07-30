/**
 * Handler for the `mail.send` contract (L3). The contract's policy is in
 * `@podium/commands`; this file is the only place that knows there is an
 * `IssueService` behind it.
 */

import { type ContractInput, type mailSendContract, UNADDRESSABLE } from '@podium/commands'
import { checkIssueAccess } from '../../../issue-authz'
import { senderFromCapability } from '../service'
import type { MailHandlerContext } from './context'

export async function sendHandler(
  ctx: MailHandlerContext,
  input: ContractInput<typeof mailSendContract>,
): Promise<unknown> {
  const { caller, deps, access } = ctx
  const svc = deps.messages()
  const resolved = access.resolveRecipient(input.to)
  // THE CONSISTENT-ERROR RULE (ADR 3 Amendment 1 D20.2), by construction.
  //
  // An id that does not exist and an id beyond the delegating human's visibility
  // are the SAME resolution value, and both are written to the same
  // {@link UNADDRESSABLE} address. From here on there is one row on one code
  // path, so the two cannot be told apart by a code, a message, a row, or a
  // timing class. The scope gate below then finds no target — which is what an
  // unknown ref has always produced — instead of finding a real one and
  // answering `confirm-required` with the invisible issue's id in the message.
  //
  // NOT the same thing, and deliberately still distinguishable: an issue OUTSIDE
  // the agent's own subtree but INSIDE its human's visibility. That is D2's
  // confirm-required widening (`--outside-scope`), which D20.1 ratifies rather
  // than collapses — it may name its target because the human can already see it.
  const to =
    resolved.kind === 'unresolvable' ? ({ kind: 'issue', id: UNADDRESSABLE } as const) : resolved
  if (to.kind === 'session') {
    access.assertSessionTargetAccess(caller, to.id, 'messages.send')
  } else {
    // Issue-addressed: a write gated against the RESOLVED target issue
    // [spec:SP-34d7 authz] — messages carry urgency/lifecycle (wake →
    // resurrect / spawn), so unlike append-only mailSend a cross-subtree
    // send needs the --outside-scope confirmation. The confirmation only
    // crosses scope; it never elevates the clamp matrix. The spawn-on-wake
    // seam is downstream of this same check, so a spawn always required
    // write access to the target issue.
    checkIssueAccess(caller, deps.issues(), 'messages.send', 'write', to.id)
  }
  // Urgency-gated blocking send [spec:SP-cb9f] [POD-854]: the agent/CLI send
  // surface waits for the trustworthy outcome — interrupt until delivered
  // (transcript-observed), next-turn until delivered within a budget then
  // 'accepted', fyi at queued — so the sender is never handed a bare 'queued'
  // that provably vanished. Only THIS surface blocks; internal sends use send().
  const { sleep, awaitPollMs } = deps
  const nowIso = deps.now
  const r = await svc.sendAndConfirm(
    senderFromCapability(caller.capability),
    {
      to,
      body: input.body,
      ...(input.urgency ? { urgency: input.urgency } : {}),
      ...(input.lifecycle ? { lifecycle: input.lifecycle } : {}),
      ...(input.expectResponse ? { expectsResponse: true } : {}),
      ...(input.expiresAt ? { expiresAt: input.expiresAt } : {}),
    },
    {
      ...(awaitPollMs !== undefined ? { pollMs: awaitPollMs } : {}),
      ...(sleep ? { sleep } : {}),
      ...(nowIso ? { now: () => Date.parse(nowIso()) } : {}),
    },
  )
  // Keep the legacy `queued` boolean consistent with the FINAL (post-blocking)
  // disposition [POD-854]: blocking upgraded a busy-held `queued` sync send to
  // `delivered`, so it must not still report `queued: true` alongside it.
  const queued = r.queued === true && r.disposition === 'delivered' ? false : r.queued
  return {
    id: r.message.id,
    ok: r.ok,
    ...(queued !== undefined ? { queued } : {}),
    ...(r.reason !== undefined ? { reason: r.reason } : {}),
    // The honest, sender-facing outcome [POD-834]: held / dead_letter are never
    // hidden behind a bare "queued" success.
    disposition: r.disposition,
    urgency: r.message.urgency,
    lifecycle: r.message.lifecycle,
    ...(r.message.clampedFrom ? { clamped: true } : {}),
    // Confirm a response was requested [POD-835 §04b] so the sender knows a reply
    // (and a settle-nag if none) is expected — otherwise receipt is mechanical.
    ...(r.message.expectsResponse ? { expectsResponse: true } : {}),
  }
}
