/** One host-free context vocabulary for drivers and consumers (POD-6575). */

export type { ContextCapability } from '@podium/model'
export {
  CONTEXT_MAX_DEPTH,
  CONTEXT_MAX_ROWS,
  ContextAvailability,
  ContextCapacity,
  ContextCausalIdentity,
  ContextCompactionPolicy,
  ContextComposition,
  ContextCompositionRow,
  ContextDetail,
  ContextDetailResult,
  ContextInvalidation,
  ContextInvalidationCause,
  ContextLastRequest,
  ContextModelIdentity,
  ContextOccupancy,
  ContextQuantity,
  ContextReason,
  ContextRevision,
  ContextSampleIdentity,
  ContextSummary,
  contextUsagePercentOf,
  invalidateContextSummary,
  sameContextSample,
} from '@podium/model'
export {
  ContextDetailRequest as ContextDetailRequestSchema,
  ContextObservation as ContextObservationSchema,
  ContextSummaryReadResult as ContextSummaryReadResultSchema,
  ContextSummaryRequest as ContextSummaryRequestSchema,
} from '@podium/protocol/daemon'
export type {
  ContextDetailRequest,
  ContextObservation,
  ContextReader,
  ContextReadOptions,
  ContextSummaryReadResult,
} from '../context-types.js'
