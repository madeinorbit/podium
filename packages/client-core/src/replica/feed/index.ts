/**
 * THE CLIENT'S WIRE-v2 FEED CONSUMER (POD-376).
 *
 * Four small modules, and the split is the design rather than tidiness:
 *
 *   `frames.ts`            wire shape → kernel shape. A mapping, field by field,
 *                          so a new required field on either side fails to
 *                          compile instead of arriving as `undefined`.
 *   `bootstrap-source.ts`  the push/pull seam. The server pushes worlds; the
 *                          kernel Replica pulls them. This holds the waiting,
 *                          staleness and timeout rules that reconcile the two.
 *   `authority-client.ts`  `AuthorityReadPort` over the v2 catch-up query.
 *   `sink.ts`              the transport's `FeedSinkPort`: frames in, replica
 *                          inputs out, and nothing decided on the way.
 *
 * WHAT IS NOT HERE: storage, the outbox, the engine's read model, and every
 * policy question. The kernel Replica owns the ladder, `@podium/sync/adapters/
 * indexeddb` owns durability, and POD-377's store-neutral client Replica facade
 * owns the shape the engine consumes. This directory is only the feed.
 */

export {
  BOOTSTRAP_CHUNK_TIMEOUT_MS,
  PushedBootstrapSource,
  type BootstrapSourceDeps,
} from './bootstrap-source'
export {
  FeedAuthorityClient,
  type FeedAuthorityClientDeps,
  type FeedChangesSinceReplyLenient,
} from './authority-client'
export { toBootstrapChunk, toDeltaFrame, toRescopeFrame, toResyncFrame } from './frames'
export {
  explainReplicaMode,
  resolveReplicaMode,
  type AdvertisedGrade,
  type ReplicaMode,
  type ReplicaModeReason,
  type ReplicaPath,
  type ResolveReplicaModeInput,
} from './mode'
export { FeedSink, type FeedSinkDeps } from './sink'
