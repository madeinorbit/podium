import { CredentialWriteQueue, StaleCredentialOwnerError } from './credential-ownership'
import {
  canOpenProfileOffline,
  classifyServerTransport,
  createServerProfiles,
  type ServerProfile,
  type ServerProfiles,
  type ServerProfileState,
} from './server-profiles'
import type { ServerPreflight } from './pairing'
import { cookieCredentials, type AccountCredentials, type ProfileMetadataStorage } from './storage'
import { parseReplicaNamespaceKey } from '../replica/principal-storage'

export interface ProfileActivation {
  state: ServerProfileState
  profile: ServerProfile
  bearer: string | null
  activation: 'verified' | 'offline-cache'
}

/** A confirmed sign-out/expiry cannot keep authorising a native offline identity. */
export async function clearProfileIdentity(
  profiles: ServerProfiles,
  profileId: string,
  isCurrent: () => boolean,
): Promise<ServerProfileState> {
  if (!isCurrent()) throw new StaleCredentialOwnerError()
  const before = await profiles.loadServerProfiles()
  if (!isCurrent()) throw new StaleCredentialOwnerError()
  const next = {
    ...before,
    profiles: before.profiles.map((profile) => {
      if (profile.id !== profileId) return profile
      const { userId: _userId, syncBoundaryId: _boundary, memberId: _member, ...rest } = profile
      return { ...rest, updatedAt: new Date().toISOString() }
    }),
  }
  await profiles.saveServerProfiles(next)
  if (!isCurrent()) {
    await profiles.saveServerProfiles(before)
    throw new StaleCredentialOwnerError()
  }
  return next
}

/** No credential read is allowed until an unauthenticated preflight verifies its origin. */
export async function activateServerProfile(args: {
  profile: ServerProfile
  profiles: ServerProfiles
  credentials: AccountCredentials
  preflight(origin: string, workspaceId?: string): Promise<ServerPreflight>
  isCurrent?(): boolean
  profileWrites: CredentialWriteQueue
  credentialWrites: CredentialWriteQueue
}): Promise<ProfileActivation> {
  const { profile, profiles, credentials } = args
  const current = () => {
    if (args.isCurrent?.() === false) throw new StaleCredentialOwnerError()
  }
  current()
  const checked = await args.preflight(profile.httpOrigin, profile.workspaceId)
  current()
  if (!checked.ok && !canOpenProfileOffline(profile, checked.kind))
    throw new Error(`${checked.title}: ${checked.detail}`)
  if (checked.ok && profile.instanceId && profile.instanceId !== checked.instanceId)
    throw new Error(
      'This server was replaced. Its saved session was not sent. Remove this profile or pair with the replacement as a new server.',
    )
  const bearer = checked.ok
    ? await args.credentialWrites.run(() => credentials.get(profile.id))
    : null
  current()
  const state = await args.profileWrites.run(async () => {
    current()
    const prior = await profiles.loadServerProfiles()
    const saved = prior.profiles.find((row) => row.id === profile.id)
    if (
      !saved ||
      saved.httpOrigin !== profile.httpOrigin ||
      saved.instanceId !== profile.instanceId ||
      saved.workspaceId !== profile.workspaceId
    )
      throw new StaleCredentialOwnerError()
    const verified: ServerProfile = checked.ok
      ? {
          ...saved,
          httpOrigin: checked.httpOrigin,
          instanceId: checked.instanceId,
          ...(checked.workspaceId ? { workspaceId: checked.workspaceId } : {}),
          mode: checked.mode,
          transport: checked.transport,
          updatedAt: new Date().toISOString(),
        }
      : saved
    const next = {
      activeProfileId: profile.id,
      profiles: prior.profiles.map((row) => (row.id === profile.id ? verified : row)),
    }
    current()
    await profiles.saveServerProfiles(next)
    if (args.isCurrent?.() === false) {
      await profiles.saveServerProfiles(prior)
      throw new StaleCredentialOwnerError()
    }
    return next
  })
  current()
  return {
    state,
    profile: state.profiles.find((row) => row.id === profile.id)!,
    bearer,
    activation: checked.ok ? 'verified' : 'offline-cache',
  }
}

