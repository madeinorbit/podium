/**
 * Branded entity ids [spec:SP-3fe2] — RE-HOMED here from
 * `@podium/protocol`'s `ids.ts` (and, for {@link UserId}, from
 * `@podium/protocol`'s `planes/principal.ts`) at POD-361. Both of those files
 * said in their own headers that this was their destination: *"Phase 1
 * (POD-299/POD-300) re-homes these brands to `packages/model`; this module is
 * their transitional home"*. `packages/model` is L0 and zod-only, so a brand
 * defined here is reachable from every layer — which is what makes ONE
 * definition site possible (ADR 4 Amendment 1 D9.1).
 *
 * A brand belongs here and nowhere else. `@podium/protocol` keeps re-export
 * shims at both old paths so no consumer had to change in POD-361; POD-362 /
 * POD-363 delete the shims as they sweep.
 *
 * ---------------------------------------------------------------------------
 * TWO SCHEMAS PER BRAND, AND WHY (read before adding a third)
 * ---------------------------------------------------------------------------
 *
 * Each brand ships:
 *
 *   1. the VALIDATING BOUNDARY schema — `SessionId` — `z.string().min(1)` plus
 *      the brand. Use it where a string arrives from outside and must be
 *      checked (wire/db/argv). This is the declaration ADR 1 Amendment 2 D16.2
 *      quotes normatively, so its shape is fixed.
 *   2. the FIELD schema — `SessionIdField` — the brand with **no added
 *      validation**, i.e. exactly the `z.string()` the entity field already
 *      was. Use it INSIDE an entity schema.
 *
 * The split exists because branding is a **compile-time construct that must not
 * change what parses** (POD-361's contract, and ADR 4's wire-transparency rule).
 * Every id field in `entities/` was a bare `z.string()`, so it accepts the empty
 * string today — and at least one producer relies on it:
 * `apps/server/src/modules/sessions/lifecycle.ts` builds
 * `{ kind: 'resume', conversationId: r.conversationId ?? '' }`. Flipping that
 * field to the `.min(1)` schema would make a payload that parses today FAIL to
 * parse, which is a behaviour change wearing a type change's clothes.
 * `ids.empty-string.test.ts` pins it per field, so the trap cannot be re-set by
 * a later "tighten the ids" cleanup that has forgotten why.
 *
 * `as<Brand>(s)` stays the plain cast for boundaries where the string is already
 * trusted (it came out of our own store, or out of an already-parsed envelope).
 *
 * ---------------------------------------------------------------------------
 * THE SET, AND WHAT IS DELIBERATELY NOT IN IT
 * ---------------------------------------------------------------------------
 *
 * TIER 1 — the ratified set ([spec:SP-3fe2]; ADR 1 Amendment 2 §1 quotes it;
 * ADR 4 Amendment 1 D9.1 adds `UserId`): `SessionId`, `IssueId`, `MachineId`,
 * `RepoId`, `ConversationId`, `MutationId`, `ThreadId`, `UserId`.
 *
 * PRINCIPAL-FAMILY — `AgentIdentityId` (POD-365) and `DeviceId` (POD-1075), the
 * actor and device halves of ADR 9 D1's `(user, device, capability)`. They are
 * in the same file because a brand has one home, and documented apart because
 * they name a principal rather than a durable Podium row.
 *
 * TIER 2 — added by POD-361 because a `packages/model` entity field names one
 * and leaving it raw is what ADR 4 D3.5 calls an audit failure; recorded for
 * ratification rather than assumed: `AutomationId`, `AutomationRunId`,
 * `ArtifactId`, `AccountId`. Each names an id the SERVER mints for a durable
 * Podium row, and the first two are members of the codebase's own replicated
 * entity taxonomy (`MetadataEntityKind` = session | issue | conversation |
 * automation | automationRun). Adding them here rather than in POD-362/POD-363
 * is what keeps those sweeps from re-opening these schemas.
 *
 * NOT BRANDED, deliberately — each id field in `entities/` that stays a raw
 * string, and the reason. `docs/rearch-branded-id-flip.md` §3 carries the same
 * table per field; this list is the vocabulary half:
 *
 *   - a HARNESS-NATIVE id (`ConversationSummaryWire.id` / `parentConversationId`,
 *     `TranscriptItem.id` / `cursor` / `toolUseId`, `NativeSubagent.id`,
 *     `ResumeRef.value`): minted by Claude Code / Codex / the harness, not by
 *     us. POD-360 named `nativeId` as having no brand for exactly this reason:
 *     it is evidence, not identity — the conversation registry exists because a
 *     resume roll changes it.
 *   - an EXTERNAL CORRELATION id (`SessionMeta.workflowRunId` /
 *     `workflowStepId` / `executionProfileId`, `IssueWire.linearId` /
 *     `linearIdentifier`): the schema's own comment says *"stamped at
 *     spawn/assignment by an external coordinator; the substrate never
 *     interprets them"*. A brand asserts a namespace we do not own.
 *   - a TRANSPORT-CONNECTION id (`SessionMeta.controllerId`): it holds
 *     `client.id`, a websocket client id (`apps/server/src/modules/sessions/
 *     session.ts` — `if (this.controllerId === null) this.controllerId =
 *     client.id`), NOT a session id. Branding it `SessionId` would have been a
 *     well-typed lie; its brand is ADR 9's `DeviceId` family, which POD-1075
 *     owns.
 *   - an ATTRIBUTION TAG that is not an id at all (`SessionMeta.spawnedBy`,
 *     `IssueWire.assignee`, `IssueWire.origin`): see
 *     `docs/rearch-branded-id-flip.md` §4. `spawnedBy` is a six-arm tagged
 *     union living unparsed in a freeform string; POD-360 found ONE consumer
 *     parses it and SEVEN rebuild the template literal to compare, FIVE of them
 *     gating parent-session authorization. A brand does not fix that — it still
 *     permits seven hand-built strings — so it needs a shared constructor AND
 *     parser (POD-1133), not a type.
 * `MachineId` used to be on this list, carved out at every field by ADR 1
 * Amendment 2 D16.2's ordering constraint. POD-318 retired `'local'` and
 * `'__local__'`, so the constraint is discharged: {@link MachineId} now REFUSES
 * both, every field is bound to {@link MachineIdField}, and there is no carve-out
 * marker left to bind to.
 */

