import { replicaNamespaceKey } from '../replica/principal-storage'
import type { ProfileMetadataStorage } from './storage'

export const SERVER_PROFILES_KEY = 'podium.accounts.server-profiles.v1'
export const PENDING_PROFILE_CLEANUPS_KEY = 'podium.accounts.pending-profile-cleanups.v1'

export type ServerTransport =
  | 'trusted-https'
  | 'tailscale-serve'
  | 'insecure-lan'
  | 'tailscale-http'
  | 'insecure-http'

export interface ServerProfile {
  /** Local profile/credential handle, independent of replica identity. */
  id: string
  name: string
  httpOrigin: string
  instanceId?: string
  /** Immutable hosted workspace identity; never use the mutable slug as storage identity. */
  workspaceId?: string
  mode: 'open' | 'protected'
  transport: ServerTransport
  syncBoundaryId?: string
  memberId?: string
  userId?: string
  createdAt: string
  updatedAt: string
}

/** Identity for process-local data that must not cross a replaced server instance. */
export function serverProfileRequestKey(
  profile: Pick<
    ServerProfile,
    'id' | 'instanceId' | 'userId' | 'workspaceId' | 'syncBoundaryId' | 'memberId'
  >,
): string {
  const key = [
    profile.id,
    profile.userId ?? '',
    profile.instanceId ?? '',
    profile.syncBoundaryId ?? '',
    profile.memberId ?? '',
  ].join('\n')
  return profile.workspaceId ? key + '\n' + profile.workspaceId : key
}

export interface ServerProfileState {
  activeProfileId: string | null
  profiles: ServerProfile[]
}

/**
 * A live preflight may be skipped only for a profile whose local trust boundary
 * was completed by an earlier verified connection. `instanceId` proves the
 * profile has seen Podium at this exact saved origin, while `userId` names the
 * only principal whose replica may open. Other preflight failures remain hard
 * failures because they carry positive evidence of replacement, skew, or an
 * unsafe transport rather than an absence of network evidence.
 */
export function canOpenProfileOffline(
  profile: ServerProfile,
  failureKind:
    | 'not-podium'
    | 'version-mismatch'
    | 'workspace-mismatch'
    | 'tls-untrusted'
    | 'unreachable'
    | 'cleartext-blocked',
): boolean {
  return (
    failureKind === 'unreachable' &&
    typeof profile.instanceId === 'string' &&
    profile.instanceId.length > 0 &&
    typeof profile.syncBoundaryId === 'string' &&
    profile.syncBoundaryId.length > 0 &&
    typeof profile.memberId === 'string' &&
    profile.memberId.length > 0 &&
    typeof profile.userId === 'string' &&
    profile.userId.length > 0 &&
    (profile.transport === 'trusted-https' || profile.transport === 'tailscale-serve')
  )
}

/**
 * Durable local-erasure intent. A profile may be removed while its server is
 * unreachable or reports a different instance, so neither its bearer nor the
 * server can be trusted during cleanup. Keeping both identities lets the next
 * successfully opened local store erase exactly the recorded replica namespace.
 */
export interface PendingProfileCleanup {
  profileId: string
  userId: string
  principal: string
  syncBoundaryId?: string
  memberId?: string
  enqueuedAt: string
}

/**
 * A profile id is a native credential and endpoint trust boundary. Only the same
 * canonical network origin may reuse it; instanceId is public server metadata
 * and must never join cached data or credentials across origins.
 */
export function reusableProfileAtOrigin(
  profiles: ServerProfile[],
  canonicalOrigin: string,
  userId?: string,
  workspaceId?: string,
): ServerProfile | undefined {
  return profiles.find(
    (profile) =>
      profile.httpOrigin === canonicalOrigin &&
      (!userId || !profile.userId || profile.userId === userId) &&
      (workspaceId ? profile.workspaceId === workspaceId : !profile.workspaceId),
  )
}

const EMPTY_STATE: ServerProfileState = { activeProfileId: null, profiles: [] }

