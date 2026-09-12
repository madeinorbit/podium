/**
 * THE PROJECTION POLICY — the read half of the command contract (A3/PDM-129).
 *
 * ---------------------------------------------------------------------------
 * WHY THERE WAS NOTHING HERE BEFORE, AND WHY THAT STOPPED BEING TENABLE
 * ---------------------------------------------------------------------------
 *
 * `modules/approvals/queries.ts` states the reason the read half was left
 * unclassified, and it was a good reason at the time:
 *
 *     `CommandContract` requires a `visibility` class, and a visibility class
 *     describes WHAT A COMMAND WRITES. A read writes nothing. Declaring one
 *     anyway would put a FALSE entry in the audit surface, not a missing one.
 *
 * That is right about `visibility` and wrong as a conclusion about POLICY. The
 * question a read has to answer is not "what class of row do I write" — it is
 * "WHOSE ROWS MAY I RETURN", and every read has an answer to that whether or not
 * anyone wrote it down. Measured on the branch point, 68 externally reachable
 * projections across 29 query tables declared `input`, `exposure` and `run`, and
 * nothing else; `DerivedQuery` has no policy field at all, and
 * `modules/approvals/queries.ts` says in as many words *"AUTHORIZATION IS NOT
 * HERE and must not move here"*.
 *
 * The consequences were already live. `issues.subscriptionList` returned every
 * member's personal automation configuration to any admin. `sessions.status`
 * reads another member's session with no ownership check while `recap` and
 * `transcriptRead`, declared eight lines away in the same table, both assert one.
 * Neither is a coding mistake anybody could have caught in review, because there
 * was no column in which the missing answer would have been visibly missing.
 *
 * ADR 3 Amendment 1 D19's rejected-alternatives table is explicit that filtering
 * rows at the projection layer, with no policy, means *"the authority computed a
 * forbidden row and hoped every projection dropped it"*. This file is the column.
 *
 * ---------------------------------------------------------------------------
 * WHAT A PROJECTION POLICY IS NOT
 * ---------------------------------------------------------------------------
 *
 * It is not a `CommandContract`. A read has no `visibility`, no `conflict`, no
 * `optimisticReducer`, no delivery class and no creation ownership, and giving it
 * those fields to reuse the existing shape would put exactly the false entries in
 * the audit surface that the note above refuses. The two contract families share
 * `CommandResource`, `RoleFloor` and `TransportTag` — the vocabulary that means
 * the same thing on both sides — and nothing else.
 *
 * It is also NOT a widening. Every policy below records the rule the shipped code
 * already applies, except where the census found no rule at all; those are marked
 * {@link UNGOVERNED} and are the census's output, not a decision it took
 * unilaterally. The execution charter's exposure order holds: the owner-or-grant
 * task read predicate in `apps/server/src/feed-visibility.ts` is unchanged by this
 * file, and C4 (PDM-144) replaces it after B7 accepts isolation.
 */

import type { CommandResource, RoleFloor, TransportTag } from './contract'

// ---------------------------------------------------------------------------
// Row scope — the question a read actually asks
// ---------------------------------------------------------------------------

/**
 * WHOSE ROWS a projection may return. This is the read half's equivalent of
 * `CommandPolicy.resource`, and it is a separate field because "which table" and
 * "whose rows in it" are different questions — collapsing them is how
 * `scope.kind === 'all'` came to mean four things at once.
 *
 * A CLOSED SET with an exhaustive consumer, for the reason `IssueScope` is one:
 * a silent default here would fail OPEN, and an open failure in a projection is
 * a disclosure rather than a refused write.
 */
export const PROJECTION_ROW_SCOPES = [
  /** Only rows belonging to the calling human. The default for anything
   *  personal: per-user state, personal automations, private sessions. */
  'caller-only',
  /** Rows of tasks the caller may collaborate on. ADR 9 D4/D5 A3 — every active
   *  member. Bounded during phases A and B by the unchanged feed predicate. */
  'shared-task',
  /** Rows that belong to the instance rather than to any person: the model
   *  catalog, this process's own event-loop accounting, the setup channel. No
   *  person is disclosed by returning them. */
  'instance-wide',
  /** Rows that belong to the instance AND name people or their work. Admissible
   *  only behind an `admin` role floor, and each one says why in its rationale. */
  'instance-wide-sensitive',
  /** The projection returns no stored rows at all — it answers from its
   *  arguments or from this process's configuration. */
  'none',
] as const

export type ProjectionRowScope = (typeof PROJECTION_ROW_SCOPES)[number]

// ---------------------------------------------------------------------------
// The policy
// ---------------------------------------------------------------------------

/**
 * One externally reachable projection's server-enforced policy.
 *
 * TOTALITY IS THE POINT, as it is for `CommandContract`: every field is
 * required, including the ones whose answer is "none". `forbiddenFields` may be
 * empty but must be written, which is what distinguishes "this read discloses
 * nothing sensitive" from "nobody looked".
 */