import { z } from 'zod'

/**
 * The field-position brand: the brand ONLY, no added validation, so the schema
 * accepts exactly what the bare `z.string()` it replaces accepted. See this
 * file's header for why this is not the same schema as the validating boundary.
 */
const idField = <B extends string>() => z.string().brand<B>()

// ---------------------------------------------------------------------------
// Tier 1 — the ratified set
// ---------------------------------------------------------------------------

/**
 * A machine (daemon) identity — minted material, and NOT either retired sentinel.
 *
 * ADR 1 Amendment 2 D16.2 rule 2 blocked this brand from every field until POD-318
 * retired `'local'` and `'__local__'`, on the grounds that branding a sentinel
 * LAUNDERS it: `MachineId` validates length, not shape, so `.parse('local')` used
 * to succeed and hand back something the type system swore was an identity.
 *
 * The refusal below is what discharges that argument rather than merely outliving
 * it. Every machine id in the system is now a UUID minted by the machine that owns
 * it — `<stateDir>/machine.id` for the host, `~/.podium/daemon.json` for a remote —
 * so the two literals name nothing, and a value that still carries one is a row (or
 * a payload, or a hand-written test fixture) from before the migration. Refusing it
 * at the boundary is how that gets FOUND instead of silently routed to a machine
 * that does not exist.
 *
 * Deliberately a denylist of the two retired values, not a UUID pattern: a remote
 * daemon's id is its own to mint and this brand has never dictated its shape.
 */
export const MachineId = z
  .string()
  .min(1)
  .refine((id) => id !== 'local' && id !== '__local__', {
    message: "'local' and '__local__' are retired machine sentinels (POD-318), not ids",
  })
  .brand<'MachineId'>()
export type MachineId = z.infer<typeof MachineId>
export const MachineIdField = idField<'MachineId'>()
export const asMachineId = (s: string): MachineId => s as MachineId

export const SessionId = z.string().min(1).brand<'SessionId'>()
export type SessionId = z.infer<typeof SessionId>
export const SessionIdField = idField<'SessionId'>()
export const asSessionId = (s: string): SessionId => s as SessionId

export const IssueId = z.string().min(1).brand<'IssueId'>()
export type IssueId = z.infer<typeof IssueId>
export const IssueIdField = idField<'IssueId'>()
export const asIssueId = (s: string): IssueId => s as IssueId

export const RepoId = z.string().min(1).brand<'RepoId'>()
export type RepoId = z.infer<typeof RepoId>
export const RepoIdField = idField<'RepoId'>()
export const asRepoId = (s: string): RepoId => s as RepoId

