/**
 * AGENT DELEGATION AS A SHAPE — `(agentIdentity, onBehalfOf, scope)` (POD-1075).
 *
 * ADR 9 D5 A1: *"An agent principal is `(agentIdentity, onBehalfOf: UserId,
 * scope)`. Its EFFECTIVE RIGHTS are its own scope intersected with its human's
 * CURRENT rights, resolved at every apply — not a capability frozen at spawn."*
 *
 * This file defines the three-part shape and nothing else. Two things it
 * deliberately does not do, both because another issue owns them:
 *
 *   - **the lifecycle.** A delegation is born and retired with its
 *     `SessionBinding` (ADR 9 D5 A5, POD-323, Phase 5) rather than in a parallel
 *     identity system, so delegation survives handoff between machines for free.
 *     There is no `create` / `revoke` here.
 *   - **the resolution.** Walking the chain and intersecting with the human's
 *     current rights is `apps/server/src/command-principal.ts` plus ADR 3 D8's
 *     apply-time re-authorization. That code reads the world LIVE at every call;
 *     this schema is the durable record it reads FROM.
 *
 * ---------------------------------------------------------------------------
 * THE FIELD THAT LOOKS LIKE THE THING THE ADR FORBIDS, AND IS NOT
 * ---------------------------------------------------------------------------
 *
 * `scope` is one of the two OPERANDS of the intersection. It is never the
 * result. The distinction decides whether this file is compliant or is the exact
 * privilege leak ADR 9 D5 A1 rejects, so it is worth stating precisely:
 *
 *     effective rights  =  this delegation's `scope`  ∩  the human's CURRENT rights
 *                          └── durable, declared at    └── read live, never stored
 *                              spawn, narrow by A2         here, moves after spawn
 *
 * The left operand is a fact about what this agent was SPAWNED FOR — its
 * session, its issue, that issue's subtree (ADR 9 D5 A2: *"the human is a
 * ceiling, not the default grant"*). It cannot grow without an explicit
 * `--outside-scope` / `overrideScope` confirmation, and it is meaningless on its
 * own: a delegation whose human has been disabled authorizes nothing, however
 * broad its declared scope, because the right operand is empty.
 *
 * The result — the intersection — is what must never be written down. A stored
 * result survives the revocation of the person it was derived from, with no
 * cleanup trigger, in a system where agents run for hours unsupervised. So there
 * is no `effectiveRights` field, no `allowed` bit, no resolved role, and no
 * cached decision anywhere in this schema.
 *
 * That is not left to review. `delegation.test.ts` runs POD-643's
 * `findCapabilitySnapshotKeys` over {@link AgentDelegation} and pins its verdict
 * to EXACTLY the operand keys — so adding `effectiveRights`, `capabilities`,
 * `permissions` or `acl` changes the pinned list and fails the test. The
 * detector is never widened to accommodate this file; the expectation is pinned
 * so that anything new is visible.
 *
 * ---------------------------------------------------------------------------
 * WHY THE SCOPE IS THE `IssueScope` VOCABULARY AND NOT A NEW ONE
 * ---------------------------------------------------------------------------
 *
 * `authz/issue-authz.ts` is the single enforcement function and its
 * `IssueScope` is a CLOSED SET whose totality is compiler-enforced — POD-380
 * already added the `owned` (owner-or-grant) and `self` (per-user state) members
 * that multi-user needs. Inventing a second scope vocabulary here would mean two
 * closed sets that have to be kept in step by hand, and the one that is NOT the
 * enforcement function's would be the one that silently drifts. A delegation's
 * scope is expressed in the vocabulary the thing that evaluates it speaks.
 */

import { z } from 'zod'
import type { IssueScope } from '../authz/issue-authz'
import { AgentIdentityIdField, IssueIdField, UserIdField } from '../ids'

/**
 * The declared scope of a delegation, as a schema over `IssueScope`'s closed
 * set. The `satisfies` pin below is what keeps the two in step: this schema's
 * inferred type must remain assignable to `IssueScope`, so a member added to
 * that union without a corresponding arm here — or an arm here that the union
 * does not have — fails to compile.
 *
 * `all` is representable and that is not a loophole: a superagent is *"a
 * broad-scope delegation … scope = everything that human can see"* (ADR 9 D8 S1)
 * and is explicitly NOT a fifth principal kind, so the shape must be able to
 * express it. What bounds it is the right operand, not this one — a superagent
 * scoped `all` still reaches only what its human currently reaches.
 */
export const DelegationScope = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('all') }),
  z.object({ kind: z.literal('none') }),
  z.object({ kind: z.literal('subtree'), rootId: IssueIdField }),
  z.object({ kind: z.literal('owned'), userId: UserIdField }),
  z.object({ kind: z.literal('self'), userId: UserIdField }),
])
export type DelegationScope = z.infer<typeof DelegationScope>

/** Compile-time pin: the delegation's scope vocabulary IS the enforcement
 *  function's. Assignable in both directions, so neither side can gain or lose a
 *  member without the other. */
const _scopeIsIssueScope: IssueScope = null as unknown as DelegationScope
const _issueScopeIsDelegationScope: DelegationScope = null as unknown as IssueScope
void _scopeIsIssueScope
void _issueScopeIsDelegationScope

/**
 * ADR 9 D5's agent principal, as a durable shape — ADR 1 matrix row
 * `delegation-record`.
 *
 * `parentAgentIdentity` is the chaining half (ADR 9 D5, "Chaining"): sub-agents
 * delegate from their PARENT agent, never widening, with exactly ONE human at
 * the root of the chain. It is `.nullable()` rather than `.optional()` for the
 * usual reason — `null` is a representable "this is the root of the chain",
 * while an absent key would mean nobody threaded the value, and a reader that
 * treats a missing parent as "root" would let a sub-agent present itself as one
 * and escape its parent's bound.
 *
 * `onBehalfOf` is the human at the ROOT of the chain, not the immediate parent's
 * human — there is exactly one, and reading it off the leaf would let a
 * sub-agent carry a delegator its parent does not have.
 */
export const AgentDelegation = z.object({
  /** WHICH AGENT. For a Podium agent session this is the session id re-branded
   *  as actor (POD-1164: `agentIdentityFromSessionId` / binding-store mint). Not
   *  a harness-native hook `agent_id` — see `ids/brands.ts`. */
  agentIdentity: AgentIdentityIdField,
  /** THE ONE HUMAN at the root of the chain (ADR 9 D5 A1). Entities this agent
   *  creates are owned by this person, with the agent as actor (A4). */
  onBehalfOf: UserIdField,
  /** WHAT IT WAS SPAWNED FOR — the LEFT operand of the intersection, narrow by
   *  A2. Never the effective rights; see this file's header. */
  scope: DelegationScope,
  /** The agent this one delegates FROM, or `null` at the root of the chain. */
  parentAgentIdentity: AgentIdentityIdField.nullable(),
  createdAt: z.string(),
})
export type AgentDelegation = z.infer<typeof AgentDelegation>

/**
 * The key names {@link AgentDelegation} legitimately carries that POD-643's
 * capability-snapshot detector matches — pinned as DATA so `delegation.test.ts`
 * asserts the detector's verdict equals exactly this, and any new authority-ish
 * key fails.
 *
 * One member: `scope`, the declared left operand. If this list ever needs a
 * second member, that is a decision requiring an ADR 9 D5 amendment, not an edit
 * to a constant.
 */
export const DELEGATION_DECLARED_OPERAND_KEYS = ['scope'] as const
