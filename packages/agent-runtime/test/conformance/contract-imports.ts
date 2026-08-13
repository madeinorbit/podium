/**
 * ONE import hop from the corpus to the package source.
 *
 * The corpus lives outside `src/` on purpose (it is a product of this package
 * that W3 and W5 consume, not a test of it), so every property file would
 * otherwise carry a `../../src/...` path. Funnelling them through one module
 * keeps those paths in a single place and makes the corpus's dependency on the
 * contract a thing you can read in one file.
 */

export type { SessionId } from '@podium/model'
export type {
  AgentSessionHandle,
  AttachEndpoint,
  DriverCapabilities,
  DriverFamily,
  InteractionKind,
  PendingInteraction,
  ProcessEvent,
  Refusal,
  RuntimeDriver,
  RuntimeEvent,
  SessionSnapshot,
  SessionSpec,
  TurnReceipt,
} from '../../src/contract.js'
export type { PermittedFailure } from '../../src/permitted-failures.js'
export { PERMITTED_FAILURES, permits } from '../../src/permitted-failures.js'
export { CORE_PRIMITIVES, RUNTIME_PRIMITIVE_TIER } from '../../src/tiers.js'
