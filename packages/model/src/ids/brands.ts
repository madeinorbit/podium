

import { z } from 'zod'
import type { Instant } from '../clock'
import { brandedIdSchema, ID_PREFIXES, mintBrandedId } from './branded-ksuid'

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

/**
 * A MESSAGE'S ONE ID, minted by its sender before the first attempt (POD-4763;
 * POD-4720 §4 rule 1). The app, the CLI and the server's own notices all mint it,
 * and every hop keeps it: the server's `messages` row, the session queue row and
 * the frame the daemon types from. The server stores a message once per id, so a
 * sender that repeats an attempt it never heard back from repeats it under this
 * id and gets the stored message back instead of a second copy.
 *
 * The shape is checked where a sender hands one in: the `msg_` prefix and a
 * UUID, nothing else, which also caps its length. A sender cannot pick an id
 * that names something else, and an id that is not a message id is refused
 * before it is written anywhere.
 */
export const MESSAGE_ID_PREFIX = 'msg_'
export const MessageId = z
  .string()
  .max(MESSAGE_ID_PREFIX.length + 36)
  .regex(/^msg_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i, {
    message: 'a message id is msg_ followed by a UUID',
  })
  .brand<'MessageId'>()
export type MessageId = z.infer<typeof MessageId>
export const asMessageId = (s: string): MessageId => s as MessageId

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
 * gains them with that aggregate or not at all"*. Protocol re-exports from here,
 * so `Principal`, the delegation chain and the plane ports are untouched — the
 * same shape the `UserId` move took.
 *
 * ---------------------------------------------------------------------------
 * SAME UNDERLYING VALUE AS {@link SessionId} FOR PODIUM AGENTS (POD-1164)
 * ---------------------------------------------------------------------------
 *
 * The brands distinguish ROLE, not a second mint namespace. Axis 1 of
 * `docs/session-binding-identity.md` names the work (`SessionId`); axis 2 names
 * the actor. For a Podium agent session the actor *is* "this session as an
 * actor", and the sole production mint is
 * `asAgentIdentityId(sessionId)` at every spawn / receipt path in
 * `apps/daemon/src/binding-store.ts`. Convert with
 * {@link agentIdentityFromSessionId} / {@link sessionIdFromAgentIdentity} —
 * never invent a second id, never substitute a harness-native `agent_id`.
 *
 * `Capability.actorSessionId` holds the {@link SessionId} spelling of this same
 * value (every consumer walks sessions, stamps `started_by_session`, or builds
 * `session:` keys). `Principal.agentIdentity` holds the `AgentIdentityId`
 * spelling; `capabilityFromPrincipal` converts with the helper below.
 *
 * NOT the harness hook-channel `agent_id` on SubagentStart / SubagentStop.
 * That is a HARNESS-native id (`NativeSubagent.id` in `entities/session.ts`)
 * and stays deliberately unbranded (see this file's header, "NOT BRANDED").
 * An earlier comment on this brand claimed otherwise; that claim described a
 * doc path, not the live mint, and was retired by POD-1164.
 *
 * NOT the delegation shape. `(agentIdentity, onBehalfOf, scope)` — the agent
 * principal itself — lives in `identity/delegation.ts`; this is the id it is
 * keyed by.
 */
export const AgentIdentityId = z.string().min(1).brand<'AgentIdentityId'>()
export type AgentIdentityId = z.infer<typeof AgentIdentityId>
export const AgentIdentityIdField = idField<'AgentIdentityId'>()
export const asAgentIdentityId = (s: string): AgentIdentityId => s as AgentIdentityId

/**
 * Brand reclassification: a Podium agent session's work id as its actor id.
 *
 * POD-1164: same underlying string (minted once as {@link SessionId}, re-branded
 * at the binding store). This is NOT a lookup and NOT a mapping table — it is
 * the named form of `asAgentIdentityId(sessionId)` so call sites cannot invent a
 * second id space by accident.
 */
export const agentIdentityFromSessionId = (id: SessionId): AgentIdentityId => asAgentIdentityId(id)

/**
 * Brand reclassification: a Podium agent actor id as the session it names.
 *
 * Inverse of {@link agentIdentityFromSessionId}. Safe only for values that came
 * from a Podium agent mint (the live producer); a harness-native `agent_id`
 * must never be passed here.
 */
export const sessionIdFromAgentIdentity = (id: AgentIdentityId): SessionId => asSessionId(id)

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

// Shipping aggregate family. These are independently addressable durable rows,
// not issue ids wearing a prefix; each gets the validating/field schema pair
// every Podium-minted entity identity uses.
export const ShipOrderId = z.string().min(1).brand<'ShipOrderId'>()
export type ShipOrderId = z.infer<typeof ShipOrderId>
export const ShipOrderIdField = idField<'ShipOrderId'>()
export const asShipOrderId = (s: string): ShipOrderId => s as ShipOrderId

export const ShipAttemptId = z.string().min(1).brand<'ShipAttemptId'>()
export type ShipAttemptId = z.infer<typeof ShipAttemptId>
export const ShipAttemptIdField = idField<'ShipAttemptId'>()
export const asShipAttemptId = (s: string): ShipAttemptId => s as ShipAttemptId

export const ShipTrainId = z.string().min(1).brand<'ShipTrainId'>()
export type ShipTrainId = z.infer<typeof ShipTrainId>
export const ShipTrainIdField = idField<'ShipTrainId'>()
export const asShipTrainId = (s: string): ShipTrainId => s as ShipTrainId

export const ShipTrainSubsetId = z.string().min(1).brand<'ShipTrainSubsetId'>()
export type ShipTrainSubsetId = z.infer<typeof ShipTrainSubsetId>
export const ShipTrainSubsetIdField = idField<'ShipTrainSubsetId'>()
export const asShipTrainSubsetId = (s: string): ShipTrainSubsetId => s as ShipTrainSubsetId

export const ShipStepId = z.string().min(1).brand<'ShipStepId'>()
export type ShipStepId = z.infer<typeof ShipStepId>
export const ShipStepIdField = idField<'ShipStepId'>()
export const asShipStepId = (s: string): ShipStepId => s as ShipStepId

export const ShipHoldId = z.string().min(1).brand<'ShipHoldId'>()
export type ShipHoldId = z.infer<typeof ShipHoldId>
export const ShipHoldIdField = idField<'ShipHoldId'>()
export const asShipHoldId = (s: string): ShipHoldId => s as ShipHoldId

export const DeliveryReceiptId = z.string().min(1).brand<'DeliveryReceiptId'>()
export type DeliveryReceiptId = z.infer<typeof DeliveryReceiptId>
export const DeliveryReceiptIdField = idField<'DeliveryReceiptId'>()
export const asDeliveryReceiptId = (s: string): DeliveryReceiptId => s as DeliveryReceiptId

// ---------------------------------------------------------------------------
// Branded KSUIDs — the workspace member family (spec, hosted sign-in §9.1; A1)
// ---------------------------------------------------------------------------
//
// The first brands in this file whose SHAPE is ours to know. Every brand above
// is `z.string().min(1)` because the value's form belongs to whoever mints it —
// a remote daemon's machine id, a harness's conversation id, a pre-existing
// `iss_${randomUUID()}`. These two name rows that do not exist yet, minted only
// by `newMemberId` / `newInviteId` below, so the boundary schema can check the
// whole value: the prefix, the alphabet, the width, and that the body is twenty
// bytes a KSUID mint could have produced. `branded-ksuid.ts` holds that
// mechanism and the reasoning; this is where the two brands live, because a
// brand has one home.
//
// ONE SCHEMA, NOT TWO, AND WHY THAT IS NOT A REGRESSION. This file's header is
// emphatic that a brand ships a validating boundary schema AND a permissive
// `…Field` schema, because every id field in `entities/` was a bare
// `z.string()` and tightening one turns a payload that parses today into a parse
// failure. That argument is about fields that ALREADY PARSE. `mem_` and `inv_`
// fields do not exist yet — A2 adds the member column, A4 adds
// `member_invites` — so there is no such payload, and a permissive field schema
// here would only be an invitation to bind the unchecked one at the very fields
// the prefix exists to protect. `MemberIdField` is therefore the same schema as
// `MemberId`, named so a schema author reaching for the usual spelling cannot
// pick the wrong one. `brands.test.ts` pins it, with the rule it departs from
// still holding next door.

/** §9.1: the workspace member — the row in the OSS `users` table. */
export const MEMBER_ID_PREFIX = ID_PREFIXES.member
export const MemberId = brandedIdSchema(MEMBER_ID_PREFIX).brand<'MemberId'>()
export type MemberId = z.infer<typeof MemberId>
/** The same schema as {@link MemberId} — see the section note above. */
export const MemberIdField = MemberId
export const asMemberId = (s: string): MemberId => s as MemberId
/** Mint one. `at` defaults to now; it is a parameter so tests can be ordered. */
export const newMemberId = (at?: Instant): MemberId =>
  asMemberId(mintBrandedId(MEMBER_ID_PREFIX, at))

/** §9.1: a workspace invite — `member_invites`, the A4 invite-and-claim row. */
export const INVITE_ID_PREFIX = ID_PREFIXES.invite
export const InviteId = brandedIdSchema(INVITE_ID_PREFIX).brand<'InviteId'>()
export type InviteId = z.infer<typeof InviteId>
/** The same schema as {@link InviteId} — see the section note above. */
export const InviteIdField = InviteId
export const asInviteId = (s: string): InviteId => s as InviteId
/** Mint one. Not a secret: an invite's secret is its hashed token (A4). */
export const newInviteId = (at?: Instant): InviteId =>
  asInviteId(mintBrandedId(INVITE_ID_PREFIX, at))

/**
 * Brand widening: a workspace member id as the {@link UserId} the codebase
 * already carries for that row.
 *
 * {@link MemberId} and {@link UserId} name THE SAME ROWS — the OSS `users`
 * table is the workspace member table (§3) — and A2's migration is what gives
 * those rows `mem_` ids. `UserId` is not tightened to this shape and must not
 * be: it is adopted across the codebase over a column that still holds
 * pre-migration values, and `.min(1)` → prefix-checked would be exactly the
 * behaviour change in type-change clothing this file's header exists to stop.
 * So the two are bridged, on the {@link agentIdentityFromSessionId} precedent:
 * one minted string, two brands, one named conversion each way.
 *
 * This direction is a plain cast, because every `mem_` id satisfies `UserId`.
 */
export const userIdFromMemberId = (id: MemberId): UserId => asUserId(id)

/**
 * Brand narrowing: a {@link UserId} as a {@link MemberId} — and the asymmetry
 * with {@link userIdFromMemberId}. This one PARSES, and throws when the value is
 * not a branded member id.
 *
 * A cast here would launder the very values A2 exists to retire: `user:sole` and
 * every pre-migration row id would come back as something the type system swore
 * was a branded KSUID. That is the {@link MachineId} sentinel argument in this
 * file's header, pointed at the solo user — and the reason this is not the
 * mirror image of the widening above.
 */
export const memberIdFromUserId = (id: UserId): MemberId => MemberId.parse(id)
