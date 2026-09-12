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

import type { Capability, SessionId, SessionMeta, UserId } from '@podium/model'
import { isSpawnedBy } from '@podium/model'
import type { CommandPrincipal } from '../../command-principal'
import { checkIssueAccess, type IssueAccessIndex } from '../../issue-authz'

/**
 * The live-session facts this resolver needs — a PICK of the model's own
 * `SessionMeta`, not a restatement of a handful of its keys.
 *
 * Writing those field types out again would typecheck, encode identically and
 * be a second declaration of the session vocabulary; `scripts/rearch-audit.ts`
 * counts that as debt and counted this before it was a Pick. The narrowing is
 * still real — this module must not reach for a field it has not asked for.
 */
export type SessionTargetRow = Pick<
  SessionMeta,
  'sessionId' | 'cwd' | 'issueId' | 'spawnedBy' | 'status' | 'archived' | 'agentKind' | 'resumable'
>

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
) => boolean | Promise<boolean>

/**
 * The pre-multi-user answer: everything is visible. STILL THE DEFAULT for
 * fixtures that are not about visibility, and no longer what production uses —
 * see {@link sessionOwnerVisibility}.
 */
export const everythingVisible: SessionVisibility = () => true

/**
 * THE OWNER ANSWER POD-1075 PROMISED, supplied by B1 (PDM-133).
 *
 * A session is visible to the principal's DELEGATING HUMAN and to nobody else.
 * That is the human ceiling this module's header describes, now actually
 * enforced: an agent may act on what its human can see, and its own narrower
 * scope decides only whether it must CONFIRM (the `assertMayCommandSession`
 * layer below), never whether the session exists.
 *
 * WHY THE OWNER ARRIVES AS A PORT rather than off `SessionTargetRow`. The row is
 * a `Pick` of `SessionMeta`, and `SessionMeta` deliberately has no owner field —
 * ownership is not on the wire. So the lookup is injected, and it is the SAME
 * `sessionOwner` every other session authorization path already consults, which
 * is what keeps this from becoming a second ownership opinion.
 *
 * A SYSTEM PRINCIPAL SEES EVERYTHING, and has to: the janitor, the reconciler
 * and the outbox drain are not people and have no human ceiling to apply. They
 * are already unauthenticated-by-construction rather than authenticated-as-
 * somebody, so this is where that fact is stated rather than a hole opened.
 *
 * AN UNRESOLVABLE OWNER IS NOT VISIBLE. Same rule the control plane applies at
 * `authorizeAttach`: a session whose owner cannot be resolved is indistinguish-
 * able from one that does not exist, and both answer `absent`.
 */
export function sessionOwnerVisibility(
  ownerOf: (sessionId: SessionId) => Promise<{ owner: UserId } | undefined>,
): SessionVisibility {
  return async (principal, session) => {
    if (principal.kind === 'system') return true
    const human = principal.kind === 'user' ? principal.user : principal.onBehalfOf
    if (!human) return false
    const ownership = await ownerOf(session.sessionId)
    return ownership?.owner === human
  }
}

/**
 * MAY THIS PRINCIPAL READ WHAT A SESSION PRIVATELY HOLDS? (POD-3900)
 *
 * The question `sessionOwnerVisibility` above answers, plus the two carve-outs a
 * reader of it has to be told about explicitly rather than deduce.
 *
 * WHY THIS IS NOT JUST THE VISIBILITY PREDICATE. ADR 9 Amendment 1 D7/D13 bound
 * a session's private contents — its transcript, its repo state, the files it
 * touched — to the human who started it. That is the predicate's rule and it is
 * unchanged here; the owner comparison still happens in exactly one place. What
 * this adds is the two cases where the CALLER, not the delegating human, is the
 * authority:
 *
 *  - SELF. A session reads itself. It cannot be made to depend on ownership,
 *    because a session's own durable owner and the human at the root of its
 *    delegation chain are not guaranteed to be the same person — see the next
 *    case for why.
 *  - THE PARENT OF A SPAWNED SESSION. `messages/handlers/spawn-agent.ts` stamps
 *    a new session's `ownerUserId` from the ISSUE's owner, not from the human
 *    who spawned it, so an agent working someone else's task spawns children
 *    owned by that someone else. Dropping this arm would stop a parent reading
 *    the child it created, which is a control the accepted architecture keeps.
 *    (That producer reading ownership through the issue is itself worth a look —
 *    `SessionAuthz#sessionOwner`'s header says authority is the durable row and
 *    not a lookup through the task — but it is a producer question, and this is
 *    the reader.)
 *
 * Provenance, not a claim: `spawnedBy` is stamped by the server at spawn and is
 * never read from agent input, which is what makes the parent arm safe to state
 * as an identity rule.
 */
