/**
 * The kernel-backed client `Replica` (POD-1228).
 *
 * One barrel for the four modules the composition root needs: the facade
 * itself, the entity↔kind vocabulary it projects through, the client-side
 * bulk cache that holds what the kernel Replica deliberately does not, and the
 * SQLite outbox binding.
 *
 * THE OUTBOX BINDING IS EXPORTED SEPARATELY FROM THE FACADE, and POD-1220 is why
 * that matters rather than being a tidiness point: mobile takes the binding
 * WITHOUT the facade. It is still a wire-v1 peer, `facade.ts` refuses the v1
 * write-in path by design, and a root that could only get the durable outbox by
 * also constructing the facade would have to choose between an unqueued outbox
 * and a replica that throws on the first hub frame.
 */

export {
  createKernelReplica,
  type KernelBackedReplica,
  type KernelCacheRead,
  type KernelReplicaInit,
} from './facade'
export { entityForKind, type KernelEntity, kindForEntity, rowKey } from './kinds'
export { createSideCache, type SideCache, type SideCacheInit } from './side-cache'
export {
  CLIENT_PARTITION,
  type ClientOutboxRecord,
  createKernelOutboxStorage,
  type KernelOutboxStorageInit,
  type KernelOutboxStorages,
} from './sqlite-outbox'