export interface ProjectionPolicy {
  /** Dotted `family.name`, matching the tRPC path the router serves it on. */
  readonly name: string
  /** Default-closed, exactly as for commands: an empty array means served
   *  nowhere, and it must be written with {@link SERVED_NOWHERE}. */
  readonly exposure: readonly TransportTag[]
  /** Which commands this principal may ATTEMPT (axis 2 — human role). Never a
   *  statement about which rows it may see; that is `rowScope`. */
  readonly roleFloor: RoleFloor
  /** Whose rows may come back (axes 3 and 4 — task collaboration and private
   *  execution). */
  readonly rowScope: ProjectionRowScope
  /**
   * THE DIRECT RESOURCE — the table or entity family the read names. Shares the
   * command vocabulary because it is the same question about the same rows.
   */
  readonly resource: CommandResource
  /**
   * INDIRECT RESOURCES — what the read reaches THROUGH its direct one, and the
   * field the census exists to make someone fill in.
   *
   * `sessions.status` names a session and returns that session's issue, its
   * repository's `git log` and `git status`, and the files it touched. A policy
   * that recorded only `session` would be true and useless: the disclosure is in
   * the repo, and nothing about the direct resource would have made a reviewer
   * ask whether the caller may read it. Empty is a real answer and must be
   * written.
   */
  readonly indirectResources: readonly CommandResource[]
  /**
   * FORBIDDEN FIELDS — paths this projection must never emit, whatever the
   * underlying row holds. Distinct from `RedactionPolicy.outputPaths`, which
   * marks sensitive values that ARE emitted and must be scrubbed from logs:
   * these must not be in the payload at all.
   *
   * ADR 9 Amendment 1 D13 is the shape that needs this — another member's
   * session on a shared task is visible as owner, title and live/idle state
   * ONLY, so the transcript, the cwd and the environment are forbidden rather
   * than redacted.
   */
  readonly forbiddenFields: readonly string[]
  /** Why this policy and not a neighbouring one. Required for the same reason
   *  `CommandPolicy.rationale` is: a policy nobody can audit is one that drifts. */
  readonly rationale: string
}

/**
 * THE CENSUS'S "NO RULE WAS FOUND" MARKER.
 *
 * A projection carrying this is one the census could not find a server-side
 * reader-scoping rule for. It is deliberately NOT a policy that allows
 * everything: {@link projectionPolicyErrors} rejects it, so a contract cannot
 * ship with it, and the census records it as an open finding for the owning
 * phase instead.
 *
 * The alternative — inventing a plausible policy for a read nobody has examined —
 * is how an audit surface acquires a FALSE entry, which is worse than a missing
 * one because it stops anyone looking again.
 */
export const UNGOVERNED = 'ungoverned: no server-side reader scoping found' as const

/**
 * Validation for a projection policy, in the shape `classificationErrors`
 * already established: return every problem, not the first, so one pass over the
 * census reports the whole gap rather than the alphabetically-first item of it.
 */
export function projectionPolicyErrors(policy: ProjectionPolicy): string[] {
  const errors: string[] = []
  const at = (message: string): void => {
    errors.push(`${policy.name}: ${message}`)
  }
  if (policy.name.trim() === '') errors.push('<unnamed>: name is required')
  if (policy.rationale.trim() === '') at('rationale is required')
  if (policy.rationale === UNGOVERNED) {
    at('has no server-side reader scoping; it must gain one or be filed as a finding')
  }
  // `instance-wide-sensitive` is the only scope whose whole meaning is the role
  // floor above it. A member floor on it would be an ordinary instance-wide read
  // wearing a name that implies review.
  if (policy.rowScope === 'instance-wide-sensitive' && policy.roleFloor !== 'admin') {
    at('instance-wide-sensitive rows require an admin role floor')
  }
  // The mirror of ADR 3 D3 rule 1: a read served nowhere is a decision, and a
  // read served somewhere must say whose rows it returns.
  if (policy.exposure.length > 0 && policy.rowScope === 'none' && policy.resource !== 'none') {
    at('claims to return no rows while naming a resource — one of the two is wrong')
  }
  // A caller-only read over `global` is a contradiction: `global` names rows that
  // belong to no person, so there is no caller to scope them to.
  if (policy.rowScope === 'caller-only' && policy.resource === 'global') {
    at('caller-only rows cannot come from a global resource')
  }
  return errors
}

/**
 * The population gate's per-table check, mirroring `registryClassificationErrors`
 * on the command side. Takes the table so a projection added without a policy is
 * a failure of THIS function rather than something a maintainer must remember to
 * add a case for.
 */
export function projectionCensusErrors(
  family: string,
  served: readonly string[],
  policies: Readonly<Record<string, ProjectionPolicy>>,
): string[] {
  const errors: string[] = []
  for (const name of served) {
    const policy = policies[name]
    if (!policy) {
      errors.push(`${family}.${name}: served with no projection policy (default-closed)`)
      continue
    }
    errors.push(...projectionPolicyErrors(policy))
  }
  for (const name of Object.keys(policies)) {
    if (!served.includes(name)) {
      // The second direction, for `derived-family.ts`'s reason: without it an
      // EMPTY surface satisfies every claim the census makes.
      errors.push(`${family}.${name}: has a projection policy but is not served`)
    }
  }
  return errors
}
