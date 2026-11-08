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
 * Sessions are private (design §2.3, POD-6283): the human ceiling for a session
 * is its own owner, so a session another person owns is `absent`, admin or not,
 * and whatever task it sits on. On a one-member instance every session is that
 * member's, and the `absent` branch fires only for ids that do not exist.
 * {@link SessionVisibility} remains an extra, narrowing filter.
 */

import type { IssueTrackerCapabilities } from '../issues/service'
import type { Capability, SessionId, SessionMeta, UserId } from '@podium/model'
import { isSpawnedBy } from '@podium/model'
import { type CommandPrincipal, onBehalfOfUser } from '../../command-principal'
import { checkIssueAccess, type IssueAccessIndex, mayReachPrivate } from '../../issue-authz'

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

export const everythingVisible: SessionVisibility = () => true

/**
 * SESSIONS ARE PRIVATE (design §2.3, POD-6283). Only the session's own human
 * reaches it: the person for a direct call, the delegating human for an agent.
 * Everyone else, the task's owner and admins included, gets `absent`, the same
 * answer as an id that does not exist. A system job has no human and is not
 * narrowed here.
 */
async function ownerReaches(
  principal: CommandPrincipal,
  session: SessionTargetRow,
  deps: Pick<SessionAccessDeps, 'ownerOf'>,
): Promise<boolean> {
  if (principal.kind === 'system') return true
  return mayReachPrivate(onBehalfOfUser(principal), {
    id: session.sessionId,
    owner: await deps.ownerOf(session.sessionId),
  })
}

export interface SessionAccessDeps {
  /** The session's own durable owner (`SessionAuthz.sessionOwner`). REQUIRED:
   *  it is the private-class gate, and an optional authorization port is one
   *  refactor away from an unwired one. */
  ownerOf(sessionId: SessionId): Promise<UserId | null | undefined>
  /** ONE session by id, without the full reader-scoped pass [POD-1646].
   *  REQUIRED since POD-3857. This resolver runs on the authorization path of
   *  essentially every command; the full-list port it used to fall back to made
   *  a by-id lookup cost a whole reader-scoped pass, and it is gone. */
  sessionById(
    sessionId: SessionId,
  ): Promise<SessionTargetRow | undefined>
  /** The live session ids that start with `prefix`, for unambiguous prefix
   *  resolution only. OPTIONAL so narrow fixtures that never exercise a prefix
   *  keep working. Production answers it with a range read on the primary key
   *  (POD-6160) — ids only, never the full reader-scoped projection POD-3857
   *  deleted. It is consulted ONLY after the exact-match fast path misses, so a
   *  full uuid never pays for it. */
  sessionIdsWithPrefix?: (prefix: string) => Promise<readonly SessionId[]> | readonly SessionId[]
  /** Issue index for the subtree gate, and cwd → issue derivation. */
  /** `issueForCwd` is `string | null` on IssueService and `undefined` on the
   *  narrow test fixtures; both spellings mean "no issue owns this cwd". */
  issues: IssueAccessIndex & {
    issueForCwd(cwd: string): Promise<string | null | undefined>
  }
  visibility?: SessionVisibility
}

/** Lift the owned issue read capabilities at the composition boundary. */
export function asyncSessionIssueAccess(
  issues: Pick<IssueTrackerCapabilities, 'reports' | 'hierarchy'>,
): SessionAccessDeps['issues'] {
  const { reports, hierarchy } = issues
  return {
    has: (id) => reports.has(id),
    ancestorIds: (id) => hierarchy.ancestorIds(id),
    issueForCwd: async (cwd) => await reports.issueForCwd(cwd),
  }
}

export type SessionTarget =
  | { kind: 'visible'; session: SessionTargetRow }
  /** Nonexistent, or invisible to the delegating human — deliberately one case. */
  | { kind: 'absent' }
  /** A prefix naming more than one VISIBLE session — never silently picked. */
  | { kind: 'ambiguous'; prefix: string; candidates: SessionId[] }

/** The message every absent target produces, on every command. */
export const SESSION_NOT_FOUND = 'session not found'

/** The message an ambiguous prefix produces — names the candidates, so it can
 *  never be mistaken for "the session is gone". Sorted for determinism. */
export function ambiguousSessionPrefixMessage(prefix: string, candidates: readonly SessionId[]): string {
  const sorted = [...candidates].sort()
  return `ambiguous session id prefix '${prefix}' matches ${sorted.length} sessions: ${sorted.join(', ')}`
}

/** Resolve a caller-supplied session id. Never throws; the caller decides shape.
 *
 *  Exact match first (fast path, no scan). On a miss, an unambiguous id PREFIX
 *  resolves when exactly one VISIBLE session starts with it. Invisible matches
 *  are dropped before counting, so a hidden session neither resolves nor makes
 *  a visible one ambiguous — both would be an existence oracle. */
export async function resolveSessionTarget(
  principal: CommandPrincipal,
  sessionId: SessionId,
  deps: SessionAccessDeps,
): Promise<SessionTarget> {
  const reaches = async (row: SessionTargetRow) =>
    (await ownerReaches(principal, row, deps)) &&
    (await (deps.visibility ?? everythingVisible)(principal, row))
  const session = await deps.sessionById(sessionId)
  if (session) {
    return (await reaches(session)) ? { kind: 'visible', session } : { kind: 'absent' }
  }
  if (!sessionId || !deps.sessionIdsWithPrefix) return { kind: 'absent' }
  const prefixed = (await deps.sessionIdsWithPrefix(sessionId)).filter((id) => id.startsWith(sessionId))
  if (prefixed.length === 0) return { kind: 'absent' }
  const visibleRows: SessionTargetRow[] = []
  const visibleIds: SessionId[] = []
  for (const id of prefixed) {
    const row = await deps.sessionById(id)
    if (!row) continue
    if (await reaches(row)) {
      visibleRows.push(row)
      visibleIds.push(id)
    }
  }
  if (visibleRows.length === 0) return { kind: 'absent' }
  if (visibleRows.length === 1) return { kind: 'visible', session: visibleRows[0] as SessionTargetRow }
  return { kind: 'ambiguous', prefix: sessionId, candidates: [...visibleIds].sort() }
}

/**
 * The ROW gate for a target the principal may see: does this principal's own
 * scope cover it, or must it confirm?
 *
 * This is today's relay logic, moved rather than rewritten — the issue-scoped
 * branch is `checkIssueAccess` verbatim, and the issueless branch keeps the
 * parent rule from [spec:SP-34d7 authz] with its exact message. Both apply to
 * agents only: a person reaching their own session (the owner gate) may command
 * it, and nobody else's, admin or not (design §2.3).
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
  // The private-class gate again, for a caller that did not resolve the target
  // through `resolveSessionTarget`: one answer, whichever door was used.
  if (!(await ownerReaches(principal, session, deps))) throw new Error(SESSION_NOT_FOUND)
  // A person driving their own session needs nothing more: not write access to
  // the task it sits on (Bob drives his session on Alice's task), and no scope.
  if (principal.kind === 'user') return
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
  // Issueless targets stay private to their human (checked above). An agent
  // may command one as its parent, or confirm a stop with human permission
  // [spec:SP-9904]; an unscoped capability alone never grants private access.
  const isParent =
    capability.actorSessionId !== undefined &&
    isSpawnedBy(session.spawnedBy, { kind: 'session', id: capability.actorSessionId })
  const confirmedStop = overrideScope === true && proc === 'sessions.stop'
  if (!isParent && !confirmedStop) {
    throw new Error('target session has no issue; only its parent or the operator may message it')
  }
}
