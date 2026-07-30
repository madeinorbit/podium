/**
 * THE workflow authorization decision — ADR 9 D5 (A1 live delegation, A2 the
 * human is a ceiling, A4 agent output is owned by its human), ADR 9 D3/D4's
 * default-closed visibility classes, and readiness §3.1.1–§3.1.5.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS REPLACES, AND WHY IT IS ONE FUNCTION
 * ---------------------------------------------------------------------------
 *
 * `apps/server/src/modules/workflows/service.ts` decided authorization at
 * SIXTEEN sites, and eleven of them shared one shape: `if (caller.actor.kind
 * === 'operator') return`. That was sound while OPERATOR was the single shared
 * human declared admin over all. Under multi-user each of those branches makes
 * every authenticated person an admin over every workflow — and the
 * read-shaped ones (`bindings`, `runs`, `runFor`, `profiles`) become cross-user
 * reads of other people's runs, bindings and profiles.
 *
 * So the branch is not narrowed here, it is DELETED and replaced by one
 * decision taken against a real principal. Role class is an input to that
 * decision; it is never the whole of it. `apps/server`'s `WorkflowAccess` is
 * the only caller, which is what keeps "one authz path, not one per command"
 * a structural fact — a new guard has nowhere else to go.
 *
 * ---------------------------------------------------------------------------
 * WHY THE PORTS ARE PORTS
 * ---------------------------------------------------------------------------
 *
 * Ownership, grants and admin role live in the user/grant tables POD-1075 and
 * POD-1079 land. This package is L1 and may not read them. It therefore takes
 * them as a PORT and states today's fact as {@link SINGLE_USER_WORKFLOW_ACCESS}
 * — the same posture `mail/ceiling.ts` took for `HumanCeiling`, deliberately,
 * because two shapes for "the multi-user answer is not here yet" is how a
 * second authz path gets built by accident.
 *
 * A port is NOT a disabled check. It is always consulted, and the single-user
 * implementation is the honest statement that there is exactly one human who
 * owns everything — which is why every single-user behaviour POD-730 pinned as
 * PIN survives unchanged, and every ARTEFACT it pinned changes.
 */

/**
 * A user id as this decision sees it — an opaque string.
 *
 * Deliberately NOT the `UserId` brand: that brand is `@podium/model`'s, it is
 * already imported by this package's protocol dependency, and re-branding here
 * would create a second identity type for the same fact. It is opaque because
 * this module compares ids and never parses them.
 */
export type WorkflowUserRef = string

/**
 * The one human of a single-user instance, named rather than left as `null`.
 *
 * `null` is A1's REVOCATION value and must keep meaning exactly that. Giving
 * the single-user present a real id is what lets `onBehalfOf === null` stay a
 * denial everywhere instead of being special-cased into "no accounts yet, so
 * allow" — the special case being, once more, the shape of the bug.
 */
export const SINGLE_USER_HUMAN: WorkflowUserRef = 'user:single'

/**
 * The five entity classes workflows own, each of which carries its OWN declared
 * visibility class on ADR 1's amended ownership matrix (readiness §3.1.1 rule
 * 2). They are enumerated here rather than inferred from an id prefix because
 * a decision that guesses its subject's class from a string is a decision that
 * fails open on an id shape nobody anticipated.
 *
 * `workflow-library-entry` is the SIXTH member and is not a sixth table: it is
 * a global-scope definition or revision. Its class differs from a personal
 * one's (deployment substrate, not personal) and ADR 9 D4 forbids resolving two
 * different visibility classes from one declaration, so the distinction is made
 * where it is decided rather than where it is stored.
 */
export type WorkflowEntityKind =
  | 'workflow-definition'
  | 'workflow-revision'
  | 'workflow-binding'
  | 'execution-profile'
  | 'workflow-run'
  | 'workflow-library-entry'

export interface WorkflowEntityRef {
  readonly kind: WorkflowEntityKind
  readonly id: string
}

/** ADR 9 D2's personal verbs. Owned-compute's `see`/`use`/`manage` are a
 *  DIFFERENT vocabulary and are decided by `placementDecision` — `use` is a
 *  code-execution boundary and must never be annotated as a personal `read`. */
export type WorkflowVerb = 'read' | 'write'

/**
 * A workflow principal, projected off `@podium/protocol`'s `Principal`.
 *
 * This is a PROJECTION, not a parallel taxonomy: `apps/server` builds it from
 * the transport principal and this module never sees anything the principal
 * does not carry. The two members are exactly ADR 9 D5 A3's pair —
 *
 *   `actor`      — WHICH agent or session performed the act;
 *   `onBehalfOf` — WHICH human it acted for, resolved from the delegation
 *                  record LIVE (A1), never from a payload and never from a
 *                  capability frozen at spawn.
 *
 * `onBehalfOf: null` is the whole of A1's revocation semantics. A long-lived
 * unattended run whose delegating human has been revoked resolves to `null` at
 * its next apply and stops advancing — which is why revocation needs no reaper
 * and why this field may not be memoized across applies.
 */
export interface WorkflowPrincipal {
  readonly actor: string
  readonly onBehalfOf: WorkflowUserRef | null
  /**
   * The account grade of {@link onBehalfOf} (readiness §3.2 / ADR 3 Am.1 D15).
   *
   * A FLOOR on which commands may be ATTEMPTED, never a statement about which
   * rows may be touched. `admin` here is a real account grade; it is NOT the
   * old "operator means not an agent" test, and nothing in this module infers
   * it from the absence of a session id.
   */
  readonly role: 'member' | 'admin'
}

