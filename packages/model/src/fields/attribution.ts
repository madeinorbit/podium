/**
 * `Attribution` — the actor / on-behalf-of PAIR, defined once (POD-365).
 *
 * ADR 9 D5 A3: *"Every write records **actor** (which agent) and **on-behalf-of**
 * (which human), both stamped from the transport principal per ADR 3 D7, never
 * from payload."* ADR 4 Amendment 1 D9.3 adds the shape rule: the two halves are
 * DIFFERENTLY BRANDED, so the pair cannot collapse into one nullable id without
 * losing the distinction the product already depends on — human-set `name`
 * outranks agent-set ([spec:SP-eb60] `nameSource`), and `humanQuestionAskedBy`
 * is server-authoritative precisely so "did a person or an agent ask this?"
 * stays answerable.
 *
 * ---------------------------------------------------------------------------
 * THIS IS THE DURABLE FIELD SCHEMA. THE TWO EXISTING PAIRS ARE ITS PRODUCERS.
 * ---------------------------------------------------------------------------
 *
 * Three things in this repo carry an (actor, on-behalf-of) shape and they are
 * not duplicates of each other. Stated here because the next reader's first
 * instinct will be that two of them should be deleted:
 *
 *   1. `capabilityAttribution()` (`../authz/issue-authz.ts`) reads the pair off a
 *      **`Capability`** — the authorization decision input.
 *   2. `attributionOf()` (`@podium/protocol`'s `planes/principal.ts`) reads it
 *      off a **`Principal`** — the authenticated transport identity.
 *   3. **This file** is the pair as it is STORED ON AN ENTITY — durable truth on
 *      R1 that survives bootstrap, export and re-replication (ADR 4 Am1 D9.4).
 *
 * (1) and (2) are readers; (3) is the field. They are related the way a getter is
 * related to a column, and the correct end state is that both readers PRODUCE
 * this schema. Re-pointing them is a consumer change, which this issue is
 * explicitly not making — POD-1075 owns the principal module and has been mailed
 * the interface. What is guaranteed today is that there is exactly ONE *field
 * schema* for the pair, and it is this one.
 *
 * ADR 4 Am1 D9.4 also fixes where it may NOT live: attribution is not provenance.
 * `viaHub` / `upstreamStale` / `pendingSync` describe how a value ARRIVED and
 * ride the envelope; actor and on-behalf-of describe who CAUSED it and are
 * durable entity facts. `provenance/envelope.test.ts` already enforces the split
 * from the other side.
 */

import { z } from 'zod'
import { AgentIdentityIdField, MachineIdField, UserIdField } from '../ids'

/**
 * WHO ACTED — the actor half, as ADR 9 D1's four principal kinds.
 *
 * A discriminated union, not a nullable string, for three reasons that each cost
 * something later if skipped:
 *
 *   - The four kinds are **differently branded**. A `UserId`, an
 *     `AgentIdentityId` and a `MachineId` are not interchangeable, and a system
 *     job is not an id at all. Flattening them to `string` is what
 *     `SessionMeta.spawnedBy` already did, and POD-360 found seven consumers
 *     rebuilding its template literal to compare — five of them gating
 *     authorization on the match.
 *   - `null` is already spoken for on the OTHER half of the pair (it means "no
 *     on-behalf-of", the machine/system case). Overloading it here would make
 *     "no actor recorded" and "a system did it" indistinguishable — the exact
 *     defect the inventory found on `causedBySessionId`, which is stamped
 *     conditionally so an operator-originated close records nothing at all.
 *   - A future **redacted** arm — "an actor you may not resolve", under the
 *     scoped feed's cross-boundary rules (ADR 9 §3 O2) — is an added member
 *     here, whereas on a nullable string it would have to overload `null` a
 *     third time. Room left; nothing built.
 *
 * Closed by decision: a fifth kind is an ADR 9 D1 amendment, not a convenience.
 * The `superagent` is deliberately absent — D1 makes it an agent delegation with
 * a broad scope, not a fifth principal kind, so it is an `agent` actor here.
 */
export const ActorRef = z.discriminatedUnion('kind', [
  /** A person acting directly. Both halves of the pair name the same human. */
  z.object({ kind: z.literal('user'), id: UserIdField }),
  /** A Podium agent session acting for exactly one human (ADR 9 D1, D5 A1). Its
   *  `onBehalfOf` is that human, and is never optional for this arm. */
  z.object({ kind: z.literal('agent'), id: AgentIdentityIdField }),
  /** A paired daemon reporting an observation. A machine is NOT a person and may
   *  not stand in for one (ADR 9 D1) — `onBehalfOf` is `null`, not the owner. */
  z.object({ kind: z.literal('machine'), id: MachineIdField }),
  /** An in-process job: steward, expiry, boot reconcile, derived-field
   *  maintenance. ADR 9 D8 S5: system principals never act AS a person, so this
   *  arm names the JOB and carries no id — giving it one would be the service
   *  account D8 rejects. */
  z.object({ kind: z.literal('system'), job: z.string() }),
])
export type ActorRef = z.infer<typeof ActorRef>

/** Constructors. Exported beside the union for the reason `SessionProvenance`
 *  needs them (inventory D-17): a shape that consumers hand-build is a shape
 *  that drifts, and here the drift would be silent in an authorization input. */
export type UserActor = Extract<ActorRef, { kind: 'user' }>
export type AgentActor = Extract<ActorRef, { kind: 'agent' }>
export type MachineActor = Extract<ActorRef, { kind: 'machine' }>
export type SystemActor = Extract<ActorRef, { kind: 'system' }>

export const actorUser = (id: UserActor['id']): UserActor => ({ kind: 'user', id })
export const actorAgent = (id: AgentActor['id']): AgentActor => ({ kind: 'agent', id })
export const actorMachine = (id: MachineActor['id']): MachineActor => ({ kind: 'machine', id })
export const actorSystem = (job: string): SystemActor => ({ kind: 'system', job })

/**
 * The single identifying string of an actor, for display and logging ONLY.
 *
 * Deliberately NOT a parser and deliberately not round-trippable: it discards
 * `kind`, so nothing can compare two actors by it or gate on it. That is the
 * lesson of `spawnedBy` — the moment a flattened tag becomes comparable, seven
 * call sites rebuild it by hand and five of them decide authorization with the
 * result.
 */
export const actorDisplayId = (a: ActorRef): string => (a.kind === 'system' ? a.job : a.id)

/**
 * The attribution pair as an entity carries it.
 *
 * `onBehalfOf` is `.nullable()` and NOT `.optional()`, and the difference is the
 * whole point: `null` is a REPRESENTABLE "there is no human behind this" for the
 * machine and system arms, while an absent key would mean "nobody threaded the
 * value" — two different facts that the tip currently cannot tell apart. ADR 9
 * D8 S5 forbids defaulting it to an operator or to the row's owner.
 *
 * Required on R1 for the same reason `Ownership.owner` is: on the durable
 * aggregate, "this row was caused by someone" is unconditionally true. Whether a
 * given projection carries it is that projection's call (README rule 2).
 */
export const Attribution = z.object({
  /** WHICH AGENT (or person, machine, job). Stamped from the transport principal
   *  per ADR 3 D7 — never read from a command payload, where identity is inert. */
  actor: ActorRef,
  /** WHICH HUMAN the write was made FOR. The same person for a human actor, the
   *  delegating human for an agent, and `null` — explicitly, never defaulted —
   *  for a machine or a system job. */
  onBehalfOf: UserIdField.nullable(),
})
export type Attribution = z.infer<typeof Attribution>
