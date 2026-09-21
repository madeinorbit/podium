/**
 * `@podium/harness/driver` — THE DRIVER CONTRACT ENTRY (POD-4469).
 *
 * Everything the server (or any non-host consumer) may take from the driver
 * contract: the taxonomy and tier boundary, the value types it projects onto
 * the wire, the permitted-failures table, the wire schemas and the headless
 * receipt facts. Types and pure values only — no `RuntimeDriver`, no
 * `AgentSessionHandle`, no family: those act on a host and live behind
 * `@podium/harness/driver/host`, which the architecture manifest restricts to
 * the machine host (`apps/daemon`) and the build tier.
 *
 * Same shape and same enforcement as `@podium/harness/metadata` (and
 * `@podium/agent-runtime/metadata` before the dissolve): there is no
 * `export *` here and there may never be one — `manifest-open-entrypoint`
 * (scripts/check-boundaries.ts) fails the build on a star re-export, on an
 * export whose name matches the process-driving vocabulary, and on a direct
 * import of a process API. An explicit named list cannot widen without somebody
 * editing this file, which is exactly the review checkpoint the exception
 * exists to force.
 */

// ---- The taxonomy and the tier boundary ------------------------------------

// ---- The value types the server projects -----------------------------------
// Types only: erased at build, carrying nothing at all, and listed by name
// rather than starred for the same reason as everything above.
export type { AttachEndpoint, SessionLease } from './driver/attach.js'
export type {
  ProcessIdentity,
  SessionArchive,
  SessionBinding,
  SessionSnapshot,
} from './driver/binding.js'
export type { SessionHealth, UsageSnapshot } from './driver/capabilities.js'
export type {
  ExitClassification,
  FailureDisposition,
  ProcessEvent,
  TurnEvent,
  TurnFailureReason,
} from './driver/errors.js'
export type {
  CausalEnvelope,
  RuntimeEvent,
  TranscriptItemDelta,
  WatchLevel,
} from './driver/events.js'
export type { AcceptedDriverId, DriverFamily, DriverId } from './driver/families.js'
export type {
  ElicitationAnswer,
  ElicitationAsk,
  InteractionAnswer,
  InteractionAnswerability,
  InteractionAnswerOutcome,
  InteractionEvent,
  InteractionKind,
  InteractionSource,
  LoginAnswer,
  LoginAsk,
  PendingInteraction,
  PermissionAnswer,
  PermissionAsk,
  PlanApprovalAnswer,
  PlanApprovalAsk,
  QuestionAnswer,
  QuestionAsk,
  QuestionOption,
  QuestionPrompt,
  QuestionSelection,
  RecoveryAnswer,
  RecoveryAsk,
  RecoveryChoice,
} from './driver/interactions.js'
export type { PermittedFailure } from './driver/permitted-failures.js'
export { PERMITTED_FAILURES, permits } from './driver/permitted-failures.js'
export {
  CausalEnvelopeSchema,
  ExitClassificationSchema,
  FailureDispositionSchema,
  InputOriginSchema,
  InteractionAnswerabilitySchema,
  InteractionAnswerOutcomeSchema,
  InteractionEventSchema,
  InteractionKindSchema,
  InteractionSourceSchema,
  PendingInteractionSchema,
  ProcessEventSchema,
  RefusalReasonSchema,
  RefusalSchema,
  RUNTIME_FRAME_TYPES,
  SendProofSchema,
  TranscriptItemDeltaSchema,
  TurnDeliverySchema,
  TurnEventSchema,
  TurnFailureReasonSchema,
  TurnReceiptSchema,
} from './driver/schemas.js'
export type { RuntimePrimitive, RuntimeTier } from './driver/tiers.js'
export {
  CORE_PRIMITIVES,
  EXTENDED_PRIMITIVES,
  RUNTIME_PRIMITIVE_TIER,
  tierOf,
} from './driver/tiers.js'
export type {
  InputOrigin,
  Refusal,
  RefusalReason,
  SendProof,
  TurnDelivery,
  TurnReceipt,
} from './driver/turns.js'

// ---- The headless receipt facts --------------------------------------------
// The server verifies headless delivery receipts against these without ever
// holding a driver (previously the one barrel import outside the metadata
// surface; the dissolve folds it into the contract entry).
export { canonicalHeadlessContractFacts } from './driver/headless-turn.js'