function isProfile(value: unknown, cookieTransport = false): value is ServerProfile {
  if (value === null || typeof value !== 'object') return false
  const row = value as Partial<ServerProfile>
  const validTransport =
    row.transport === 'trusted-https' ||
    row.transport === 'tailscale-serve' ||
    row.transport === 'insecure-lan' ||
    row.transport === 'tailscale-http' ||
    row.transport === 'insecure-http'
  let validOrigin = false
  if (typeof row.httpOrigin === 'string') {
    try {
      const url = new URL(row.httpOrigin)
      validOrigin =
        (url.protocol === 'http:' || url.protocol === 'https:') &&
        !url.username &&
        !url.password &&
        url.pathname === '/' &&
        !url.search &&
        !url.hash &&
        url.origin === row.httpOrigin
    } catch {
      validOrigin = false
    }
  }
  const transportMatches =
    validOrigin && validTransport && classifyServerTransport(row.httpOrigin!) === row.transport
  const credentialPolicyMatches =
    typeof row.httpOrigin === 'string' && row.httpOrigin.startsWith('http://')
      ? cookieTransport || (row.mode === 'open' && row.transport === 'insecure-lan')
      : true
  return (
    typeof row.id === 'string' &&
    /^[A-Za-z0-9._-]{1,256}$/.test(row.id) &&
    typeof row.name === 'string' &&
    row.name.length > 0 &&
    row.name.length <= 120 &&
    validOrigin &&
    (row.mode === 'open' || row.mode === 'protected') &&
    transportMatches &&
    credentialPolicyMatches &&
    (row.instanceId === undefined ||
      (typeof row.instanceId === 'string' &&
        row.instanceId.length > 0 &&
        row.instanceId.length <= 256)) &&
    (row.workspaceId === undefined ||
      (typeof row.workspaceId === 'string' &&
        row.workspaceId.length > 0 &&
        row.workspaceId.length <= 256)) &&
    (row.syncBoundaryId === undefined ||
      (typeof row.syncBoundaryId === 'string' && row.syncBoundaryId.length > 0)) &&
    (row.memberId === undefined || (typeof row.memberId === 'string' && row.memberId.length > 0)) &&
    (row.userId === undefined ||
      (typeof row.userId === 'string' && row.userId.length > 0 && row.userId.length <= 256)) &&
    typeof row.createdAt === 'string' &&
    typeof row.updatedAt === 'string'
  )
}

export interface ServerProfilesOptions {
  storage: ProfileMetadataStorage
  profilesKey?: string
  cleanupsKey?: string
  /** Browser cookies follow the browser's HTTP policy; native bearers never do. */
  cookieTransport?: boolean
}

/** Profile records carry metadata only. Credentials enter through a separate port. */
export function createServerProfiles(options: ServerProfilesOptions) {
  const { storage } = options
  const profilesKey = options.profilesKey ?? SERVER_PROFILES_KEY
  const cleanupsKey = options.cleanupsKey ?? PENDING_PROFILE_CLEANUPS_KEY
  async function loadServerProfiles(): Promise<ServerProfileState> {
    const [raw, pendingCleanups] = await Promise.all([
      storage.getItem(profilesKey),
      loadPendingProfileCleanups(),
    ])
    if (!raw) return EMPTY_STATE
    try {
      const parsed = JSON.parse(raw) as Partial<ServerProfileState>
      const pendingProfileIds = new Set(pendingCleanups.map((cleanup) => cleanup.profileId))
      // A committed cleanup intent is authoritative even if the later metadata
      // write failed or the process died. Never reactivate that profile or release
      // its saved bearer while local erasure is still pending.
      const profiles = Array.isArray(parsed.profiles)
        ? parsed.profiles.filter(
            (profile): profile is ServerProfile =>
              isProfile(profile, options.cookieTransport) && !pendingProfileIds.has(profile.id),
          )
        : []
      const selected = profiles.some((profile) => profile.id === parsed.activeProfileId)
        ? (parsed.activeProfileId ?? null)
        : (profiles[0]?.id ?? null)
      return { profiles, activeProfileId: selected }
    } catch {
      // Corrupt profile metadata contains no credentials. Refuse to guess a server;
      // the user can pair again while any old Keychain rows remain unreachable.
      return EMPTY_STATE
    }
  }

  async function saveServerProfiles(state: ServerProfileState): Promise<void> {
    await storage.setItem(profilesKey, JSON.stringify(state))
  }

  function isPendingProfileCleanup(value: unknown): value is PendingProfileCleanup {
    if (value === null || typeof value !== 'object') return false
    const row = value as Partial<PendingProfileCleanup>
    return (
      typeof row.profileId === 'string' &&
      /^[A-Za-z0-9._-]{1,256}$/.test(row.profileId) &&
      typeof row.userId === 'string' &&
      row.userId.length > 0 &&
      row.userId.length <= 256 &&
      ((row.syncBoundaryId === undefined && row.memberId === undefined) ||
        (typeof row.syncBoundaryId === 'string' &&
          row.syncBoundaryId.length > 0 &&
          typeof row.memberId === 'string' &&
          row.memberId.length > 0)) &&
      row.principal ===
        (row.syncBoundaryId && row.memberId
          ? profilePrincipal(row.syncBoundaryId, row.memberId)
          : legacyProfilePrincipal(row.profileId, row.userId)) &&
      typeof row.enqueuedAt === 'string' &&
      Number.isFinite(Date.parse(row.enqueuedAt))
    )
  }

  async function loadPendingProfileCleanups(): Promise<PendingProfileCleanup[]> {
    const raw = await storage.getItem(cleanupsKey)
    if (!raw) return []
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch {
      throw new Error('pending profile cleanup storage is invalid')
    }
    if (!Array.isArray(parsed) || !parsed.every(isPendingProfileCleanup)) {
      throw new Error('pending profile cleanup storage is invalid')
    }
    return parsed
  }

  /** Persist erasure intent before profile metadata or its credential is removed. */
  async function enqueuePendingProfileCleanup(
    profileId: string,
    userId: string,
    identity?: { syncBoundaryId: string; memberId: string },
  ): Promise<PendingProfileCleanup> {
    const cleanup: PendingProfileCleanup = {
      profileId,
      userId,
      ...(identity ? { syncBoundaryId: identity.syncBoundaryId, memberId: identity.memberId } : {}),
      principal: identity
        ? profilePrincipal(identity.syncBoundaryId, identity.memberId)
        : legacyProfilePrincipal(profileId, userId),
      enqueuedAt: new Date().toISOString(),
    }
    if (!isPendingProfileCleanup(cleanup)) throw new Error('invalid pending profile cleanup')
    const current = await loadPendingProfileCleanups()
    const next = [
      ...current.filter(
        (row) => row.principal !== cleanup.principal || row.profileId !== cleanup.profileId,
      ),
      cleanup,
    ]
    await storage.setItem(cleanupsKey, JSON.stringify(next))
    return cleanup
  }

  /**
   * Called only after both replica engines and the write-behind namespace are
   * erased. Metadata is repaired before the tombstone disappears so a failed
   * earlier profile deletion cannot resurrect the credential boundary later.
   */
  async function completePendingProfileCleanup(cleanup: PendingProfileCleanup): Promise<void> {
    const current = await loadPendingProfileCleanups()
    await saveServerProfiles(await loadServerProfiles())
    await storage.setItem(
      cleanupsKey,
      JSON.stringify(
        current.filter(
          (row) => row.principal !== cleanup.principal || row.profileId !== cleanup.profileId,
        ),
      ),
    )
  }

  return {
    loadServerProfiles,
    saveServerProfiles,
    loadPendingProfileCleanups,
    enqueuePendingProfileCleanup,
    completePendingProfileCleanup,
  }
}

