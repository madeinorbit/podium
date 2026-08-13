/**
 * THE CONTRACT'S WIRE PROJECTION, AND THE DRIFT GUARD THAT KEEPS IT HONEST.
 *
 * ---------------------------------------------------------------------------
 * ONE DEFINITION SITE
 * ---------------------------------------------------------------------------
 *
 * The zod schemas themselves live in `@podium/protocol`'s `runtime` message
 * family, NOT here. The reason is directional: this package is L2 and depends on
 * protocol, so a consumer that only needs to PARSE a runtime frame — the server,
 * the clients, the CLI — must be able to reach the schema without importing a
 * package whose consumers are restricted to the machine host.
 *
 * What lives here is the other half of the bargain: proof that those schemas and
 * `./contract.ts`'s TypeScript types describe THE SAME THING. A hand-written
 * schema beside a hand-written type is two sources of truth that agree only
 * until somebody edits one of them, and the failure is silent — the schema keeps
 * parsing, the type keeps compiling, and a field quietly stops crossing the
 * wire. The `exact` assertions at the bottom make that a COMPILE error instead.
 *
 * WHY THE TYPE IS AUTHORITATIVE AND THE SCHEMA IS CHECKED (the inverse of
 * protocol's usual infer-from-zod direction, on purpose): the contract's types
 * reference `Declared<T>` and `AgentStateEvent` from `@podium/harness`, whose
 * family carries functions elsewhere. Inferring the contract from zod would push
 * those through a lossy round-trip. So the surface is defined as TypeScript and
 * the wire is proved equal to it, arm by arm.
 *
 * ONE PLACE THEY DELIBERATELY DIVERGE, and it is asserted below in the weaker
 * direction rather than not at all: `RuntimeEvent.change` and
 * `SessionSnapshot.state` are open records on the wire, because
 * `AgentStateEvent` and `AgentRuntimeState` are defined in `@podium/harness` and
 * `@podium/model`-adjacent code ABOVE protocol. This package re-narrows them at
 * its own boundary, where that import is legal.
 */

import type { z } from 'zod'
import type {
  AttachEndpoint,
  CausalEnvelope,
  DriverFamily,
  DriverId,
  ExitClassification,
  FailureDisposition,
  InputOrigin,
  InteractionAnswerability,
  InteractionAnswerOutcome,
  InteractionKind,
  InteractionSource,
  PendingInteraction,
  ProcessEvent,
  ProcessIdentity,
  Refusal,
  RefusalReason,
  RuntimeEvent,
  SendProof,
  SessionBinding,
  SessionHealth,
  SessionLease,
  TerminalStreamRef,
  TranscriptItemDelta,
  TurnDelivery,
  TurnEvent,
  TurnFailureReason,
  TurnReceipt,
  UsageSnapshot,
} from './contract.js'

// ---------------------------------------------------------------------------
// Re-export the wire schemas at this package's boundary
// ---------------------------------------------------------------------------

/**
 * Re-exported under `*Schema` names so a driver can write `TurnReceiptSchema`
 * beside the `TurnReceipt` TYPE without the two colliding. The originals keep
 * their bare names in `@podium/protocol`, where zod-schema-and-type-share-a-name
 * is the house style.
 */
export {
  AttachEndpoint as AttachEndpointSchema,
  CausalEnvelope as CausalEnvelopeSchema,
  DriverFamily as DriverFamilySchema,
  DriverId as DriverIdSchema,
  ExitClassification as ExitClassificationSchema,
  FailureDisposition as FailureDispositionSchema,
  InteractionAnswerability as InteractionAnswerabilitySchema,
  InteractionAnswerOutcome as InteractionAnswerOutcomeSchema,
  InteractionEvent as InteractionEventSchema,
  InteractionKind as InteractionKindSchema,
  InteractionSource as InteractionSourceSchema,
  ObservationInputOrigin as InputOriginSchema,
  PendingInteraction as PendingInteractionSchema,
  ProcessEvent as ProcessEventSchema,
  ProcessIdentity as ProcessIdentitySchema,
  Refusal as RefusalSchema,
  RefusalReason as RefusalReasonSchema,
  RUNTIME_FRAME_TYPES,
  RuntimeCommandMessage as RuntimeCommandMessageSchema,
  RuntimeEvent as RuntimeEventSchema,
  RuntimeEventBody as RuntimeEventBodySchema,
  RuntimeEventMessage as RuntimeEventMessageSchema,
  RuntimeMessage as RuntimeMessageSchema,
  SendProof as SendProofSchema,
  SessionBinding as SessionBindingSchema,
  SessionHealth as SessionHealthSchema,
  SessionLease as SessionLeaseSchema,
  SessionSnapshot as SessionSnapshotSchema,
  TerminalStreamRef as TerminalStreamRefSchema,
  TranscriptItemDelta as TranscriptItemDeltaSchema,
  TurnDelivery as TurnDeliverySchema,
  TurnEvent as TurnEventSchema,
  TurnFailureReason as TurnFailureReasonSchema,
  TurnReceipt as TurnReceiptSchema,
  UsageSnapshot as UsageSnapshotSchema,
} from '@podium/protocol'

