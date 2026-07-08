/**
 * Re-export shim (arch-v2 P3, issue #192): the thin-client replica engine moved
 * to @podium/client-core/replica (platform-neutral, shared with the mobile
 * app; storage adapters — web localStorage, RN AsyncStorage, in-memory — live
 * behind its `ReplicaInit.storage` seam). The React live-query binding lives in
 * @podium/client-core/react. Existing `./replica` imports keep working here.
 */
export * from '@podium/client-core/replica'
export { useReplicaRows } from '@podium/client-core/react'
