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
 * Four things in this repo carry an (actor, on-behalf-of) shape and they are
 * not duplicates of each other. Stated here because the next reader's first
 * instinct will be that some of them should be deleted:
 *
 *   1. `capabilityAttribution()` (`../authz/issue-authz.ts`) reads the pair off a
 *      **`Capability`** — the authorization decision input.
 *   2. `attributionOf()` (`@podium/protocol`'s `planes/principal.ts`) reads it
 *      off a **`Principal`** — the authenticated transport identity.
 *   3. **This file** is the pair as it is STORED ON AN ENTITY — durable truth on
 *      R1 that survives bootstrap, export and re-replication (ADR 4 Am1 D9.4).
 *   4. `OutboxAttribution` (`@podium/sync`'s `outbox/records.ts`) is the pair on a
 *      QUEUED CLIENT WRITE, before it has reached an entity at all.
 *
 * (1) and (2) are readers; (3) is the field. They are related the way a getter is
 * related to a column, and the correct end state is that both readers PRODUCE
 * this schema. Re-pointing them is a consumer change, which this issue is
 * explicitly not making — POD-1075 owns the principal module and has been mailed
 * the interface. What is guaranteed today is that there is exactly ONE *field
 * schema* for the pair, and it is this one.
 *
 * (4) WAS A SECOND FIELD DEFINITION AND IS NOT ANY MORE — POD-1148. It declared
 * its own two-arm union whose agent arm carried a `SessionId` against this file's
 * `AgentIdentityId`, which read as two facts rather than two spellings. POD-1164
 * measured the mint and settled it: for a Podium agent session those brands name
 * the SAME string (`asAgentIdentityId(sessionId)` at every binding-store spawn
 * and receipt path), so the brands separate ROLE, not id space. `OutboxActor` is
 * now `Extract<ActorRef, { kind: 'user' | 'agent' }>` — a narrowing of the union
 * below, with its `onBehalfOf` non-nullable because both surviving arms have a
 * human behind them — and `OutboxAttribution extends Attribution`, so it cannot
 * drift from this file without a compile error. Adding a fifth kind here
 * propagates there; it cannot be shadowed. Decision and evidence:
 * `docs/agents/pod-1148-one-attribution-vocabulary.md`.
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

/** The kind half as a storage column takes it — ADR 9 D1's four, closed.
 *  DERIVED from the union's arms, never retyped: adding a fifth kind above
 *  propagates here and makes `actorFromColumns` below fail to compile until it
 *  handles the new arm, which is the point of not writing the list twice. */
export type ActorKind = ActorRef['kind']

/**
 * THE `(kind, id)` COLUMN CODEC — the round-trip between an `ActorRef` and the
 * two-column encoding every attribution table in this repo already uses
 * (`settings_audit_events`, `telegram_chat_bindings`, `messages`,
 * `queued_messages`, `sessions`).
 *
 * It lives here, beside the union, because a codec written at the storage edge
 * is a codec each storage edge writes AGAIN — and `actorDisplayId` above records
 * what that costs: the moment a flattened tag becomes something call sites
 * rebuild by hand, they start comparing on it. These two are the inverse of each
 * other and nothing else needs to know the encoding.
 *
 * `fromColumns` is a DECODER, not a validator: it trusts the CHECK constraint on
 * the column for the closed kind set, and re-brands the id on the way in — the
 * one legitimate re-entry into the branded id space, since sqlite carries no
 * brand. `system` stores its JOB in the id column because ADR 9 D8 S5 gives that
 * arm no id, and giving it one would be the service account D8 rejects.
 *
 * (`inbox.ts` has a deliberately NARROWER pair that refuses `machine`. That is a
 * policy — a machine may not originate session input — not a second encoding,
 * and it is left alone rather than widened to match.)
 */
export const actorColumns = (actor: ActorRef): { kind: ActorKind; id: string } => ({
  kind: actor.kind,
  id: actorDisplayId(actor),
})

export const actorFromColumns = (kind: ActorKind, id: string): ActorRef => {
  switch (kind) {
    case 'user':
      return actorUser(id as UserActor['id'])
    case 'agent':
      return actorAgent(id as AgentActor['id'])
    case 'machine':
      return actorMachine(id as MachineActor['id'])
    case 'system':
      return actorSystem(id)
  }
}

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

/**
 * WHEN IT HAPPENED AND WHO DID IT — the stamped pair, defined once (POD-1156).
 *
 * POD-365 made the attribution pair unsplittable by NESTING the timestamp INSIDE
 * the object that carries the actor, so a shape recording *when* while recording
 * nothing about *who* does not typecheck. That is the fix POD-367 pinned a live
 * defect against (commit `a349bf4e`: the node-side optimistic-patch arm stamps
 * the timestamp unconditionally and the principal only if the input happens to
 * supply one). The IDIOM was then hand-written at each site that needed it.
 *
 * THE DRIFT THIS CLOSES IS THE PAIRING, NOT THE PRINCIPAL. {@link Attribution}
 * is already one schema and every site names that instance, so the actor half
 * cannot fork. What had no definition at all was the *two-part fact* — and a new
 * site was free to call the timestamp `stampedAt`, make it `.optional()`, or nest
 * it the other way round, with nothing anywhere to notice. Every instrument this
 * repo owns is blind to that: a restatement is byte-identical, so the golden
 * corpora cannot see it (they pin the encoding of values someone chose to
 * write), and `legacyAttributionViolations` resolves the pair by a per-site
 * DECLARED path, so a site that spells the timestamp differently still passes it.
 *
 * WHAT COMPOSES IT, AND THE ONE SITE THAT CANNOT:
 *
 *   - `HandoffManifestV2.exported` (POD-1153) IS this object — same key set, same
 *     order, so composing it moves no bytes.
 *   - `SessionTombstone.deleted` is this pair PLUS `source` and `byIssueId`, and
 *     it interleaves them: `{at, source, by, byIssueId}`. It therefore names the
 *     two members positionally rather than calling `.extend()`, which would
 *     append and re-emit the object as `{at, by, source, byIssueId}` — a
 *     REORDERING of a persisted, replicated shape, invisible to every type but
 *     not to the bytes. Extension stays expressible; it is spelled by placement.
 *   - `NeedsHuman.asked` (`fields/issue.ts`) does NOT compose it and is not made
 *     to. Its `by` key is the asking SESSION — POD-365 kept it that way because
 *     it is also the DELIVERY ADDRESS the registry routes the answer to — and the
 *     principal pair sits beside it at `asked.attribution`. Composing here would
 *     mean RENAMING two keys on a persisted shape, which is strictly worse than
 *     the duplication it removes. The site is instead pinned by name in
 *     `attribution-stamped.test.ts`, so its deviation is a recorded decision that
 *     a fourth site cannot quietly join.
 *
 * `at` is a plain `z.string()` because that is what all three sites already use.
 * A shared TIMESTAMP field schema is a separate question with a separate blast
 * radius (every `*At` key in the vocabulary) and is deliberately not opened here;
 * what is shared is this MEMBER, so the pair's timestamp has one definition even
 * though timestamps in general do not.
 */
export const StampedAttribution = z.object({
  /** WHEN. Inside the object rather than beside it — that nesting is the whole
   *  mechanism, not a formatting choice (ADR 9 D5 A3, POD-365). */
  at: z.string(),
  /** WHO, as the ONE shared pair. Required: a stamp with no principal is the
   *  half-record this shape exists to make unrepresentable. */
  by: Attribution,
})
export type StampedAttribution = z.infer<typeof StampedAttribution>
