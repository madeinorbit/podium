/**
 * Issue-tracker authorization — server enforcement over the PURE policy in
 * @podium/model (roles/scopes/`authorize` live there; re-exported here for the
 * server's existing import sites). Per-command action/target declarations live
 * ON the command registry definitions (modules/issues/registry.ts, #248). This
 * module keeps only the transport-shaped gate: `checkIssueAccess` throws
 * TRPCError.
 */

import {
  asUserId,
  authorize,
  type Capability,
  type IssueAccessIndex,
  type IssueAction,
} from '@podium/model'
import { TRPCError } from '@trpc/server'

export {
  type AuthDecision,
  authorize,
  type Capability,
  type IssueAccessIndex,
  type IssueAction,
  type IssueRole,
  type IssueScope,
} from '@podium/model'

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
  if (!targetId || !issues.has(targetId)) return
  if (caller.capability.scope.kind === 'owned') {
    const target = issues.ownedTarget?.(targetId, action)
    if (!target || authorize(caller.capability, action, target) === 'forbidden') {
      throw new TRPCError({ code: 'NOT_FOUND', message: 'unknown issue ' + targetId })
    }
    return
  }
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

/**
 * OWNER-OR-GRANT READ, decided by the model (POD-335).
 *
 * The ONE server-side entry point for "may this person read this owned entity".
 * It exists because two modules had grown their own answer to that question —
 * `modules/sessions/queries.ts` and `modules/memory/visibility.ts` — and
 * docs/multi-user-readiness.md §3.2 is explicit that owner/grant scopes are to
 * be added to the closed `IssueScope` set *"rather than inventing a parallel
 * check"*. `authz-single-home` in the architecture manifest now fails the build
 * on the parallel form; this is what it points people at.
 *
 * The duplicates were not merely untidy. Both spelled the rule as
 * `owner === userId || grants.includes(userId)` over a possibly-ABSENT owner, so
 * an unowned row plus an unauthenticated reader compared `undefined ===
 * undefined` and read as ALLOW. `authorize` refuses an unowned entity outright
 * (§3.1.1 default-closed; §3.1.4 M4's all-in-one case), and refuses it without
 * an override, so routing through it fixes an ambient-access hole in the same
 * move that removes the copy.
 *
 * `viewer` is the narrowest role that admits `read`, so the decision here is
 * governed entirely by ownership and grants — the role gate contributes nothing
 * it could accidentally widen.
 */
export function mayReadOwned(
  userId: string | undefined,
  entity: { id: string; owner: string | null | undefined; grants?: readonly string[] },
): boolean {
  if (userId === undefined) return false
  return (
    authorize({ role: 'viewer', scope: { kind: 'owned', userId: asUserId(userId) } }, 'read', {
      kind: 'owned',
      id: entity.id,
      owner: entity.owner ?? null,
      grants: entity.grants,
    }) === 'allow'
  )
}