/**
 * An issue DEPENDENCY EDGE identity — DERIVED from its primary key, never minted
 * [POD-822; ported from main at the POD-1246 catch-up].
 *
 * The brand lives here because this file is the single definition site for a
 * brand. The CONSTRUCTOR lives in `keys.ts`, beside every other composite key,
 * because that is what this id IS: `(fromId, toId, type)` joined. See
 * `issueDepId` there for why a synthetic random id would be a second identity
 * for a row that already has one.
 */
export const IssueDepId = z.string().min(1).brand<'IssueDepId'>()
export type IssueDepId = z.infer<typeof IssueDepId>
export const IssueDepIdField = idField<'IssueDepId'>()
export const asIssueDepId = (s: string): IssueDepId => s as IssueDepId

/**
 * The Podium-stable conversation identity (`docs/spec/conversation-registry.md`)
 * — the `podiumId`, NOT the harness-native transcript id. The native id is
 * evidence: a resume that rolls into a new file gets a new one and keeps this.
 */
export const ConversationId = z.string().min(1).brand<'ConversationId'>()
export type ConversationId = z.infer<typeof ConversationId>
export const ConversationIdField = idField<'ConversationId'>()
export const asConversationId = (s: string): ConversationId => s as ConversationId

export const MutationId = z.string().min(1).brand<'MutationId'>()
export type MutationId = z.infer<typeof MutationId>
export const MutationIdField = idField<'MutationId'>()
export const asMutationId = (s: string): MutationId => s as MutationId

export const ThreadId = z.string().min(1).brand<'ThreadId'>()
export type ThreadId = z.infer<typeof ThreadId>
export const ThreadIdField = idField<'ThreadId'>()
export const asThreadId = (s: string): ThreadId => s as ThreadId

/**
 * A PERSON. Re-homed from `@podium/protocol`'s `planes/principal.ts`, whose
 * header named this file as its destination; that module now re-exports from
 * here so `Principal`, the delegation chain and the plane ports are untouched.
 *
 * ADR 4 Amendment 1 D9.1: *"`UserId` is a branded id in the POD-301 family,
 * alongside `SessionId` / `IssueId` / `MachineId`. Raw `z.string()` for a person
 * is an audit failure after the flip."* It is defined at the same moment as the
 * other brands ON PURPOSE (`docs/multi-user-readiness.md` §3.2): POD-1075 adds
 * the `User` aggregate to an existing brand instead of introducing a brand
 * mid-phase, and no schema is swept twice. Sequencing is recorded in
 * `docs/rearch-branded-id-flip.md` §5.
 *
 * NO model schema field carries it yet, and that is correct: the on-behalf-of
 * half of every attribution pair is POD-1075's to add (§3.1.3 A3). What POD-361
 * owes POD-1075 is the brand, the `(userId, entityId)` key shape, and the list
 * of sites — all three are here or in that doc.
 *
 * Server-minted and authoritative INSIDE ONE INSTANCE ONLY (ADR 1 Amendment 2
 * D21.3): equal `UserId` values in two instances are unrelated strings. Nothing
 * here carries an instance partition — multi-user is not multi-tenancy.
 */
export const UserId = z.string().min(1).brand<'UserId'>()
export type UserId = z.infer<typeof UserId>
export const UserIdField = idField<'UserId'>()
export const asUserId = (s: string): UserId => s as UserId

/**
 * An AGENT SESSION acting — the ACTOR half of ADR 9 D5 A3's attribution pair,
 * and the one member of {@link ActorRef} that is neither a person nor a machine.
 *
 * Re-homed from `@podium/protocol`'s `planes/principal.ts` by POD-365, following
 * the {@link UserId} precedent above and that module's own instruction: it
 * records that `AgentIdentityId` *"stays here on purpose … `packages/model`
 * gains them with that aggregate or not at all"*. The aggregate is POD-1075's
 * and has not landed, but the **brand** is POD-301-family work that model
 * already owns for every other id, and `fields/attribution.ts` cannot build the
 * pair without it. Protocol re-exports from here, so `Principal`, the delegation
 * chain and the plane ports are untouched — the same shape the `UserId` move
 * took.
 *
 * DISTINCT FROM `SessionId`, and that is the whole point. It names the harness
 * identity on the hook channel (`agent_id` on SubagentStart / SubagentStop, and
 * `Capability.actorSessionId` on the relay path), which is why
 * `NativeSubagent.id` in `entities/session.ts` is documented as belonging to
 * THIS brand rather than to `SessionId`.
 *
 * NOT the delegation shape. `(agentIdentity, onBehalfOf, scope)` — the agent
 * principal itself — is POD-1075's aggregate and is deliberately not defined
 * here; this is the id it is keyed by.
 */
