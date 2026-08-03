/**
 * THE FEED — the Authority's outbound half (POD-306).
 *
 * Four of the five items POD-305 re-homed live here: feed identity minting and
 * persistence, the published retention floor, the bounded send queue, and the
 * `resync-required` demotion. The fifth (entity revision columns) is not here,
 * and `../authority/revision.ts` says why.
 *
 * This directory is NOT direction-locked the way `../replica/` is, and the
 * asymmetry is the design: the Replica may reach nothing outside itself because
 * anything it reached for would be a merge policy or an adapter. The publisher
 * legitimately reads the Authority's change vocabulary and the Replica's frame
 * vocabulary, because its whole job is to be the seam between them.
 */

export {
  assertOpaqueEpoch,
  FeedIdentityError,
  FeedIdentityRegistry,
  type EpochBumpCause,
  type FeedIdentity,
  type FeedIdentityStore,
  type OpaqueIdMint,
} from './identity'
export { BoundedSendQueue, type FrameSizer, type SendQueueAdmission, type SendQueueConfig } from './send-queue'
export {
  FeedPublisher,
  type FeedConnection,
  type FeedPublisherDeps,
  type FeedRetentionPort,
} from './publisher'
export {
  DeviceGradeNoAnchors,
  NoDelegationsGranted,
  DeviceGradeUnscopedPolicy,
  DEVICE_GRADE_PRINCIPAL,
  GrantEdgeVisibilityPolicy,
  entityKey,
  humanOf,
  kernelVisibilityResolver,
  keyOfRef,
  type DelegatedScope,
  type DelegationScopePort,
  type EntityKey,
  type EntityRef,
  type FeedScopingGrade,
  type FeedVisibilityPolicy,
  type VisibilityAnchorPort,
  type VisibilityDecision,
  type VisibilityReason,
  type VisibilityStatePort,
} from './visibility'
