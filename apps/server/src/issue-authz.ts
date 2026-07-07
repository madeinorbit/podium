/**
 * Issue-tracker authorization — server enforcement over the PURE policy in
 * @podium/domain (roles/scopes/`authorize`, PROC_ACTION, SCOPED_TARGET all live
 * there; re-exported here for the server's existing import sites). This module
 * keeps only the transport-shaped gate: `checkIssueAccess` throws TRPCError.
 */

import { authorize, type Capability, type IssueAccessIndex, type IssueAction } from '@podium/domain'
import { TRPCError } from '@trpc/server'

export {
  type AuthDecision,
  authorize,
  type Capability,
  type IssueAccessIndex,
  type IssueAction,
  type IssueRole,
  type IssueScope,
  OPERATOR,
  PROC_ACTION,
  SCOPED_TARGET,
} from '@podium/domain'

/**
 * THE issue-access gate (issue #25): one decision + one throw-shape for every
 * entry point. Used by the router's issueCapabilityGuard middleware AND by
 * in-proc gates whose target can't be extracted from the raw input (mailClaim
 * resolves message→issue first) — previously those duplicated this check
 * verbatim, and the copies could drift.
 *
 * Semantics (all pinned by characterization contract 6):
 *   - role gate: a role that can't perform `action` at all ⇒ FORBIDDEN;
 *   - scope gate: a constrained (non-'all') capability writing an EXISTING
 *     target issue outside its subtree ⇒ PRECONDITION_FAILED (overridable via
 *     `overrideScope` / --outside-scope), a scope kind that never allows it ⇒
 *     FORBIDDEN;
 *   - no target / unknown target (e.g. hub-mirrored issues, additive procs) ⇒
 *     role gate only.
 */
export function checkIssueAccess(
  caller: { capability: Capability; overrideScope?: boolean },
  issues: IssueAccessIndex,
  proc: string,
  action: IssueAction,
  targetId?: string,
): void {
  // Role gate (no input needed): authorize with no issue = role decision.
  if (authorize(caller.capability, action) === 'forbidden') {
    throw new TRPCError({ code: 'FORBIDDEN', message: `not allowed to '${proc}' issues` })
  }
  // Scope gate: only for constrained caps writing an existing target issue.
  if (caller.capability.scope.kind === 'all') return
  if (!targetId || !issues.get(targetId)) return
  const decision = authorize(
    caller.capability,
    action,
    { id: targetId, ancestorIds: issues.ancestorIds(targetId) },
    { override: caller.overrideScope },
  )
  if (decision === 'confirm-required') {
    throw new TRPCError({
      code: 'PRECONDITION_FAILED',
      message: `issue ${targetId} is outside your subtree; re-run with --outside-scope to confirm`,
    })
  }
  if (decision === 'forbidden') {
    throw new TRPCError({ code: 'FORBIDDEN', message: `not allowed to '${proc}' issues` })
  }
}
