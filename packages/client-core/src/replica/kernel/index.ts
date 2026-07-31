/**
 * The kernel-backed client `Replica` (POD-1228).
 *
 * One barrel for the three modules the composition root needs: the facade
 * itself, the entity↔kind vocabulary it projects through, and the client-side
 * bulk cache that holds what the kernel Replica deliberately does not.
 */

export {
  createKernelReplica,
  type KernelBackedReplica,
  type KernelCacheRead,
  type KernelReplicaInit,
} from './facade'
export { entityForKind, type KernelEntity, kindForEntity, rowKey } from './kinds'
export { createSideCache, type SideCache, type SideCacheInit } from './side-cache'
