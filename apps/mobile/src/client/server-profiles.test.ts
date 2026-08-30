import AsyncStorage from '@react-native-async-storage/async-storage'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { stored } = vi.hoisted(() => ({ stored: new Map<string, string>() }))
vi.mock('@react-native-async-storage/async-storage', () => ({
  default: {
    getItem: async (key: string) => stored.get(key) ?? null,
    setItem: async (key: string, value: string) => void stored.set(key, value),
  },
}))

import {
  canOpenProfileOffline,
  classifyServerTransport,
  completePendingProfileCleanup,
  enqueuePendingProfileCleanup,
  isTailscaleIpv4,
  loadPendingProfileCleanups,
  loadServerProfiles,
  PENDING_PROFILE_CLEANUPS_KEY,
  profilePrincipal,
  reusableProfileAtOrigin,
  saveServerProfiles,
  SERVER_PROFILES_KEY,
} from './server-profiles'
import { installMobileMetadataStorage } from './mobile-metadata-storage'

beforeEach(() => {
  stored.clear()
  installMobileMetadataStorage(AsyncStorage)
})

describe('native server profiles', () => {
  it('opens offline only from a previously verified profile with a bound user', () => {
    const verified = {
      id: 'server-a',
      name: 'Alice',
      httpOrigin: 'https://alice.example',
      instanceId: 'instance-a',
      userId: 'user:alice',
      mode: 'protected' as const,
      transport: 'trusted-https' as const,
      createdAt: '2026-08-13T12:00:00.000Z',
      updatedAt: '2026-08-13T12:00:00.000Z',
    }

    expect(canOpenProfileOffline(verified, 'unreachable')).toBe(true)
    expect(canOpenProfileOffline({ ...verified, instanceId: undefined }, 'unreachable')).toBe(false)
    expect(canOpenProfileOffline({ ...verified, userId: undefined }, 'unreachable')).toBe(false)
    expect(canOpenProfileOffline(verified, 'tls-untrusted')).toBe(false)
    expect(canOpenProfileOffline(verified, 'version-mismatch')).toBe(false)
    expect(
      canOpenProfileOffline(
        { ...verified, httpOrigin: 'http://192.168.1.8', transport: 'insecure-lan' },
        'unreachable',
      ),
    ).toBe(false)
  })

  it('classifies every transport policy before credentials can be sent', () => {
    expect(classifyServerTransport('https://podium.example')).toBe('trusted-https')
    expect(classifyServerTransport('https://host.tailnet-name.ts.net')).toBe('tailscale-serve')
    expect(classifyServerTransport('http://192.168.1.8:18787')).toBe('insecure-lan')
    expect(classifyServerTransport('http://studio.local:18787')).toBe('insecure-lan')
    expect(classifyServerTransport('http://100.100.10.20:18787')).toBe('tailscale-http')
    expect(classifyServerTransport('http://podium.example')).toBe('insecure-http')
  })

  it('uses the complete Tailscale CGNAT range and not neighboring addresses', () => {
    expect(isTailscaleIpv4('100.64.0.1')).toBe(true)
    expect(isTailscaleIpv4('100.127.255.254')).toBe(true)
    expect(isTailscaleIpv4('100.63.255.255')).toBe(false)
    expect(isTailscaleIpv4('100.128.0.1')).toBe(false)
  })

  it('partitions the same server user by immutable local profile id', () => {
    expect(profilePrincipal('alice-vps', 'user:admin')).not.toBe(
      profilePrincipal('colleague-vps', 'user:admin'),
    )
    expect(profilePrincipal('alice/vps', 'user:admin')).toBe('server:alice%2Fvps:user:user%3Aadmin')
  })

  it('never reuses a trust boundary across origins that report the same instance id', () => {
    const now = '2026-08-13T12:00:00.000Z'
    const profile = {
      id: 'original-profile',
      name: 'Original',
      httpOrigin: 'https://old.example',
      instanceId: 'public-instance-id',
      userId: 'user:admin',
      mode: 'protected' as const,
      transport: 'trusted-https' as const,
      createdAt: now,
      updatedAt: now,
    }

    expect(reusableProfileAtOrigin([profile], 'https://new.example', 'user:admin')).toBeUndefined()
    expect(reusableProfileAtOrigin([profile], 'https://old.example', 'user:admin')).toBe(profile)
  })

  it('persists multiple profiles and repairs a missing selection without inventing a server', async () => {
    const now = '2026-08-13T12:00:00.000Z'
    const profiles = [
      {
        id: 'server-a',
        name: 'Alice',
        httpOrigin: 'https://alice.example',
        mode: 'protected' as const,
        transport: 'trusted-https' as const,
        createdAt: now,
        updatedAt: now,
      },
      {
        id: 'server-b',
        name: 'Colleague',
        httpOrigin: 'https://colleague.example',
        mode: 'protected' as const,
        transport: 'trusted-https' as const,
        createdAt: now,
        updatedAt: now,
      },
    ]
    await saveServerProfiles({ activeProfileId: 'missing', profiles })
    await expect(loadServerProfiles()).resolves.toEqual({ activeProfileId: 'server-a', profiles })
  })

  it('fails closed on tampered cleartext protected metadata', async () => {
    stored.set(
      'podium.mobile.server-profiles.v1',
      JSON.stringify({
        activeProfileId: 'bad',
        profiles: [
          {
            id: 'bad',
            name: 'Bad',
            httpOrigin: 'http://public.example',
            mode: 'protected',
            transport: 'trusted-https',
            createdAt: '2026-08-13T12:00:00.000Z',
            updatedAt: '2026-08-13T12:00:00.000Z',
          },
        ],
      }),
    )
    await expect(loadServerProfiles()).resolves.toEqual({ activeProfileId: null, profiles: [] })
  })

  it('durably queues the exact profile and account replica before profile removal', async () => {
    await enqueuePendingProfileCleanup('server-a', 'user:admin')
    const replacement = await enqueuePendingProfileCleanup('server-a', 'user:admin')

    expect(replacement.principal).toBe('server:server-a:user:user%3Aadmin')
    expect(await loadPendingProfileCleanups()).toEqual([replacement])
    expect(JSON.parse(stored.get(PENDING_PROFILE_CLEANUPS_KEY) ?? 'null')).toEqual([replacement])
  })

  it('completes only the replica tombstone whose erasure succeeded', async () => {
    const first = await enqueuePendingProfileCleanup('server-a', 'user:admin')
    const second = await enqueuePendingProfileCleanup('server-b', 'user:admin')

    await completePendingProfileCleanup(first)

    await expect(loadPendingProfileCleanups()).resolves.toEqual([second])
  })

  it('never reactivates a profile after cleanup intent survives metadata deletion failure', async () => {
    const now = '2026-08-13T12:00:00.000Z'
    const profile = {
      id: 'server-a',
      name: 'Alice',
      httpOrigin: 'https://alice.example',
      userId: 'user:admin',
      mode: 'protected' as const,
      transport: 'trusted-https' as const,
      createdAt: now,
      updatedAt: now,
    }
    await saveServerProfiles({ activeProfileId: profile.id, profiles: [profile] })
    await enqueuePendingProfileCleanup(profile.id, profile.userId)

    await expect(loadServerProfiles()).resolves.toEqual({ activeProfileId: null, profiles: [] })
    expect(JSON.parse(stored.get(SERVER_PROFILES_KEY) ?? 'null').profiles).toEqual([profile])

    const [cleanup] = await loadPendingProfileCleanups()
    if (!cleanup) throw new Error('cleanup was not queued')
    await completePendingProfileCleanup(cleanup)
    expect(JSON.parse(stored.get(SERVER_PROFILES_KEY) ?? 'null').profiles).toEqual([])
    await expect(loadPendingProfileCleanups()).resolves.toEqual([])
  })

  it('fails closed instead of overwriting malformed cleanup intent', async () => {
    stored.set(PENDING_PROFILE_CLEANUPS_KEY, '{not-json')

    await expect(enqueuePendingProfileCleanup('server-a', 'user:admin')).rejects.toThrow(
      'pending profile cleanup storage is invalid',
    )
    expect(stored.get(PENDING_PROFILE_CLEANUPS_KEY)).toBe('{not-json')
  })
})
