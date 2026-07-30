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
 * ── EXTENDED (POD-380) ──────────────────────────────────────────────────────
 * `IssueScope` now carries the two §3.1.1/§3.3 members the presence-class session
 * writes need — `owned` (owner-or-grant) and `self` (per-user state) — and
 * {@link authorize}'s target widened to {@link AuthTarget} so one function decides
 * for issues, owned entities and per-user rows. This follows invariant 2
 * literally: the extension is THIS function, not a second check beside it.
 *
 * Still NOT added: no new ACTION names. ADR 3 D2 already carries
 * `read`/`write`/`manage` with `machine` as a declared resource scope kind, so
 * §3.1.4 M1's see/use/manage needs an OWNER and a per-machine GRANT LIST, not a
 * new action vocabulary — and how those three verbs map onto the existing actions
 * is POD-1079's call, not this scaffold's.
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
export type IssueScope =
  | { kind: 'all' }
  | { kind: 'none' }
  | { kind: 'subtree'; rootId: string }
  /**
   * OWNER-OR-GRANT (POD-380, docs/multi-user-readiness.md §3.1.1 personal class).
   * The principal writes what it OWNS plus what has been explicitly GRANTED to it.
   * `userId` is the principal's identity — for an agent, its delegating human,
   * because §3.1.3 A1 resolves an agent's rights as its scope intersected with its
   * human's CURRENT rights, so the identity a grant is matched against is always
   * the human at the root of the delegation chain.
   */
  | { kind: 'owned'; userId: string }
  /**
   * SELF (§3.3 per-user state). The principal writes only rows keyed to its own
   * `userId`. Deliberately NOT a narrow `owned`: per-user state is NON-GRANTABLE
   * by construction (ADR 9 D3 rule 4 — there is no "share my read state" verb), so
   * a grant list must have no way to widen it. Keeping them separate members is
   * what makes that unrepresentable rather than merely unimplemented.
   */
  | { kind: 'self'; userId: string }

/**
 * What a decision is ABOUT. `kind` is optional so the ~4 shipped call sites that
 * pass a bare `{ id, ancestorIds }` keep meaning "an issue" — the legacy shape is
 * the `issue` member with its tag elided, not a new permissive default.
 *
 * The two new members carry the facts the new scopes need. They are read from the
 * STORE by the caller, never from a payload (ADR 3 D7).
 */
export type AuthTarget =
  | { kind?: 'issue'; id: string; ancestorIds?: string[] }
  /** An owned entity (a session, here): its owner and the grants on it. */
  | {
      kind: 'owned'
      id: string
      /** `null` = unowned. An unowned entity is NOT ambient: see {@link authorize}. */
      owner: string | null
      /** User ids explicitly granted write on this entity. */
      grants?: readonly string[]
    }
  /** One row of the per-user state family, identified by whose row it is. */
  | { kind: 'per-user-row'; userId: string }

/** Full authz outcome: a hard role denial vs. a scope violation the caller may knowingly override. */
export type AuthDecision = 'allow' | 'forbidden' | 'confirm-required'

export interface Capability {
  role: IssueRole
  scope: IssueScope
  /** The session behind this call, when the caller is an agent (relay path).
   *  Undefined for the operator/web. Threaded onto close/unblock events so the
   *  steward can skip nudging the very session that caused them (#116). */
  actorSessionId?: string
  /** ATTRIBUTION, HUMAN HALF — ADR 3 Amendment 1 D17: every write records an ACTOR
   *  and an ON-BEHALF-OF, both stamped from the authenticated transport and never
   *  read from a payload. `actorSessionId` is the existing actor half for an agent;
   *  `actorUser` is it for a person, and `onBehalfOf` names the human the call is
   *  made FOR (the same person for a human caller, the delegating human for an
   *  agent, and absent — never defaulted — for a machine or a system job).
   *
   *  Structural `string` on purpose: model is the zero-dependency L0 leaf, so the
   *  branded `UserId` these carry lives in @podium/protocol's principal module
   *  today and lands here with POD-1075. The pair is never collapsed into one
   *  field: "did a person or an agent do this?" and "which person was it for?" are
   *  two questions ([spec:SP-eb60] nameSource, humanQuestionAskedBy). */
  actorUser?: string
  onBehalfOf?: string
}

/** ADR 3 Amendment 1 D17's pair, read off a capability. `null` is a representable
 *  "none" for machine and system callers — never defaulted to an operator or to a
 *  row's owner. */
export interface AttributionPair {
  actor: string | null
  onBehalfOf: string | null
}

/** Named `capabilityAttribution`, not `attributionOf`: @podium/protocol's principal
 *  module already exports `attributionOf` for the PRINCIPAL side of the same pair,
 *  and two same-named exports for the two sides is the redefinition the
 *  model-single-home boundary rule exists to stop. */
export function capabilityAttribution(cap: Capability): AttributionPair {
  return {
    actor: cap.actorSessionId ?? cap.actorUser ?? null,
    onBehalfOf: cap.onBehalfOf ?? null,
  }
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
  issue?: AuthTarget,
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
      // A subtree capability is an ISSUE-tree capability. Handing it an owned
      // entity or a per-user row is not a scope violation to be overridden — it is
      // a category error, and answering 'confirm-required' would let
      // `--outside-scope` convert it into an allow. Forbidden, without an override.
      if (issue.kind === 'owned' || issue.kind === 'per-user-row') return 'forbidden'
      const inSubtree =
        issue.id === scope.rootId || (issue.ancestorIds ?? []).includes(scope.rootId)
      return inSubtree ? 'allow' : outOfScope(opts)
    }
    case 'owned': {
      if (!issue) return 'allow' // additive: creating what you will own
      switch (issue.kind) {
        case 'owned':
          // An UNOWNED entity is not ambient (§3.1.1 default-closed, and §3.1.4 M4's
          // all-in-one case): absent ownership fails toward refusal. It is also NOT
          // overridable — `--outside-scope` confirms crossing an ISSUE boundary
          // (ADR 3 D2), and reusing it here would make it a general escalation.
          if (issue.owner === null) return 'forbidden'
          return issue.owner === scope.userId || (issue.grants ?? []).includes(scope.userId)
            ? 'allow'
            : 'forbidden'
        case 'per-user-row':
          // §3.3: an owner-or-grant capability does not reach anybody's per-user
          // rows, including its own — a per-user write needs a `self` scope, so
          // this cannot silently become "the owner may set your readAt".
          return 'forbidden'
        default:
          // An ISSUE target under an owned scope: this capability says nothing
          // about issue trees, so it grants nothing over one.
          return 'forbidden'
      }
    }
    case 'self': {
      if (!issue) return 'allow'
      // The ONE thing a self scope may write: its own row. Not another user's row,
      // and not a shared entity — a `self` principal that could rename a session
      // would be an owner-or-grant capability wearing the wrong name.
      return issue.kind === 'per-user-row' && issue.userId === scope.userId
        ? 'allow'
        : 'forbidden'
    }
    default:
      return assertUnreachable(scope)
  }
}
