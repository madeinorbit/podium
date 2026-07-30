/**
 * THE session-target resolver — the one place that decides whether a
 * caller-supplied `sessionId` names something this principal may act on, and
 * the one place that maps "no" onto an answer (ADR 3 Amendment 1 D20, readiness
 * §3.1.5).
 *
 * ---------------------------------------------------------------------------
 * ABSENT AND DENIED ARE NOT THE SAME REFUSAL, AND THE DIFFERENCE IS THE POINT
 * ---------------------------------------------------------------------------
 *
 * D20.2's consistent-error rule says addressing an entity that is INVISIBLE to
 * the principal must fail identically to addressing a nonexistent id, or the
 * command surface becomes an existence oracle. It is easy to over-read that into
 * "every refusal must look like not-found", which would be wrong and would
 * delete a working affordance.
 *
 * The bound is the HUMAN CEILING (D20.2, first clause). An agent may act on
 * anything **its delegating human can see**; its own narrower scope decides
 * whether it needs to CONFIRM, not whether the thing exists. So:
 *
 *  - the human cannot see it, or it does not exist  ⇒ **absent**. One answer,
 *    one message, whichever of the two it was.
 *  - the human can see it, the agent's subtree does not cover it ⇒ **denied**,
 *    with today's actionable `--outside-scope` message. That is a
 *    `confirm-required` outcome (ADR 3 D2), not a privacy boundary, and
 *    flattening it into not-found would tell an agent its sibling issue does not
 *    exist while its own human is looking at it.
 *
 * Today one human sees everything, so the `absent` branch fires only for ids
 * that genuinely do not exist and the observable behaviour is unchanged. The
 * branch is not dead: {@link SessionVisibility} is injectable precisely so the
 * multi-user answer is exercised before POD-1075 supplies the real one.
 */

import type { Capability, SessionMeta } from '@podium/model'
import type { CommandPrincipal } from '../../command-principal'
import { checkIssueAccess, type IssueAccessIndex } from '../../issue-authz'

/**
 * The live-session facts this resolver needs — a PICK of the model's own
 * `SessionMeta`, not a restatement of four of its keys.
 *
 * Writing the four field types out again would typecheck, encode identically and
 * be a second declaration of the session vocabulary; `scripts/rearch-audit.ts`
 * counts that as debt and counted this before it was a Pick. The narrowing is
 * still real — this module must not reach for a field it has not asked for.
 */
export type SessionTargetRow = Pick<SessionMeta, 'sessionId' | 'cwd' | 'issueId' | 'spawnedBy'>

/**
 * Is this session visible to the principal's delegating HUMAN?
 *
 * POD-1075 supplies the owner/grant answer. The default is today's truth — one
 * account, everything visible — stated as a function rather than assumed, so
 * that turning it on is a policy change and not a second migration.
 */
export type SessionVisibility = (
  principal: CommandPrincipal,
  session: SessionTargetRow,
) => boolean

export const everythingVisible: SessionVisibility = () => true

export interface SessionAccessDeps {
  /** Live sessions, as the wire lists them. */
  listSessions(): SessionTargetRow[]
  /** Issue index for the subtree gate, and cwd → issue derivation. */
  /** `issueForCwd` is `string | null` on IssueService and `undefined` on the
   *  narrow test fixtures; both spellings mean "no issue owns this cwd". */
  issues: IssueAccessIndex & { issueForCwd(cwd: string): string | null | undefined }
  visibility?: SessionVisibility
}

export type SessionTarget =
  | { kind: 'visible'; session: SessionTargetRow }
  /** Nonexistent, or invisible to the delegating human — deliberately one case. */
  | { kind: 'absent' }

/** The message every absent target produces, on every command. */
export const SESSION_NOT_FOUND = 'session not found'

/** Resolve a caller-supplied session id. Never throws; the caller decides shape. */
export function resolveSessionTarget(
  principal: CommandPrincipal,
  sessionId: string,
  deps: SessionAccessDeps,
): SessionTarget {
  const session = deps.listSessions().find((candidate) => candidate.sessionId === sessionId)
  if (!session) return { kind: 'absent' }
  const visible = (deps.visibility ?? everythingVisible)(principal, session)
  return visible ? { kind: 'visible', session } : { kind: 'absent' }
}

/**
 * The ROW gate for a target the principal may see: does this principal's own
 * scope cover it, or must it confirm?
 *
 * This is today's relay logic, moved rather than rewritten — the issue-scoped
 * branch is `checkIssueAccess` verbatim, and the issueless branch keeps the
 * operator/parent rule from [spec:SP-34d7 authz] with its exact message. A human
 * principal on the operator channel has scope `all` and passes both, which is
 * why the tRPC surface behaves as it always has.
 *
 * Throws (TRPCError or Error) exactly as the shipped paths do.
 */
export function assertMayCommandSession(
  principal: CommandPrincipal,
  session: SessionTargetRow,
  proc: string,
  deps: SessionAccessDeps,
  overrideScope?: boolean,
): void {
  if (principal.kind === 'system') return
  const capability: Capability = principal.capability
  const targetIssueId = session.issueId ?? deps.issues.issueForCwd(session.cwd)
  if (targetIssueId) {
    checkIssueAccess(
      { capability, ...(overrideScope ? { overrideScope: true } : {}) },
      deps.issues,
      proc,
      'write',
      targetIssueId,
    )
    return
  }
  // Issueless target: no issue to gate on used to mean NO gate at all. Only the
  // operator (unscoped capability) or the target's own parent (spawnedBy
  // provenance) may command it; --outside-scope confirms scope-crossing on ISSUE
  // targets and never substitutes here.
  const isOperator = capability.scope.kind === 'all'
  const isParent =
    capability.actorSessionId !== undefined &&
    session.spawnedBy === `session:${capability.actorSessionId}`
  if (!isOperator && !isParent) {
    throw new Error('target session has no issue; only its parent or the operator may message it')
  }
}
