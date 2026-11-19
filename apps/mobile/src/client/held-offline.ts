import {
  type AuthStatus,
  canOpenProfileOffline,
  offlineProfileStatus,
  resolveOfflinePrincipal,
  type ServerProfile,
} from '@podium/client-core/accounts'
import {
  inspectPrincipalNamespaces,
  isPrincipalNamespaceMarkerKey,
  parseReplicaNamespaceKey,
  REPLICA_KEY_PREFIX,
} from '@podium/client-core/replica'
import { UserId } from '@podium/model'
import AsyncStorage from '@react-native-async-storage/async-storage'
import { Platform } from 'react-native'

/** The slice of AsyncStorage this reads; a fake in tests. */
export interface HeldOfflineStorage {
  getAllKeys(): Promise<readonly string[]>
  multiGet(keys: readonly string[]): Promise<readonly (readonly [string, string | null])[]>
}

/**
 * WHOSE DATA THIS DEVICE HOLDS, ASKED WHEN THE SERVER GAVE NO ANSWER (POD-7176).
 *
 * The phone's gates ask the server first: is the data plane open, and who is
 * signed in. With no network neither question has an answer, and the phone
 * used to stop there with "Cannot reach this Podium server" even though the
 * replica on the device could draw every screen it had already loaded. The
 * desktop web shell falls through to its replica in the same case (SetupGate,
 * `hasSyncedReplica`), and this is the phone's half of that rule.
 *
 * The answer is an identity only when it is unambiguous, and only from what a
 * verified connection wrote earlier, never from a URL or a "last user":
 * - native: the saved profile, when it carries the whole trust boundary a
 *   verified connection recorded (`canOpenProfileOffline`, the same rule the
 *   profile gate uses for an offline start);
 * - web: the replica's principal namespace markers, which a replica writes
 *   only after the server named its member, and EXACTLY ONE of them
 *   (`resolveOfflinePrincipal`, the desktop's rule: two retained members on a
 *   shared browser fail closed).
 *
 * Undefined means the device holds nothing it may open, and the caller keeps
 * its unreachable screen.
 */
export async function heldOfflineStatus(
  profile: ServerProfile | undefined,
  options: { platform?: string; storage?: HeldOfflineStorage } = {},
): Promise<AuthStatus | undefined> {
  const platform = options.platform ?? Platform.OS
  if (platform !== 'web') {
    return profile && canOpenProfileOffline(profile, 'unreachable')
      ? offlineProfileStatus(profile)
      : undefined
  }
  try {
    const storage = options.storage ?? AsyncStorage
    const keys = (await storage.getAllKeys()).filter((key) =>
      isPrincipalNamespaceMarkerKey(REPLICA_KEY_PREFIX, key),
    )
    const markers = new Map(await storage.multiGet(keys))
    const principal = resolveOfflinePrincipal(
      inspectPrincipalNamespaces({
        storage: {
          getItem: (key) => markers.get(key) ?? null,
          setItem: () => {},
          removeItem: () => {},
        },
        enumerateKeys: () => [...keys],
        basePrefix: REPLICA_KEY_PREFIX,
      }),
    )
    const identity = parseReplicaNamespaceKey(principal)
    if (!identity) return undefined
    return {
      needsAuth: true,
      authed: true,
      userId: UserId.parse(identity.memberId),
      syncBoundaryId: identity.syncBoundaryId,
      memberId: identity.memberId,
    }
  } catch {
    // No readable storage, no marker, or two of them: nothing this may open.
    return undefined
  }
}
