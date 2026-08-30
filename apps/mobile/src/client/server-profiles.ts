import { mobileMetadataStorage } from './mobile-metadata-storage'

export const SERVER_PROFILES_KEY = 'podium.mobile.server-profiles.v1'
export const PENDING_PROFILE_CLEANUPS_KEY = 'podium.mobile.pending-profile-cleanups.v1'

export type ServerTransport =
  | 'trusted-https'
  | 'tailscale-serve'
  | 'insecure-lan'
  | 'tailscale-http'
  | 'insecure-http'

export interface ServerProfile {
  /** Random local identity. Server ids are deliberately not trusted as storage keys. */
  id: string
  name: string
  httpOrigin: string
  instanceId?: string
  mode: 'open' | 'protected'
  transport: ServerTransport
  userId?: string
  createdAt: string
  updatedAt: string
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
    | 'tls-untrusted'
    | 'unreachable'
    | 'cleartext-blocked',
): boolean {
  return (
    failureKind === 'unreachable' &&
    typeof profile.instanceId === 'string' &&
    profile.instanceId.length > 0 &&
    typeof profile.userId === 'string' &&
    profile.userId.length > 0 &&
    (profile.transport === 'trusted-https' || profile.transport === 'tailscale-serve')
  )
}

/**
 * Durable local-erasure intent. A profile may be removed while its server is
 * unreachable or reports a different instance, so neither its bearer nor the
 * server can be trusted during cleanup. Keeping both identities lets the next
 * successfully opened local store erase exactly profileId + userId.
 */
export interface PendingProfileCleanup {
  profileId: string
  userId: string
  principal: string
  enqueuedAt: string
}

/**
 * A profile id is a native storage/replica trust boundary. Only the same
 * canonical network origin may reuse it; instanceId is public server metadata
 * and must never join cached data or credentials across origins.
 */
export function reusableProfileAtOrigin(
  profiles: ServerProfile[],
  canonicalOrigin: string,
  userId?: string,
): ServerProfile | undefined {
  return profiles.find(
    (profile) =>
      profile.httpOrigin === canonicalOrigin &&
      (!userId || !profile.userId || profile.userId === userId),
  )
}

const EMPTY_STATE: ServerProfileState = { activeProfileId: null, profiles: [] }

function isProfile(value: unknown): value is ServerProfile {
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
      ? row.mode === 'open' && row.transport === 'insecure-lan'
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
    (row.userId === undefined ||
      (typeof row.userId === 'string' && row.userId.length > 0 && row.userId.length <= 256)) &&
    typeof row.createdAt === 'string' &&
    typeof row.updatedAt === 'string'
  )
}

export async function loadServerProfiles(): Promise<ServerProfileState> {
  const [raw, pendingCleanups] = await Promise.all([
    mobileMetadataStorage().getItem(SERVER_PROFILES_KEY),
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
            isProfile(profile) && !pendingProfileIds.has(profile.id),
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

export async function saveServerProfiles(state: ServerProfileState): Promise<void> {
  await mobileMetadataStorage().setItem(SERVER_PROFILES_KEY, JSON.stringify(state))
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
    row.principal === profilePrincipal(row.profileId, row.userId) &&
    typeof row.enqueuedAt === 'string' &&
    Number.isFinite(Date.parse(row.enqueuedAt))
  )
}

export async function loadPendingProfileCleanups(): Promise<PendingProfileCleanup[]> {
  const raw = await mobileMetadataStorage().getItem(PENDING_PROFILE_CLEANUPS_KEY)
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
export async function enqueuePendingProfileCleanup(
  profileId: string,
  userId: string,
): Promise<PendingProfileCleanup> {
  const cleanup: PendingProfileCleanup = {
    profileId,
    userId,
    principal: profilePrincipal(profileId, userId),
    enqueuedAt: new Date().toISOString(),
  }
  if (!isPendingProfileCleanup(cleanup)) throw new Error('invalid pending profile cleanup')
  const current = await loadPendingProfileCleanups()
  const next = [...current.filter((row) => row.principal !== cleanup.principal), cleanup]
  await mobileMetadataStorage().setItem(PENDING_PROFILE_CLEANUPS_KEY, JSON.stringify(next))
  return cleanup
}

/**
 * Called only after both replica engines and the write-behind namespace are
 * erased. Metadata is repaired before the tombstone disappears so a failed
 * earlier profile deletion cannot resurrect the credential boundary later.
 */
export async function completePendingProfileCleanup(cleanup: PendingProfileCleanup): Promise<void> {
  const current = await loadPendingProfileCleanups()
  await saveServerProfiles(await loadServerProfiles())
  await mobileMetadataStorage().setItem(
    PENDING_PROFILE_CLEANUPS_KEY,
    JSON.stringify(current.filter((row) => row.principal !== cleanup.principal)),
  )
}

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
  return parts.length === 4 && parts[0] === 100 && parts[1] >= 64 && parts[1] <= 127
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
export function profilePrincipal(profileId: string, userId: string): string {
  return `server:${encodeURIComponent(profileId)}:user:${encodeURIComponent(userId)}`
}
