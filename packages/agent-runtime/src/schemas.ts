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
 * this package's TypeScript types describe THE SAME THING. A hand-written schema
 * beside a hand-written type is two sources of truth that agree only until
 * somebody edits one of them, and the failure is silent — the schema keeps
 * parsing, the type keeps compiling, and a field quietly stops crossing the
 * wire. The `exact` assertions below make that a COMPILE error instead.
 *
 * WHY THE TYPE IS AUTHORITATIVE AND THE SCHEMA IS CHECKED (the inverse of
 * protocol's usual infer-from-zod direction, on purpose): the contract's types
 * reference `Declared<T>` and `AgentStateEvent` from `@podium/harness`, whose
 * family carries functions elsewhere. Inferring the contract from zod would push
 * those through a lossy round-trip. So the surface is defined as TypeScript and
 * the wire is proved equal to it, arm by arm.
 *
 * ---------------------------------------------------------------------------
 * WHAT HAS NO SCHEMA IN W1, AND WHY THAT IS NOT AN OVERSIGHT
 * ---------------------------------------------------------------------------
 *
 * `AttachEndpoint`, `SessionLease`, `SessionHealth` and `UsageSnapshot` are
 * contract TYPES with no wire schema yet. A schema nothing can produce is a
 * promise to a client this build cannot keep. They get schemas — and these
 * assertions — in the item that gives them a producer.
 *
 * `SessionBinding` and `SessionSnapshot` GOT one in POD-2023 (W5), because the
 * snapshot frame produces them, and their guards are at the bottom of this
 * file. Two of their fields are deliberately WIDER on the wire, for the same
 * directional reason as `RuntimeEvent.change`, so they are asserted with the
 * weaker `encodes` claim rather than `exact`; the note there names both.
 *
 * THE ONE DELIBERATE DIVERGENCE among what IS projected: `RuntimeEvent.change`
 * is an open record on the wire, because `AgentStateEvent` is defined in
 * `@podium/harness`, ABOVE protocol — the same directional constraint that put
 * these schemas in protocol to begin with. It is asserted below in the weaker
 * direction, which is the true one.
 */

import type { z } from 'zod'
import type {
  ExitClassification,
  FailureDisposition,
  ProcessEvent,
  TurnEvent,
  TurnFailureReason,
} from './errors.js'
import type { SessionBinding, SessionSnapshot } from './binding.js'
import type { CausalEnvelope, RuntimeEvent, TranscriptItemDelta } from './events.js'
import type {
  InteractionAnswerability,
  InteractionAnswerOutcome,
  InteractionEvent,
  InteractionKind,
  InteractionSource,
  PendingInteraction,
} from './interactions.js'
import type {
  InputOrigin,
  Refusal,
  RefusalReason,
  SendProof,
  TurnDelivery,
  TurnReceipt,
} from './turns.js'

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
  InteractionAnswerability as InteractionAnswerabilitySchema,
  InteractionAnswerOutcome as InteractionAnswerOutcomeSchema,
  InteractionEvent as InteractionEventSchema,
  InteractionKind as InteractionKindSchema,
  InteractionSource as InteractionSourceSchema,
  ObservationInputOrigin as InputOriginSchema,
  PendingInteraction as PendingInteractionSchema,
} from '@podium/protocol'
export {
  TurnFailureReason as TurnFailureReasonSchema,
} from '@podium/protocol/daemon'
export {
  CausalEnvelope as CausalEnvelopeSchema,
  ExitClassification as ExitClassificationSchema,
  FailureDisposition as FailureDispositionSchema,
  ProcessEvent as ProcessEventSchema,
  Refusal as RefusalSchema,
  RefusalReason as RefusalReasonSchema,
  RUNTIME_FRAME_TYPES,
  RuntimeCommandMessage as RuntimeCommandMessageSchema,
  RuntimeDaemonMessage as RuntimeDaemonMessageSchema,
  RuntimeEvent as RuntimeEventSchema,
  RuntimeEventBody as RuntimeEventBodySchema,
  RuntimeMessage as RuntimeMessageSchema,
  SendProof as SendProofSchema,
  SessionBinding as SessionBindingSchema,
  SessionSnapshot as SessionSnapshotSchema,
  TranscriptItemDelta as TranscriptItemDeltaSchema,
  TurnDelivery as TurnDeliverySchema,
  TurnEvent as TurnEventSchema,
  TurnReceipt as TurnReceiptSchema,
} from '@podium/protocol/daemon'

