/**
 * THE human ceiling, and the consistent-error rule that keeps it from becoming
 * an existence oracle — ADR 3 Amendment 1 D20, readiness §3.1.5.
 *
 * The bound on addressing is the DELEGATING HUMAN's rights, not the agent's own
 * scope. An agent may address any issue or session its human can see — including
 * outside its own subtree, through the existing `overrideScope` confirmation
 * path — and may never address one its human cannot see.
 *
 * Note the two boundaries are different and must not be collapsed:
 *
 *  - OUTSIDE THE AGENT'S SUBTREE, INSIDE THE HUMAN'S VISIBILITY — a deliberate
 *    widening. It answers `confirm-required` (`--outside-scope`), which is
 *    ADR 3 D2's shipped shape and is not a denial. It may name the target,
 *    because the human can already see it: nothing is leaked.
 *  - BEYOND THE HUMAN CEILING — a denial, and it must be INDISTINGUISHABLE from
 *    addressing an id that does not exist (D20.2). Same code, same message, same
 *    timing class.
 *
 * The convergence point chosen here is the UNRESOLVABLE-REF branch that already
 * exists: an unknown ref resolves to nothing, the send is accepted, and it
 * dead-letters at delivery with a notice back to its sender. Beyond-ceiling ids
 * take that same branch. This is behaviour-preserving for the unknown-id case
 * that POD-727 pinned (no test edit) and it satisfies D20 by construction rather
 * than by two error strings being kept in sync by hand.
 *
 * Why converge toward "accepted, then dead-lettered" rather than toward a
 * uniform up-front error: the sender still learns its message went nowhere (the
 * dead-letter notice is not a silent drop, ADR 3 D9), but it learns it on the
 * DELIVERY path, where the answer is identical for "no such issue" and "not
 * yours" and carries no id. Converging the other way would have required the
 * up-front error to withhold the target id, which is the same information
 * withheld one step earlier at the cost of changing the pinned unknown-id
 * behaviour.
 */

/**
 * The live visibility question, asked at every apply (readiness §3.1.3 A1 —
 * never a capability snapshot frozen at spawn).
 *
 * Deliberately a bare boolean: refusal and nonexistence must be
 * indistinguishable to the caller, so there is no reason code to leak. This is
 * the same shape as `VisibilityResolver` in `@podium/protocol`, narrowed to the
 * two entity kinds mail can address, and it is a PORT — the answer comes from
 * the user/grant tables (POD-1075 / POD-1079), never from this package.
 */
export interface HumanCeiling {
  canSee(entity: { readonly kind: 'issue' | 'session'; readonly id: string }): boolean
}

/**
 * The ceiling as it stands until user accounts land (POD-1075).
 *
 * NOT a disabled check and not a null object that callers may omit: the ceiling
 * is always consulted, and this implementation is the honest statement of
 * today's fact — there is exactly one human and they can see everything, so the
 * ceiling is at its maximum. That is why every send in the single-user present
 * behaves exactly as it does today (D20.2's "behaviour-preserving by
 * construction" clause).
 *
 * EXPIRES WHEN: POD-1075 lands the `User` aggregate and POD-1079 the grant
 * model. At that point the composition root resolves a real ceiling from the
 * delegation chain's root user, and this constant is deleted rather than
 * reconfigured — a ceiling that can be widened by configuration is a ceiling
 * that can be widened by accident.
 */
export const SINGLE_USER_CEILING: HumanCeiling = {
  canSee: () => true,
}

/** What addressing resolved to. `unresolvable` is the ONE denial shape: an
 *  unknown id and a beyond-ceiling id are the same value, not two values that
 *  happen to be rendered alike. */
export type AddressResolution =
  | { readonly kind: 'issue'; readonly id: string }
  | { readonly kind: 'session'; readonly id: string }
  | { readonly kind: 'unresolvable' }

export interface AddressDeps {
  /** True when the ref names a live session (session addressing wins). */
  isKnownSession(ref: string): boolean
  /** Resolve an issue ref to an id. Returns the ref unchanged when it names
   *  nothing — today's `IssueService.resolveRef` behaviour, deliberately not a
   *  throw (a throw here is what made the two failures distinguishable). */
  resolveIssueRef(ref: string): string
  /** Does the instance hold this issue at all? */
  issueExists(id: string): boolean
  ceiling: HumanCeiling
}

/**
 * Resolve a caller-supplied address under the human ceiling.
 *
 * The ORDER is load-bearing. Existence is checked first and the ceiling second,
 * and both failures produce the same value — so an attacker enumerating ids
 * learns nothing from either the result or from which branch ran. A ceiling
 * check placed before the existence check would leak through timing on a large
 * grant table; placed after, both paths are one map lookup.
 */
export function resolveAddress(ref: string, deps: AddressDeps): AddressResolution {
  if (deps.isKnownSession(ref)) {
    return deps.ceiling.canSee({ kind: 'session', id: ref })
      ? { kind: 'session', id: ref }
      : { kind: 'unresolvable' }
  }
  const id = deps.resolveIssueRef(ref)
  if (!deps.issueExists(id)) {
    // Unknown id. Falls through to the substrate's existing dead-letter path,
    // which is the branch the beyond-ceiling case converges onto.
    return { kind: 'issue', id }
  }
  if (!deps.ceiling.canSee({ kind: 'issue', id })) return { kind: 'unresolvable' }
  return { kind: 'issue', id }
}

/**
 * MACHINE PLACEMENT — the deliberate opposite of the rule above
 * (readiness §3.1.4 M5 / ADR 3 Amendment 1 D18).
 *
 * `use` is a CODE-EXECUTION boundary, not a privacy one: it means arbitrary
 * execution on someone's hardware with their SSH keys, git identity, dotfiles
 * and checked-out private repos. Here unauthorized MUST stay distinguishable
 * from unreachable, because "denied" and "offline" otherwise produce the same
 * empty list and an operator cannot tell a permissions problem from a dead
 * machine. D20 and M5 pull in opposite directions on purpose, and the contracts
 * record which rule each command follows.
 *
 * Placement never silently retargets. A spawn onto a machine the effective
 * principal may not use is DENIED — not moved to a machine it may use, which
 * would run the caller's code somewhere they did not choose.
 */
export type PlacementDecision = 'allowed' | 'unauthorized' | 'unreachable'

export interface PlacementDeps {
  /** Does the effective principal hold `use` on this machine? Fails closed —
   *  an owner-less machine grants `use` to nobody (D18.6, the all-in-one guard). */
  mayUse(machineId: string): boolean
  /** Is the machine currently reachable? */
  isReachable(machineId: string): boolean
}

/**
 * Authorization is decided BEFORE reachability. A principal with no `use` grant
 * must not be able to probe which of a colleague's machines are online by
 * reading the difference between the two errors.
 */
export function placementDecision(machineId: string, deps: PlacementDeps): PlacementDecision {
  if (!deps.mayUse(machineId)) return 'unauthorized'
  return deps.isReachable(machineId) ? 'allowed' : 'unreachable'
}
