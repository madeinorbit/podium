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
 * `SessionBinding`, `SessionSnapshot`, `AttachEndpoint`, `SessionLease`,
 * `SessionHealth` and `UsageSnapshot` are contract TYPES with no wire schema
 * yet. Their first producer is W3 (the terminal driver) or W5 (attach
 * negotiation), and a schema nothing can produce is a promise to a client this
 * build cannot keep. They get schemas — and these assertions — in the item that
 * gives them a producer.
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
import type { CausalEnvelope, RuntimeEvent, TranscriptItemDelta } from './events.js'
import type {
  InteractionAnswerability,
  InteractionAnswerOutcome,
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
  CausalEnvelope as CausalEnvelopeSchema,
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
  Refusal as RefusalSchema,
  RefusalReason as RefusalReasonSchema,
  RUNTIME_FRAME_TYPES,
  RuntimeCommandMessage as RuntimeCommandMessageSchema,
  RuntimeDaemonMessage as RuntimeDaemonMessageSchema,
  RuntimeEvent as RuntimeEventSchema,
  RuntimeEventBody as RuntimeEventBodySchema,
  RuntimeMessage as RuntimeMessageSchema,
  SendProof as SendProofSchema,
  TranscriptItemDelta as TranscriptItemDeltaSchema,
  TurnDelivery as TurnDeliverySchema,
  TurnEvent as TurnEventSchema,
  TurnFailureReason as TurnFailureReasonSchema,
  TurnReceipt as TurnReceiptSchema,
} from '@podium/protocol'

import type {
  CausalEnvelope as CausalEnvelopeWire,
  ExitClassification as ExitClassificationWire,
  FailureDisposition as FailureDispositionWire,
  InteractionAnswerability as InteractionAnswerabilityWire,
  InteractionAnswerOutcome as InteractionAnswerOutcomeWire,
  InteractionKind as InteractionKindWire,
  InteractionSource as InteractionSourceWire,
  ObservationInputOrigin,
  PendingInteraction as PendingInteractionWire,
  ProcessEvent as ProcessEventWire,
  RefusalReason as RefusalReasonWire,
  Refusal as RefusalWire,
  RuntimeEvent as RuntimeEventWire,
  SendProof as SendProofWire,
  TranscriptItemDelta as TranscriptItemDeltaWire,
  TurnDelivery as TurnDeliveryWire,
  TurnEvent as TurnEventWire,
  TurnFailureReason as TurnFailureReasonWire,
  TurnReceipt as TurnReceiptWire,
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
exact<z.infer<typeof TranscriptItemDeltaWire>, TranscriptItemDelta>(true)

// See the header: the wire's `change` is an open record because `AgentStateEvent`
// lives above protocol. The weaker claim is the true one — every event the
// contract admits still encodes.
encodes<RuntimeEvent, z.infer<typeof RuntimeEventWire>>(true)
