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
 * `IssueScope` now carries the two §3.1.1/§3.3 members the session-state session
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
import { FIRST_ADMIN_USER_ID } from '../identity/user'
import type { IssueId, SessionId, UserId } from '../ids/brands'

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
  | { kind: 'subtree'; rootId: IssueId }
  /**
   * OWNER-OR-GRANT (POD-380, docs/multi-user-readiness.md §3.1.1 personal class).
   * The principal writes what it OWNS plus what has been explicitly GRANTED to it.
   * `userId` is the principal's identity — for an agent, its delegating human,
   * because §3.1.3 A1 resolves an agent's rights as its scope intersected with its
   * human's CURRENT rights, so the identity a grant is matched against is always
   * the human at the root of the delegation chain.
   */
  | { kind: 'owned'; userId: UserId }
  /**
   * SELF (§3.3 per-user state). The principal writes only rows keyed to its own
   * `userId`. Deliberately NOT a narrow `owned`: per-user state is NON-GRANTABLE
   * by construction (ADR 9 D3 rule 4 — there is no "share my read state" verb), so
   * a grant list must have no way to widen it. Keeping them separate members is
   * what makes that unrepresentable rather than merely unimplemented.
   */
  | { kind: 'self'; userId: UserId }

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
   *  steward can skip nudging the very session that caused them (#116).
   *
   *  BRANDED `SessionId` BY POD-362; decision confirmed by POD-1164. The live
   *  producer is `sessions/lifecycle.ts#capabilityForSession(sessionId)`, whose
   *  argument keys `this.sessions`; every consumer treats it as a podium session
   *  (`command-principal.ts` walks it through `delegations.parentSessionOf`,
   *  `issues/registry.ts` stamps it as `startedBySession`, the `session:`
   *  provenance keys). The transport principal's `agentIdentity` is the SAME
   *  underlying value re-branded as actor (`agentIdentityFromSessionId` at the
   *  binding-store mint); `capabilityFromPrincipal` converts back with
   *  `sessionIdFromAgentIdentity`. They are not two id spaces. */
  actorSessionId?: SessionId
  /** ATTRIBUTION, HUMAN HALF — ADR 3 Amendment 1 D17: every write records an ACTOR
   *  and an ON-BEHALF-OF, both stamped from the authenticated transport and never
   *  read from a payload. `actorSessionId` is the existing actor half for an agent;
   *  `actorUser` is it for a person, and `onBehalfOf` names the human the call is
   *  made FOR (the same person for a human caller, the delegating human for an
   *  agent, and absent — never defaulted — for a machine or a system job).
   *
   *  ONLY `onBehalfOf` IS BRANDED, AND THE ASYMMETRY IS A FINDING (POD-1075).
   *
   *  POD-361 asked for both: they were structural `string` with a comment saying
   *  `UserId` was not reachable at L0, and it is reachable now. Branding
   *  `onBehalfOf` was clean — the on-behalf-of half is ALWAYS a person (ADR 9
   *  D5 A3), so the brand states exactly what the field means, and being
   *  compile-time it changes nothing that parses.
   *
   *  Branding `actorUser` did not compile, and what it caught is a real defect
   *  rather than a typing inconvenience. `gateway/principal-capability.ts`
   *  assigns a `MachineId` to it on the machine arm — under a comment that says
   *  *"a machine is not a person"* — and a bare job string on the system arm. So
   *  `actorUser` is not the person slot its name claims: it is the collapsed
   *  "actor that is not an agent session" slot, holding a person, a machine or a
   *  job. Branding it would have been a well-typed lie at two live sites, and
   *  casting past the error would have laundered the very confusion the brand
   *  exists to expose.
   *
   *  Fixing it properly means splitting the slot by principal kind at the
   *  capability layer, which is POD-388/POD-389 territory and beyond this
   *  issue's model-and-schema scope. The durable shape that already does NOT
   *  collapse them is `fields/attribution.ts`'s `ActorRef` — a discriminated
   *  union over ADR 9 D1's four kinds — and re-pointing this reader at it is the
   *  end state `fields/attribution.ts` names. Reported, not papered over.
   *
   *  The pair is never collapsed into one field: "did a person or an agent do
   *  this?" and "which person was it for?" are two questions ([spec:SP-eb60]
   *  nameSource, humanQuestionAskedBy).
   *
   *  `actorSessionId` above IS branded, and with the right brand: POD-362 typed
   *  it `SessionId` after adjudicating it against its producers. The contrast is
   *  the point — that field had one id space and got the brand naming it; this
   *  one has three and can be given none of them honestly. */
  actorUser?: string
  onBehalfOf?: UserId
}

/** ADR 3 Amendment 1 D17's pair, read off a capability. `null` is a representable
 *  "none" for machine and system callers — never defaulted to an operator or to a
 *  row's owner. */