/**
 * Ownership and grants, as a port. Every method is asked at EVERY apply — ADR
 * 9 D5 A1: an agent's effective rights are its own scope intersected with its
 * human's CURRENT rights, resolved live, never a capability snapshot.
 */
export interface WorkflowOwnershipPort {
  /**
   * The owner of a row, or `null` when the row has no owner recorded.
   *
   * `null` FAILS CLOSED (ADR 9 D4): an unowned row is not everyone's, it is
   * nobody's, and only an admin may touch it. That matters concretely here
   * because every workflow row written before ownership columns existed has a
   * null owner, and the permissive reading of those rows is the exact hole this
   * issue closes.
   */
  ownerOf(entity: WorkflowEntityRef): WorkflowUserRef | null
  /** An explicit grant edge (ADR 9 D2). Absence is a denial, never a maybe. */
  hasGrant(user: WorkflowUserRef, entity: WorkflowEntityRef, verb: WorkflowVerb): boolean
}

/** The decision, named. There is no third answer and no reason code: a denial
 *  that explained itself would be the existence oracle §3.1.5 forbids. */
export type WorkflowDecision = 'allowed' | 'denied'

/**
 * THE decision (readiness §3.1.1 / ADR 9 D3–D5).
 *
 * The order is load-bearing and each step is a rule from the pack:
 *
 *  1. NO LIVE HUMAN ⇒ DENIED. A1: rights are the delegation resolved now. This
 *     is first so that a revoked human cannot be rescued by an admin role the
 *     revoked account still nominally carries, nor by owning the row.
 *  2. A LIBRARY ENTRY IS SUBSTRATE. Readiness §3.1.1: a global entry is closer
 *     to deployment substrate than to personal content, so its WRITE path is
 *     admin-grade and ownership is irrelevant to it. Reads are handled by
 *     {@link canReadWorkflowEntity}, which is where substrate's tenant
 *     visibility lives.
 *  3. OWNER WINS. ADR 9 D5 A4 — the row belongs to the human its creator acted
 *     for.
 *  4. AN EXPLICIT GRANT WINS. D2: sharing is explicit and it is an edge.
 *  5. ADMIN WINS. The role floor, applied LAST so it is visibly a fallback and
 *     not the test — which is precisely how `actor.kind === 'operator'` came to
 *     stand in for authorization in the first place.
 *  6. OTHERWISE DENIED. Default-closed (D4): there is no ambient arm, no
 *     "global is fine", and no early return for a role class.
 */
export function workflowDecision(
  principal: WorkflowPrincipal,
  entity: WorkflowEntityRef,
  verb: WorkflowVerb,
  port: WorkflowOwnershipPort,
): WorkflowDecision {
  const human = principal.onBehalfOf
  if (human === null) return 'denied'
  if (entity.kind === 'workflow-library-entry') {
    return principal.role === 'admin' ? 'allowed' : 'denied'
  }
  if (port.ownerOf(entity) === human) return 'allowed'
  if (port.hasGrant(human, entity, verb)) return 'allowed'
  return principal.role === 'admin' ? 'allowed' : 'denied'
}

/**
 * The READ side, which differs from {@link workflowDecision} in exactly one
 * place and only for one class.
 *
 * A global library entry is deployment substrate: its write path is admin-grade
 * (rule 2 above) while its READ may reasonably be tenant-visible, because a
 * library nobody can read is a library nobody can run. That asymmetry is the
 * decision this issue was asked to record rather than to inherit — the shipped
 * code reached the same read outcome through `canReadWorkflow`'s ambient
 * `return true`, which ALSO opened the write path. Splitting them is what
 * closes the hole while keeping the library usable.
 *
 * Every other class routes to the same default-closed decision as a write.
 */
export function canReadWorkflowEntity(
  principal: WorkflowPrincipal,
  entity: WorkflowEntityRef,
  port: WorkflowOwnershipPort,
): boolean {
  if (principal.onBehalfOf === null) return false
  if (entity.kind === 'workflow-library-entry') return true
  return workflowDecision(principal, entity, 'read', port) === 'allowed'
}

/**
 * Ownership as it stands until POD-1075 lands the `User` aggregate and POD-1079
 * the grant model.
 *
 * NOT a disabled check and not a null object callers may omit. It is the honest
 * statement of today's fact: there is exactly one human, they created and
 * therefore own everything, and so `ownerOf` answers with whoever is asking.
 * That is why every PIN in POD-730's oracle survives this migration unchanged —
 * the decision above runs in full and reaches today's answer.
 *
 * WHAT IT DOES NOT DO, and this is the part worth checking: it does not return
 * `true` from `hasGrant`, and it does not make anyone an admin. `role` comes
 * from the principal the transport built, so a session without protected write
 * is a `member` here and IS refused on the substrate path. The single-user
 * present is generous about ownership because one human really does own
 * everything; it is not generous about grade.
 *
 * EXPIRES WHEN: POD-1075 + POD-1079 land, at which point the composition root
 * resolves a real port from the user and grant tables and this constant is
 * DELETED rather than reconfigured. An authorization default that can be
 * widened by configuration is one that can be widened by accident.
 */
export const SINGLE_USER_WORKFLOW_OWNERSHIP: WorkflowOwnershipPort = {
  ownerOf: () => SINGLE_USER_HUMAN,
  hasGrant: () => false,
}