/** Persist intent first; retry it on every boot until both data and credential erasure succeed. */
export async function removeServerProfile(args: {
  profile: ServerProfile
  profiles: ServerProfiles
  credentials: AccountCredentials
  erasePrincipal?(principal: string): Promise<void>
}): Promise<ServerProfileState> {
  const { profile, profiles, credentials } = args
  const cleanup = profile.userId
    ? await profiles.enqueuePendingProfileCleanup(
        profile.id,
        profile.userId,
        profile.syncBoundaryId && profile.memberId
          ? { syncBoundaryId: profile.syncBoundaryId, memberId: profile.memberId }
          : undefined,
      )
    : undefined
  // A never-authenticated profile owns no replica. A tombstone filters an
  // authenticated profile out even if this metadata write fails midway.
  const state = await profiles.loadServerProfiles()
  const remaining = state.profiles.filter((row) => row.id !== profile.id)
  const next = {
    profiles: remaining,
    activeProfileId: remaining.some((row) => row.id === state.activeProfileId)
      ? state.activeProfileId
      : (remaining[0]?.id ?? null),
  }
  await profiles.saveServerProfiles(next)
  await credentials.remove(profile.id)
  if (cleanup && args.erasePrincipal) {
    await args.erasePrincipal(cleanup.principal)
    await profiles.completePendingProfileCleanup(cleanup)
  }
  return next
}

export async function drainProfileCleanups(args: {
  profiles: ServerProfiles
  credentials: AccountCredentials
  erasePrincipal(principal: string): Promise<void>
}): Promise<void> {
  for (const cleanup of await args.profiles.loadPendingProfileCleanups()) {
    await args.credentials.remove(cleanup.profileId)
    await args.erasePrincipal(cleanup.principal)
    await args.profiles.completePendingProfileCleanup(cleanup)
  }
}

/** A single server is the one-profile case; each shell decides whether to show it. */
export function singleServerProfile(origin: string, workspaceId?: string): ServerProfile {
  const url = new URL(origin)
  const now = new Date().toISOString()
  return {
    id: 'single-server',
    name: url.hostname,
    httpOrigin: url.origin,
    ...(workspaceId ? { workspaceId } : {}),
    mode: 'protected',
    transport: classifyServerTransport(url.origin),
    createdAt: now,
    updatedAt: now,
  }
}

/** The cookie clients use the same profile lifecycle with a hidden, single profile. */
export function createSingleServerAccounts(args: {
  httpOrigin: string
  metadataPrefix: string
  storage: ProfileMetadataStorage
  erasePrincipal(principal: string): Promise<void>
}) {
  const profiles = createServerProfiles({
    storage: args.storage,
    cookieTransport: true,
    profilesKey: args.metadataPrefix + '.profiles.v1',
    cleanupsKey: args.metadataPrefix + '.cleanups.v1',
  })
  const writes = new CredentialWriteQueue()
  const drain = () =>
    drainProfileCleanups({
      profiles,
      credentials: cookieCredentials,
      erasePrincipal: args.erasePrincipal,
    })
  const remove = (profile: ServerProfile) =>
    removeServerProfile({
      profile,
      profiles,
      credentials: cookieCredentials,
      erasePrincipal: args.erasePrincipal,
    })
  return {
    profiles,
    drain: () => writes.run(drain),
    recordPrincipal: (principal: string, isCurrent: () => boolean = () => true) =>
      writes.run(async () => {
        if (!isCurrent()) return
        const identity = parseReplicaNamespaceKey(principal)
        if (!identity) throw new Error('account identity was not server-authored')
        await drain()
        if (!isCurrent()) return
        const saved = await profiles.loadServerProfiles()
        const previous = saved.profiles[0]
        if (!isCurrent()) return
        if (
          previous?.syncBoundaryId &&
          previous.memberId &&
          (previous.syncBoundaryId !== identity.syncBoundaryId ||
            previous.memberId !== identity.memberId)
        )
          await remove(previous)
        if (!isCurrent()) return
        const profile = {
          ...singleServerProfile(args.httpOrigin),
          ...identity,
          userId: identity.memberId,
          ...(previous?.createdAt ? { createdAt: previous.createdAt } : {}),
        }
        await profiles.saveServerProfiles({ profiles: [profile], activeProfileId: profile.id })
        if (!isCurrent()) {
          // Do not revive an account already erased by a replacement.
          await profiles.saveServerProfiles(
            previous &&
              previous.syncBoundaryId === identity.syncBoundaryId &&
              previous.memberId === identity.memberId
              ? saved
              : { profiles: [], activeProfileId: null },
          )
          return
        }
        return profile
      }),
    remove: () =>
      writes.run(async () => {
        const saved = await profiles.loadServerProfiles()
        if (saved.profiles[0]) await remove(saved.profiles[0])
        await drain()
      }),
  }
}