import type {
  AttachEndpoint as AttachEndpointWire,
  CausalEnvelope as CausalEnvelopeWire,
  DriverFamily as DriverFamilyWire,
  DriverId as DriverIdWire,
  ExitClassification as ExitClassificationWire,
  FailureDisposition as FailureDispositionWire,
  InteractionAnswerability as InteractionAnswerabilityWire,
  InteractionAnswerOutcome as InteractionAnswerOutcomeWire,
  InteractionKind as InteractionKindWire,
  InteractionSource as InteractionSourceWire,
  ObservationInputOrigin,
  PendingInteraction as PendingInteractionWire,
  ProcessEvent as ProcessEventWire,
  ProcessIdentity as ProcessIdentityWire,
  RefusalReason as RefusalReasonWire,
  Refusal as RefusalWire,
  RuntimeEvent as RuntimeEventWire,
  SendProof as SendProofWire,
  SessionBinding as SessionBindingWire,
  SessionHealth as SessionHealthWire,
  SessionLease as SessionLeaseWire,
  TerminalStreamRef as TerminalStreamRefWire,
  TranscriptItemDelta as TranscriptItemDeltaWire,
  TurnDelivery as TurnDeliveryWire,
  TurnEvent as TurnEventWire,
  TurnFailureReason as TurnFailureReasonWire,
  TurnReceipt as TurnReceiptWire,
  UsageSnapshot as UsageSnapshotWire,
} from '@podium/protocol'

// ---------------------------------------------------------------------------
// The drift guard
// ---------------------------------------------------------------------------

/**
 * Asserts a schema's inferred output is EXACTLY the contract type — not merely
 * assignable one way, which would let the schema drop an optional field or widen
 * an enum without anybody noticing.
 */
type Exact<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false
const exact = <A, B>(_proof: Exact<A, B>): void => {}

/** The weaker claim, used only where the wire is deliberately WIDER than the
 *  type: every value the type admits must still be a value the wire accepts. */
const encodes = <A, B>(_proof: [A] extends [B] ? true : false): void => {}

exact<z.infer<typeof DriverFamilyWire>, DriverFamily>(true)
exact<z.infer<typeof DriverIdWire>, DriverId>(true)
exact<z.infer<typeof TurnDeliveryWire>, TurnDelivery>(true)
exact<z.infer<typeof ObservationInputOrigin>, InputOrigin>(true)
exact<z.infer<typeof SendProofWire>, SendProof>(true)
exact<z.infer<typeof RefusalReasonWire>, RefusalReason>(true)
exact<z.infer<typeof RefusalWire>, Refusal>(true)
exact<z.infer<typeof InteractionKindWire>, InteractionKind>(true)
exact<z.infer<typeof InteractionSourceWire>, InteractionSource>(true)
exact<z.infer<typeof InteractionAnswerabilityWire>, InteractionAnswerability>(true)
exact<z.infer<typeof InteractionAnswerOutcomeWire>, InteractionAnswerOutcome>(true)
exact<z.infer<typeof TurnFailureReasonWire>, TurnFailureReason>(true)
exact<z.infer<typeof FailureDispositionWire>, FailureDisposition>(true)
exact<z.infer<typeof ExitClassificationWire>, ExitClassification>(true)
exact<z.infer<typeof CausalEnvelopeWire>, CausalEnvelope>(true)
exact<z.infer<typeof TurnReceiptWire>, TurnReceipt>(true)
exact<z.infer<typeof TurnEventWire>, TurnEvent>(true)
exact<z.infer<typeof PendingInteractionWire>, PendingInteraction>(true)
exact<z.infer<typeof ProcessEventWire>, ProcessEvent>(true)
exact<z.infer<typeof ProcessIdentityWire>, ProcessIdentity>(true)
exact<z.infer<typeof SessionBindingWire>, SessionBinding>(true)
exact<z.infer<typeof TerminalStreamRefWire>, TerminalStreamRef>(true)
exact<z.infer<typeof SessionLeaseWire>, SessionLease>(true)
exact<z.infer<typeof SessionHealthWire>, SessionHealth>(true)
exact<z.infer<typeof UsageSnapshotWire>, UsageSnapshot>(true)
exact<z.infer<typeof TranscriptItemDeltaWire>, TranscriptItemDelta>(true)

// `AttachEndpoint` is exact: the spec's reserved `user-local` and `handover`
// variants are deliberately NOT arms of this union — they are separate types, so
// that adding one later is an edit somebody makes on purpose rather than a
// widening the wire silently already allowed.
exact<z.infer<typeof AttachEndpointWire>, AttachEndpoint>(true)

// THE ONE DELIBERATE DIVERGENCE, asserted in the direction that still holds.
// `RuntimeEvent`'s `change` is an open record on the wire because
// `AgentStateEvent` is defined in `@podium/harness`, ABOVE protocol — the same
// directional constraint that put these schemas in protocol to begin with. The
// weaker claim is the true one: every event the contract admits still encodes.
encodes<RuntimeEvent, z.infer<typeof RuntimeEventWire>>(true)