export async function mayReadPrivateSession(
  principal: CommandPrincipal,
  session: SessionTargetRow,
  ownerOf: (sessionId: SessionId) => Promise<{ owner: UserId } | undefined>,
): Promise<boolean> {
  if (principal.kind === 'agent') {
    if (principal.agentSessionId === session.sessionId) return true
    if (isSpawnedBy(session.spawnedBy, { kind: 'session', id: principal.agentSessionId })) {
      return true
    }
  }
  return await sessionOwnerVisibility(ownerOf)(principal, session)
}

export interface SessionAccessDeps {
  /** ONE session by id, without the full reader-scoped pass [POD-1646].
   *  REQUIRED since POD-3857. This resolver runs on the authorization path of
   *  essentially every command; the full-list port it used to fall back to made
   *  a by-id lookup cost a whole reader-scoped pass, and it is gone. */
  sessionById(
    sessionId: SessionId,
  ): Promise<SessionTargetRow | undefined>
  /** Issue index for the subtree gate, and cwd → issue derivation. */
  /** `issueForCwd` is `string | null` on IssueService and `undefined` on the
   *  narrow test fixtures; both spellings mean "no issue owns this cwd". */
  issues: IssueAccessIndex & {
    issueForCwd(cwd: string): Promise<string | null | undefined>
  }
  visibility?: SessionVisibility
}

/** Lift the synchronous issue index at the composition boundary. */
export function asyncSessionIssueAccess(
  issues: IssueAccessIndex & { issueForCwd(cwd: string): string | null | undefined },
): SessionAccessDeps['issues'] {
  return {
    has: (id) => issues.has(id),
    ancestorIds: (id) => issues.ancestorIds(id),
    ...(issues.ownedTarget ? { ownedTarget: issues.ownedTarget.bind(issues) } : {}),
    issueForCwd: async (cwd) => issues.issueForCwd(cwd),
  }
}

export type SessionTarget =
  | { kind: 'visible'; session: SessionTargetRow }
  /** Nonexistent, or invisible to the delegating human — deliberately one case. */
  | { kind: 'absent' }

/** The message every absent target produces, on every command. */
export const SESSION_NOT_FOUND = 'session not found'

/** Resolve a caller-supplied session id. Never throws; the caller decides shape. */
export async function resolveSessionTarget(
  principal: CommandPrincipal,
  sessionId: SessionId,
  deps: SessionAccessDeps,
): Promise<SessionTarget> {
  const session = await deps.sessionById(sessionId)
  if (!session) return { kind: 'absent' }
  const visible = await (deps.visibility ?? everythingVisible)(principal, session)
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
export async function assertMayCommandSession(
  principal: CommandPrincipal,
  session: SessionTargetRow,
  proc: string,
  deps: SessionAccessDeps,
  overrideScope?: boolean,
): Promise<void> {
  if (principal.kind === 'system') return
  const capability: Capability = principal.capability
  const targetIssueId = session.issueId ?? await deps.issues.issueForCwd(session.cwd)
  if (targetIssueId) {
    await checkIssueAccess(
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
    isSpawnedBy(session.spawnedBy, { kind: 'session', id: capability.actorSessionId })
  if (!isOperator && !isParent) {
    throw new Error('target session has no issue; only its parent or the operator may message it')
  }
}
