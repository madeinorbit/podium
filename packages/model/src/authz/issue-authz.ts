/**
 * Issue-tracker AUTHORIZATION POLICY — what a caller may do with issues.
 *
 * Distinct from AUTHENTICATION (auth-store / auth-route gate *who* may reach /trpc at all,
 * and the daemon secret gates the machine↔server channel). This layer answers *what* a
 * caller who got in may do. Two principals:
 *   - the **operator** — the cookie-authed human on /trpc, plus the trusted in-process MCP —
 *     is unconstrained (OPERATOR);
 *   - **agents** — relayed to the server via their daemon — carry a constrained capability.
 *
 * PURE policy only: role/scope tables and the `authorize` decision. The transport-shaped
 * enforcement (`checkIssueAccess`, which throws TRPCError) stays in apps/server.
 *
 * ── EXTENSION CONTRACT (POD-299, for POD-1075 / POD-1079 / Phase 3) ──────────
 * This file is the one multi-user reaches first (docs/multi-user-readiness.md
 * §3.2). Three invariants make extending it safe, and each is enforced by the
 * compiler rather than by a comment:
 *
 *  1. {@link IssueScope} is a CLOSED SET. Every match on `scope.kind` ends in
 *     `default: assertUnreachable(scope)`, so adding an owner-scoped or
 *     grant-scoped member (§3.2) is a COMPILE ERROR at every site until each is
 *     handled. A silent default here would fail OPEN, which inverts the
 *     default-closed rule of §3.1.1. `issue-authz.test.ts` pins this.
 *  2. {@link authorize} is the SINGLE enforcement function. Widening the
 *     principal to `(user, device, capability)` extends `Capability` and this
 *     function; it never means a second, parallel check somewhere else.
 *  3. {@link Capability.actorSessionId} is the existing seam for the ACTOR half
 *     of §3.1.3 A3's attribution pair (actor + on-behalf-of). It is preserved
 *     verbatim across this move; the on-behalf-of half is POD-1075's to add.
 *
 * Deliberately NOT added here: no `user`/`owner`/`grant` scope members and no
 * new action names. ADR 3 D2 already carries `read`/`write`/`manage` with
 * `machine` as a declared resource scope kind, so §3.1.4 M1's see/use/manage
 * needs an OWNER and a per-machine GRANT LIST, not a new action vocabulary —
 * and how those three verbs map onto the existing actions is POD-1079's call,
 * not this scaffold's.
 */

import { assertUnreachable } from '../exhaustive'

export type IssueRole = 'viewer' | 'worker' | 'admin'

/** What an issue op requires. viewer=read · worker=+write · admin=+manage (operator-only destructive/administrative). */
export type IssueAction = 'read' | 'write' | 'manage'

const ROLE_ACTIONS: Record<IssueRole, IssueAction[]> = {
  viewer: ['read'],
  worker: ['read', 'write'],
  admin: ['read', 'write', 'manage'],
}

/**
 * The slice of issues a capability applies to — a CLOSED SET (see the extension
 * contract above). `all` today; `subtree` is the reserved per-issue extension (an
 * agent bound to one issue tree). `authorize` and the router guard already
 * enforce it, so enabling per-issue scope later is wiring (mint a scoped cap for
 * the agent), not a model change.
 *
 * Gains owner-scoped and grant-scoped members in POD-1075/Phase 3. Add them as
 * discriminated members of THIS union — never by widening `kind` to `string`,
 * which would silently disable every totality check that guards the extension.
 */
export type IssueScope = { kind: 'all' } | { kind: 'none' } | { kind: 'subtree'; rootId: string }

/** Full authz outcome: a hard role denial vs. a scope violation the caller may knowingly override. */
export type AuthDecision = 'allow' | 'forbidden' | 'confirm-required'

export interface Capability {
  role: IssueRole
  scope: IssueScope
  /** The session behind this call, when the caller is an agent (relay path).
   *  Undefined for the operator/web. Threaded onto close/unblock events so the
   *  steward can skip nudging the very session that caused them (#116). */
  actorSessionId?: string
}

/** The human operator (and, for now, the trusted in-process MCP): unconstrained. */
export const OPERATOR: Capability = { role: 'admin', scope: { kind: 'all' } }

// The per-procedure action/target tables (PROC_ACTION / SCOPED_TARGET) are GONE
// (#248 [spec:SP-3fe2]): a command's required action and its target extractor
// are declared ON its definition in the server's command registry
// (apps/server/src/modules/issues/registry.ts), pinned to the canonical name
// list in @podium/protocol — renaming a command moves its authz with it instead
// of silently resetting to 'read' via a string-map miss.

/** The slice of IssueService the access check needs (target existence + subtree walk). */
export interface IssueAccessIndex {
  has(id: string): boolean
  ancestorIds(id: string): string[]
}

/** A scope violation: overridable by a caller who says so knowingly (ADR 3 D2's
 *  `--outside-scope` / `overrideScope` confirmation step), else confirm-required. */
function outOfScope(opts?: { override?: boolean }): AuthDecision {
  return opts?.override ? 'allow' : 'confirm-required'
}

/** THE authz decision for a caller — the single enforcement function (invariant 2
 *  of the extension contract above). Distinguishes a hard role denial
 *  ('forbidden') from a scope violation the caller may knowingly override
 *  ('confirm-required'). Reads are scope-free (read-all). A write/manage with no
 *  `issue` is additive (e.g. create) and allowed once the role permits it — scope
 *  only gates mutations of an EXISTING issue.
 *
 *  The scope match is an EXHAUSTIVE switch: a new `IssueScope` member fails to
 *  compile here until it declares its own rule, rather than inheriting whatever
 *  the last branch happened to return. */
export function authorize(
  cap: Capability,
  action: IssueAction,
  issue?: { id: string; ancestorIds?: string[] },
  opts?: { override?: boolean },
): AuthDecision {
  if (!ROLE_ACTIONS[cap.role].includes(action)) return 'forbidden'
  if (action === 'read') return 'allow'
  const scope = cap.scope
  switch (scope.kind) {
    case 'all':
      return 'allow'
    case 'none':
      // Additive (no existing target) is a role question, not a scope one.
      return issue ? outOfScope(opts) : 'allow'
    case 'subtree': {
      if (!issue) return 'allow'
      const inSubtree =
        issue.id === scope.rootId || (issue.ancestorIds ?? []).includes(scope.rootId)
      return inSubtree ? 'allow' : outOfScope(opts)
    }
    default:
      return assertUnreachable(scope)
  }
}