export interface AttributionPair {
  /** UNBRANDED, and deliberately: this slot collapses `actorSessionId` (an agent
   *  session) and `actorUser` (a person) into one value, so it names two id
   *  spaces and can be branded as neither. `@podium/commands`' handoff contract
   *  records the same thing from the other side — it carries the actor KIND
   *  alongside, precisely because this helper collapses them and "did a person or
   *  an agent move this session?" must stay answerable. The durable shape that
   *  does NOT collapse them is `fields/attribution.ts`'s `ActorRef`. */
  actor: string | null
  /** Branded: the on-behalf-of half is ALWAYS a person (ADR 9 D5 A3). */
  onBehalfOf: UserId | null
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

// `OPERATOR` — the unconstrained admin capability — is GONE from this layer
// (POD-333). Under one shared password it was the answer to "who is calling?",
// and `resolvePrincipal` minted it; once principals became (user, device,
// capability) no production code constructed or read it, and a model-level
// export nothing in the model constructs is a shim. It survives as a TEST
// FIXTURE at apps/server/src/test-support/capabilities.ts, where the reason it
// is dangerous to reach for — `scope: 'all'` short-circuits `authorize()`, which
// is how POD-351 lost a class of revocation coverage — is written down beside
// it. The identity half keeps its own name: `FIRST_ADMIN_USER_ID` (ADR 9 D1.5).

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
  /** Live owner and matching grantees for personal issue authorization. */
  ownedTarget?(id: string, action: IssueAction): Extract<AuthTarget, { kind: 'owned' }> | undefined
}

/** A scope violation: overridable by a caller who says so knowingly (ADR 3 D2's
 *  `--outside-scope` / `overrideScope` confirmation step), else confirm-required. */
function outOfScope(opts?: { override?: boolean }): AuthDecision {
  return opts?.override ? 'allow' : 'confirm-required'
}

/** THE authz decision for a caller — the single enforcement function (invariant 2
 *  of the extension contract above). Distinguishes a hard role denial
 *  ('forbidden') from a scope violation the caller may knowingly override
 *  ('confirm-required'). A write/manage with no `issue` is additive (e.g. create)
 *  and allowed once the role permits it — scope only gates mutations of an
 *  EXISTING issue.
 *
 *  ── READS ARE NO LONGER UNCONDITIONALLY ALLOWED (POD-315, ADR 3 Amendment 1 D19.2)
 *
 *  This function used to open with `if (action === 'read') return 'allow'`. D19.2
 *  names that exact line and calls its removal *"the one place where extending
 *  the closed set is not additive"*, which is why it is called out here rather
 *  than left to be noticed in a diff: the line got shorter and every read path in
 *  the product now runs the scope switch.
 *
 *  WHAT GATES A READ, PRECISELY: **owner and grant scopes** — D19.2's own words,
 *  and the narrowest reading that is also the correct one. A read is decided by
 *  the same ownership rule as a write whenever the capability's scope NAMES A
 *  PERSON (`owned`, `self`). The three scopes that name no person (`all`, `none`,
 *  `subtree`) keep read-allow, each saying so on its own branch.
 *
 *  WHY `subtree` READS STAY ALLOWED, though it is the scope agents actually
 *  carry. A subtree capability is an ISSUE-TREE WRITE scope — the thing
 *  `--outside-scope` confirms crossing (ADR 3 D2) — not a visibility set. Gating
 *  reads by it would deny an agent every sibling issue, which is neither what
 *  A2's narrow default is about (what an agent may CHANGE) nor survivable: ADR 3
 *  Amendment 1 D20.2 requires that an agent may address any issue **its human can
 *  see, including outside its own subtree**, and the single-user parity criterion
 *  requires today's behaviour to be reproduced exactly. Visibility is bounded by
 *  the HUMAN CEILING (`@podium/commands`' `HumanCeiling`), which is a different
 *  question asked of a different fact, and answering it here would be the second
 *  permission check invariant 2 forbids.
 *
 *  WHY THIS IS NOT DEAD CODE, WHICH IS THE REASON D19.2 INSISTS ON IT. Nothing
 *  mints an `owned` or `self` capability SCOPE today (verified: the only
 *  producers of the `owned` shape are `presence-registry.ts` and
 *  `rename-target-path.ts`, and both build owned TARGETS, not scopes). So this
 *  change denies nothing that is currently allowed — its entire value is that
 *  read denial becomes REPRESENTABLE and therefore testable before the transport
 *  can tell two humans apart. Amendment 1's rejected-alternatives table is
 *  explicit that the opposite order — flip the transport first, gate reads later
 *  — leaves "every ownership check dead code on the one transport humans actually
 *  use, so nothing would be tested until the flip".
 *
 *  ALSO REJECTED, BY THE ADR AND NOT BY THIS FILE: keeping reads scope-free and
 *  filtering rows at the projection layer. That means the authority computed a
 *  forbidden row and hoped every projection dropped it (D19, rejected
 *  alternatives).
 *
 *  An ISSUE target under an `owned` scope stays `forbidden` for reads exactly as
 *  it already is for writes: {@link AuthTarget}'s issue arm carries no owner or
 *  grant facts, so ownership is UNDECIDABLE for it, and default-closed (§3.1.1)
 *  means undecidable resolves to refusal. Giving issues an owner is the extension
 *  point — add the facts to that arm, and this branch decides them with the rule
 *  it already has.
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
  const scope = cap.scope
  switch (scope.kind) {
    case 'all':
      return 'allow'
    case 'none':
      if (action === 'read') return 'allow' // no person in this scope — see READS above
      // Additive (no existing target) is a role question, not a scope one.
      return issue ? outOfScope(opts) : 'allow'
    case 'subtree': {
      if (action === 'read') return 'allow' // no person in this scope — see READS above
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
      return issue.kind === 'per-user-row' && issue.userId === scope.userId ? 'allow' : 'forbidden'
    }
    default:
      return assertUnreachable(scope)
  }
}
