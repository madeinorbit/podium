/**
 * The kernel-backed client `Replica` (POD-1228).
 *
 * One barrel for the three modules a composition root needs: the facade itself,
 * the entity↔kind vocabulary it projects through, and the client-side bulk cache
 * that holds what the kernel Replica deliberately does not.
 *
 * THERE WAS A FOURTH, AND ITS ABSENCE IS THE POINT (POD-2073). `sqlite-outbox.ts`
 * exported an `OutboxStorage` pair over the kernel outbox rows, so mobile could
 * keep the compatibility `Outbox` state machine while its queue lived durably in
 * SQLite. Both composition roots now run the kernel `Outbox` itself
 * (`openKernelEngineOutbox`), which owns those records, and a second driver over
 * them is exactly the two-writer arrangement `facade.ts`'s header rules out — so
 * the binding was deleted rather than left exported for a caller that no longer
 * exists.
 */

export {
  createKernelReplica,
  type KernelBackedReplica,
  type KernelCacheRead,
  type KernelReplicaInit,
} from './facade'
export { entityForKind, type KernelEntity, kindForEntity, rowKey } from './kinds'
export { createSideCache, type SideCache, type SideCacheInit } from './side-cache'
