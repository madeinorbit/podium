/**
 * `@podium/agent-runtime/metadata` — THE OPEN ENTRYPOINT.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS IS FOR
 * ---------------------------------------------------------------------------
 *
 * Importing `@podium/agent-runtime` means taking a HOST CAPABILITY: the drivers
 * behind the contract spawn PTYs, harness server processes and SDK worker
 * children. The architecture manifest restricts that package's consumers to the
 * machine host (`apps/daemon`) and the build tier, and `manifest-consumers`
 * enforces it.
 *
 * But `apps/server` genuinely needs part of this package and never wanted the
 * capability. It projects RuntimeEvents onto the wire, stores PendingInteractions,
 * renders a session's driver and family on a card, and decides whether an
 * `unverified` receipt is a permitted outcome for the family that produced it.
 * All of that is DESCRIPTION. None of it is an action on a host.
 *
 * Same shape and same enforcement as `@podium/harness/metadata`: there is no
 * `export *` here and there may never be one — `manifest-open-entrypoint`
 * (scripts/check-boundaries.ts) fails the build on a star re-export, on an
 * export whose name matches the process-driving vocabulary
 * (launch/spawn/exec/attach/kill/send/resume/start/stop…), and on a direct
 * import of a process API. An explicit named list cannot widen without somebody
 * editing this file, which is exactly the review checkpoint the exception exists
 * to force.
 *
 * ---------------------------------------------------------------------------
 * WHAT IS DELIBERATELY ABSENT
 * ---------------------------------------------------------------------------
 *
 * `RuntimeDriver` and `AgentSessionHandle` — the two BEHAVIORAL interfaces — are
 * not re-exported, even though they are types and would erase to nothing. They
 * describe how to act on a session, and a server file that finds itself wanting
 * one has almost certainly reached past its layer: what it wants is a wire frame
 * (`@podium/protocol`'s `runtime` family) or a projection of one. Keeping them
 * out makes that mistake visible at the import rather than three files later.
 */

// ---- The taxonomy: families, driver ids, tiers -----------------------------

// ---- The value types the server projects -----------------------------------
// Types only: erased at build, carrying nothing at all, and listed by name
// rather than starred for the same reason as everything above.
export type {
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
  SessionArchive,
  SessionBinding,
  SessionHealth,
  SessionLease,
  SessionSnapshot,
  TranscriptItemDelta,
  TurnDelivery,
  TurnEvent,
  TurnFailureReason,
  TurnReceipt,
  UsageSnapshot,
  WatchLevel,
} from './contract.js'
export { DRIVER_IDS } from './contract.js'
export type { PermittedFailure } from './permitted-failures.js'

// ---- What each family is permitted to fail ---------------------------------
// The server reads this to decide whether a weak outcome is a bug worth
// surfacing or a declared property of the family that produced it.
export { PERMITTED_FAILURES, permits } from './permitted-failures.js'
// ---- The wire projection ---------------------------------------------------
// Pure zod: the server parses and re-serializes these at its boundary.
export {
  AttachEndpointSchema,
  CausalEnvelopeSchema,
  DriverFamilySchema,
  DriverIdSchema,
  ExitClassificationSchema,
  FailureDispositionSchema,
  InputOriginSchema,
  InteractionAnswerabilitySchema,
  InteractionEventSchema,
  InteractionKindSchema,
  InteractionSourceSchema,
  PendingInteractionSchema,
  ProcessEventSchema,
  ProcessIdentitySchema,
  RefusalReasonSchema,
  RefusalSchema,
  SendProofSchema,
  SessionBindingSchema,
  SessionHealthSchema,
  SessionLeaseSchema,
  TerminalStreamRefSchema,
  TurnDeliverySchema,
  TurnEventSchema,
  TurnFailureReasonSchema,
  TurnReceiptSchema,
  UsageSnapshotSchema,
} from './schemas.js'
export type { RuntimePrimitive, RuntimeTier } from './tiers.js'
export {
  CORE_PRIMITIVES,
  EXTENDED_PRIMITIVES,
  RUNTIME_PRIMITIVE_TIER,
  tierOf,
} from './tiers.js'