export const AgentIdentityId = z.string().min(1).brand<'AgentIdentityId'>()
export type AgentIdentityId = z.infer<typeof AgentIdentityId>
export const AgentIdentityIdField = idField<'AgentIdentityId'>()
export const asAgentIdentityId = (s: string): AgentIdentityId => s as AgentIdentityId

/**
 * A DEVICE — the authenticated client session or daemon binding a call arrived
 * on, and the half of ADR 9 D1's `(user, device, capability)` principal that
 * names *which connection* rather than *which person*.
 *
 * Re-homed from `@podium/protocol`'s `planes/principal.ts` by POD-1075,
 * following the {@link UserId} (POD-361) and {@link AgentIdentityId} (POD-365)
 * precedents and that module's own instruction: `DeviceId` *"stays here on
 * purpose … `packages/model` gains them with that aggregate or not at all"*.
 * The aggregate is here now (`identity/user.ts`, `identity/client-session.ts`),
 * so the brand comes with it. Protocol re-exports from here, so `Principal`,
 * the delegation chain and the plane ports are untouched.
 *
 * NOT AN ENTITY ID IN THE POD-301 SENSE, and the distinction is why it is
 * documented separately rather than slipped into Tier 1: it names a transport
 * BINDING with a login-scoped lifetime, not a durable Podium row. Its
 * counterpart `CapabilityRef` and `DelegationRef` deliberately stay in
 * `@podium/protocol` — they are opaque server-minted references the plane ports
 * carry and must never inspect, and giving L0 a name for them would invite a
 * consumer to look inside one.
 *
 * WHAT IT MAKES SAYABLE. Until now a client session was a device *or* a person
 * and the system had one word for both. `SessionMeta.controllerId` holds a
 * websocket `client.id` and `brands.ts` already recorded that its brand belongs
 * to "ADR 9's `DeviceId` family, which POD-1075 owns"; adopting it AT that field
 * is a separate sweep (POD-362/POD-363) and is deliberately not done here — the
 * brand exists so there is something to brand towards.
 */
export const DeviceId = z.string().min(1).brand<'DeviceId'>()
export type DeviceId = z.infer<typeof DeviceId>
export const DeviceIdField = idField<'DeviceId'>()
export const asDeviceId = (s: string): DeviceId => s as DeviceId

// ---------------------------------------------------------------------------
// Tier 2 — added by POD-361, recorded for ratification (see the header)
// ---------------------------------------------------------------------------

/** A scheduled automation [spec:SP-17db] — a `MetadataEntityKind` member. */
export const AutomationId = z.string().min(1).brand<'AutomationId'>()
export type AutomationId = z.infer<typeof AutomationId>
export const AutomationIdField = idField<'AutomationId'>()
export const asAutomationId = (s: string): AutomationId => s as AutomationId

/** One recorded occurrence of an automation firing — a `MetadataEntityKind`
 *  member, and a DISTINCT id space from {@link AutomationId}: `AutomationRunWire`
 *  carries both `id` and `automationId`, which is exactly the confusion a brand
 *  is for. */
export const AutomationRunId = z.string().min(1).brand<'AutomationRunId'>()
export type AutomationRunId = z.infer<typeof AutomationRunId>
export const AutomationRunIdField = idField<'AutomationRunId'>()
export const asAutomationRunId = (s: string): AutomationRunId => s as AutomationRunId

/** A permanent-store artifact snapshot ([spec:SP-0fc9], POD-441): the bytes live
 *  at `<state-dir>/artifacts/<issueId>/<artifactId>/`, so this id and an
 *  {@link IssueId} appear side by side in one path and must not be swappable. */
export const ArtifactId = z.string().min(1).brand<'ArtifactId'>()
export type ArtifactId = z.infer<typeof ArtifactId>
export const ArtifactIdField = idField<'ArtifactId'>()
export const asArtifactId = (s: string): ArtifactId => s as ArtifactId

/** A managed agent account (`SessionMeta.accountId`) — a server-held row, not
 *  the harness's own login. §3.1.4 M2's unresolved billing question is about
 *  WHOSE this is, not about whether it is an id. */
export const AccountId = z.string().min(1).brand<'AccountId'>()
export type AccountId = z.infer<typeof AccountId>
export const AccountIdField = idField<'AccountId'>()
export const asAccountId = (s: string): AccountId => s as AccountId