import type {
  InteractionAnswerability as InteractionAnswerabilityWire,
  InteractionAnswerOutcome as InteractionAnswerOutcomeWire,
  InteractionEvent as InteractionEventWire,
  InteractionKind as InteractionKindWire,
  InteractionSource as InteractionSourceWire,
  ObservationInputOrigin,
  PendingInteraction as PendingInteractionWire,
} from '@podium/protocol'
import type {
  TurnFailureReason as TurnFailureReasonWire,
} from '@podium/protocol/daemon'
import type {
  CausalEnvelope as CausalEnvelopeWire,
  ExitClassification as ExitClassificationWire,
  FailureDisposition as FailureDispositionWire,
  ProcessEvent as ProcessEventWire,
  RefusalReason as RefusalReasonWire,
  Refusal as RefusalWire,
  RuntimeEvent as RuntimeEventWire,
  SendProof as SendProofWire,
  SessionBinding as SessionBindingWire,
  SessionSnapshot as SessionSnapshotWire,
  TranscriptItemDelta as TranscriptItemDeltaWire,
  TurnDelivery as TurnDeliveryWire,
  TurnEvent as TurnEventWire,
  TurnReceipt as TurnReceiptWire,
} from '@podium/protocol/daemon'

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
// THE LAST UNGUARDED INTERACTION SCHEMA (POD-2019's review named it; POD-2020
// closes it). Every sibling above had a guard and this one did not, which is
// exactly the asymmetry that lets a union arm drift: `InteractionEvent` carries
// the asked/answered/expired lifecycle, so an arm added on one side and not the
// other would stop an event crossing the wire with no compile error anywhere.
exact<z.infer<typeof InteractionEventWire>, InteractionEvent>(true)
exact<z.infer<typeof ProcessEventWire>, ProcessEvent>(true)
exact<z.infer<typeof TranscriptItemDeltaWire>, TranscriptItemDelta>(true)

// See the header: the wire's `change` is an open record because `AgentStateEvent`
// lives above protocol. The weaker claim is the true one — every event the
// contract admits still encodes.
encodes<RuntimeEvent, z.infer<typeof RuntimeEventWire>>(true)

// ---------------------------------------------------------------------------
// The identity pair (POD-2023 W5 — the snapshot frame's payloads)
// ---------------------------------------------------------------------------

/**
 * `SessionBinding` and `SessionSnapshot`, asserted the honest way.
 *
 * `encodes` RATHER THAN `exact`, and the two reasons are the same one twice:
 * a field whose type is defined ABOVE protocol cannot be named by a protocol
 * schema, so the wire widens it and the true claim is one-directional.
 *
 *   - `SessionBinding.driver` is `DriverId` — a closed union in
 *     `@podium/harness`, which protocol sits below. The wire carries
 *     `z.string().min(1)`.
 *   - `SessionSnapshot.state` is `AgentRuntimeState` from `@podium/model`, and
 *     is an open record on the wire for exactly the reason
 *     `RuntimeEventBody.change` is.
 *
 * Everything else lines up field for field, and the guard is what says so — it
 * already earned its place by catching one real asymmetry the moment it was
 * written: the wire had `observerGeneration: positive()` where the contract type
 * is a bare `number`, so a snapshot at generation 0 would have failed to parse.
 * The wire now says `nonnegative()`.
 *
 * The DIRECTION asserted is the one that matters for a producer: every value the
 * contract can hand to the frame must be a value the wire accepts.
 */
encodes<SessionBinding, z.infer<typeof SessionBindingWire>>(true)
encodes<SessionSnapshot, z.infer<typeof SessionSnapshotWire>>(true)
