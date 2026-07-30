/**
 * Handler for the `mail.awaitAgent` contract (L3).
 *
 * `podium agent await <sessionId>`: a BOUNDED wait for the child. Returns an
 * actionable result the parent can branch on — never a false "still working"
 * when the child is blocked, done, or gone (docs/agent-comms-target.html
 * §09-D/§09-E; overnight-stall fix). NEVER hangs (every wait bounded).
 *
 * Precedence each poll: (1) session missing → gone; (2) fresh ack since
 * waitStart → acked; (3) phase/status → blocked | done | gone (exited with no
 * report); (4) deadline → working. Only acks since waitStart count.
 *
 * CLASSIFICATION (the acceptance criterion asked for the check): a WAIT, not a
 * query — it retires a notification-fact claim on observing a settled child,
 * which is a durable write, and the shipped gate already authorizes it as a
 * `write` through the session-target gate. See the contract for the working.
 */

import type { awaitAgentContract, ContractInput } from '@podium/commands'
import type { SessionMeta } from '@podium/model'
import type { Capability } from '../../../issue-authz'
import type { MailHandlerContext } from './context'

export async function awaitAgentHandler(
  ctx: MailHandlerContext,
  input: ContractInput<typeof awaitAgentContract>,
): Promise<unknown> {
  const { caller, deps, access } = ctx
  // The parent relationship (spawnedBy provenance) is sufficient authority to
  // await its own child — even across issue scopes (it already crossed them,
  // confirmed, at spawn time). Everyone else passes the session-target gate.
  const child = deps.listSessions().find((x) => x.sessionId === input.sessionId)
  const isParent =
    caller.capability.actorSessionId !== undefined &&
    child?.spawnedBy === `session:${caller.capability.actorSessionId}`
  if (!isParent) access.assertSessionTargetAccess(caller, input.sessionId, 'agent.await')
  const svc = deps.messages()
  const timeoutMs = (input.timeoutSeconds ?? 30) * 1000
  const pollMs = deps.awaitPollMs ?? 500
  const sleep = deps.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)))
  const principals = access.callerPrincipals(caller.capability)
  const deadline = Date.now() + timeoutMs
  // Only acks SINCE THE WAIT BEGAN count (the documented contract) — a stale
  // ack from a previous round must not satisfy a new await, or the parent
  // believes new work finished when the child never acked the new instruction.
  const waitStart = deps.now?.() ?? new Date().toISOString()
  // biome-ignore lint/nursery/noConstantCondition: loop exits via return
  for (;;) {
    const s = deps.listSessions().find((x) => x.sessionId === input.sessionId)
    if (!s) {
      return finishAwait(ctx, isParent, caller, input.sessionId, {
        done: true,
        result: 'gone',
        snapshot: null,
      })
    }
    // Rich agent ack first (it carries WHAT the child did): the child's most
    // recent ack addressed back to this caller since the wait began. Wins over
    // exit/settle classification — reported-then-exited is acked, not gone.
    const ack = svc
      .inbox(principals, { limit: 50 })
      .filter(
        (m) => m.kind === 'ack' && m.fromSession === input.sessionId && m.createdAt >= waitStart,
      )
      .at(-1)
    if (ack) {
      return finishAwait(ctx, isParent, caller, input.sessionId, {
        done: true,
        result: 'acked',
        ack: access.wire(ack),
        snapshot: snap(s),
      })
    }
    // Actionable phase/status — parent must never read these as "working".
    const phase = s.agentState?.phase
    // Exit without a fresh report: process gone, nothing for the parent to
    // re-prompt on this session (the other overnight-stall case).
    if (s.status === 'exited') {
      return finishAwait(
        ctx,
        isParent,
        caller,
        input.sessionId,
        { done: true, result: 'gone', snapshot: snap(s) },
        phase,
        s.status,
      )
    }
    // Blocked: needs parent/human (question menu) or escalation (error).
    if (phase === 'needs_user' || phase === 'errored') {
      return finishAwait(
        ctx,
        isParent,
        caller,
        input.sessionId,
        { done: true, result: 'blocked', snapshot: snap(s) },
        phase,
        s.status,
      )
    }
    // Clean finish: idle/ended harness phase, or hibernated (parked cleanly).
    if (s.status === 'hibernated' || phase === 'idle' || phase === 'ended') {
      return finishAwait(
        ctx,
        isParent,
        caller,
        input.sessionId,
        { done: true, result: 'done', snapshot: snap(s) },
        phase,
        s.status,
      )
    }
    if (Date.now() >= deadline) {
      return { done: false, result: 'working', snapshot: snap(s) }
    }
    await sleep(Math.min(pollMs, Math.max(1, deadline - Date.now())))
  }
}

function snap(s: SessionMeta): Record<string, unknown> {
  return {
    sessionId: s.sessionId,
    status: s.status,
    ...(s.agentState?.phase ? { phase: s.agentState.phase } : {}),
    // Carry need/error so a blocked parent can act without a second lookup.
    ...(s.agentState?.need ? { need: s.agentState.need } : {}),
    ...(s.agentState?.error ? { error: s.agentState.error } : {}),
    title: s.title,
    ...(s.issueId ? { issueId: s.issueId } : {}),
    ...(s.lastActiveAt ? { lastActiveAt: s.lastActiveAt } : {}),
    ...(s.queuedMessageCount ? { queuedMessageCount: s.queuedMessageCount } : {}),
  }
}

/**
 * Parent-await consume-on-ack (POD-917/POD-923): when the caller is the child's
 * session parent and the await observed a settled/terminal state, retire the
 * session-parent wake sticky so a later genuine re-completion can re-fire once.
 * Never throws — missing dep or store errors must not break await.
 *
 * This is the durable write that makes `awaitAgent` a wait rather than a query.
 */
function finishAwait(
  ctx: MailHandlerContext,
  isParent: boolean,
  caller: { capability: Capability },
  childSessionId: string,
  outcome: { done: boolean; result: string; snapshot: unknown; ack?: unknown },
  phase?: string,
  status?: string,
): { done: boolean; result: string; snapshot: unknown; ack?: unknown } {
  if (isParent && shouldConsumeSessionParentSettle(outcome.result, phase, status)) {
    const parentId = caller.capability.actorSessionId
    if (parentId) {
      try {
        ctx.deps.retireNotificationFact?.(
          `sessionparentnudge:phase-reported:${childSessionId}`,
          parentId,
        )
      } catch {
        // never throw from await
      }
    }
  }
  return outcome
}

/** Settled/terminal outcomes that mean the parent has observed the child settle. */
function shouldConsumeSessionParentSettle(
  result: string,
  phase?: string,
  status?: string,
): boolean {
  if (result === 'settled' || result === 'done' || result === 'gone') return true
  // Parent observed via rich ack (still a consume of the settle wake).
  if (result === 'acked') return true
  // result === 'blocked' with terminal error phase (parent nudge fires on errored).
  if (phase === 'idle' || phase === 'ended' || phase === 'errored' || phase === 'exited') {
    return true
  }
  if (status === 'exited' || status === 'hibernated') return true
  return false
}