export type ServerProfiles = ReturnType<typeof createServerProfiles>

export function createProfileId(): string {
  const cryptoLike = globalThis.crypto as { randomUUID?: () => string } | undefined
  return (
    cryptoLike?.randomUUID?.() ?? `profile-${Date.now()}-${Math.random().toString(36).slice(2)}`
  )
}

export function defaultProfileName(httpOrigin: string): string {
  try {
    return new URL(httpOrigin).hostname
  } catch {
    return 'Podium server'
  }
}

function isPrivateIpv4(hostname: string): boolean {
  const parts = hostname.split('.').map(Number)
  if (
    parts.length !== 4 ||
    parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)
  ) {
    return false
  }
  const [a, b] = parts
  if (a === undefined || b === undefined) return false
  return (
    a === 10 ||
    a === 127 ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168)
  )
}

export function isTailscaleIpv4(hostname: string): boolean {
  const parts = hostname.split('.').map(Number)
  const [a, b] = parts
  return parts.length === 4 && a === 100 && b !== undefined && b >= 64 && b <= 127
}

export function classifyServerTransport(httpOrigin: string): ServerTransport {
  const url = new URL(httpOrigin)
  if (url.protocol === 'https:') {
    return url.hostname.toLowerCase().endsWith('.ts.net') ? 'tailscale-serve' : 'trusted-https'
  }
  if (isTailscaleIpv4(url.hostname)) return 'tailscale-http'
  if (
    isPrivateIpv4(url.hostname) ||
    url.hostname === 'localhost' ||
    url.hostname.endsWith('.local') ||
    !url.hostname.includes('.')
  ) {
    return 'insecure-lan'
  }
  return 'insecure-http'
}

/** One unrelated server's `user:admin` must never name another server's rows. */
export function profilePrincipal(syncBoundaryId: string, memberId: string): string {
  return replicaNamespaceKey({ syncBoundaryId, memberId })
}

/** Existing cleanup intents must still erase their original legacy namespace. */
function legacyProfilePrincipal(profileId: string, userId: string): string {
  return `server:${encodeURIComponent(profileId)}:user:${encodeURIComponent(userId)}`
}
