/**
 * HAS THIS DEVICE SYNCED BEFORE? — read from durable storage, before any gate.
 *
 * The only pre-app question worth asking about the replica: is there a slice on
 * this device that the boot gate would be able to open with the backend down?
 * `resolveReplicaPrincipal` answers that offline from principal namespace markers
 * and requires EXACTLY ONE — two retained principals fail closed, because picking
 * between them would be local visibility arbitration. This mirrors that rule
 * rather than inventing a looser one: a caller that fell through on "any marker"
 * would trade one error screen for the replica gate's fatal one.
 *
 * It reads markers only; it never writes one, and never creates a "last user" key.
 */

import { inspectPrincipalNamespaces } from '@podium/client-core/replica'
import { KERNEL_SIDE_CACHE_PREFIX } from './kernelReplica'

export function hasSyncedReplica(): boolean {
  try {
    const identities = inspectPrincipalNamespaces({
      storage: globalThis.localStorage,
      enumerateKeys: () => Object.keys(globalThis.localStorage),
      basePrefix: KERNEL_SIDE_CACHE_PREFIX,
    })
    return identities.length === 1
  } catch {
    // No readable storage (private mode, blocked cookies) is no evidence.
    return false
  }
}
