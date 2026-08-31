import { act, cleanup, render, waitFor } from '@testing-library/react'
import { PODIUM_SCHEME, formatPodiumLink } from '@podium/protocol'
import type { ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ServerProfileContextValue } from './server-profile-context'

const seams = vi.hoisted(() => ({
  activeContext: null as ServerProfileContextValue | null,
  credentials: new Map<string, string>(),
  deleteCredential: vi.fn<(profileId: string) => Promise<void>>(),
  getCredential: vi.fn<(profileId: string) => Promise<string | null>>(),
  preflight: vi.fn(),
  router: { replace: vi.fn() },
  runtime: [] as Array<{ origin: string | null; bearer: string | null }>,
  saveProfiles: vi.fn(async () => {}),
  setCredential: vi.fn<(profileId: string, bearer: string) => Promise<void>>(),
  socket: [] as Array<{ origin: string | null; bearer: string | null }>,
  renders: [] as Array<{ profileId: string; origin: string; bearer: string | null }>,
}))

vi.mock('expo-haptics', () => ({ selectionAsync: vi.fn() }))
vi.mock('expo-router', () => ({ useRouter: () => seams.router }))
vi.mock('react-native', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react-native')>()
  return {
    ...actual,
    Platform: { ...actual.Platform, OS: 'ios' },
    Linking: {
      getInitialURL: vi.fn(async () => null),
      addEventListener: vi.fn(() => ({ remove: vi.fn() })),
      openSettings: vi.fn(),
    },
  }
})
vi.mock('../components/PairingScanner', () => ({ PairingScanner: () => null }))
vi.mock('../components/KeyboardAvoidingRoot', () => ({
  KeyboardAvoidingRoot: ({ children }: { children: ReactNode }) => children,
}))
vi.mock('../components/PressableScale', () => ({ PressableScale: () => null }))
vi.mock('./launch-ready', () => ({
  LaunchReadyView: ({ children }: { children: ReactNode }) => children,
}))
vi.mock('./pairing', () => ({
  claimMobilePairing: vi.fn(),
  normalizeManualServer: (origin: string) => origin,
  parsePairingLink: vi.fn(),
  pollMobilePairing: vi.fn(),
  preflightServer: seams.preflight,
}))
vi.mock('./profile-credentials', () => ({
  deleteProfileCredential: seams.deleteCredential,
  getProfileCredential: seams.getCredential,
  purgeOrphanedProfileCredentials: vi.fn(async () => {}),
  setProfileCredential: seams.setCredential,
}))
vi.mock('./server-profiles', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./server-profiles')>()
  return {
    ...actual,
    loadServerProfiles: vi.fn(async () => ({
      activeProfileId: 'profile-a',
      profiles: [
        {
          id: 'profile-a',
          name: 'Server A',
          httpOrigin: 'https://a.example',
          instanceId: 'instance-a',
          mode: 'protected',
          transport: 'trusted-https',
          userId: 'user:a',
          createdAt: '2026-08-01T00:00:00.000Z',
          updatedAt: '2026-08-01T00:00:00.000Z',
        },
        {
          id: 'profile-b',
          name: 'Server B',
          httpOrigin: 'https://b.example',
          instanceId: 'instance-b',
          mode: 'protected',
          transport: 'trusted-https',
          userId: 'user:b',
          createdAt: '2026-08-01T00:00:00.000Z',
          updatedAt: '2026-08-01T00:00:00.000Z',
        },
      ],
    })),
    saveServerProfiles: seams.saveProfiles,
  }
})
vi.mock('./native-websocket', () => ({
  configureNativeWebSocketCredential: (origin: string | null, bearer: string | null) => {
    seams.socket.push({ origin, bearer })
  },
  installNativeWebSocketAuthentication: vi.fn(),
}))
vi.mock('./override-lifecycle', () => ({
  clearLocalCredentialSurfaces: vi.fn(),
  preflightNativeOverride: vi.fn(),
}))
vi.mock('./trpc', () => ({
  envServer: () => null,
  setActiveServerRuntime: (config: { httpOrigin: string } | undefined, bearer: string | null) => {
    seams.runtime.push({ origin: config?.httpOrigin ?? null, bearer })
  },
}))
vi.mock('./auth', () => ({ logout: vi.fn() }))

import { ServerProfileGate, useServerProfile } from './ServerProfileGate'
import {
  captureMobileHandoffUrl,
  consumePendingMobileHandoff,
  pendingMobileHandoffSnapshot,
} from './mobile-handoff'

function ProfileProbe() {
  const context = useServerProfile()
  seams.activeContext = context
  seams.renders.push({
    profileId: context.profile.id,
    origin: context.config.httpOrigin,
    bearer: context.bearer,
  })
  return null
}

function successfulPreflight(origin: string) {
  const isA = origin === 'https://a.example'
  return {
    ok: true as const,
    httpOrigin: origin,
    wsClientUrl: `${origin.replace('https:', 'wss:')}/client`,
    instanceId: isA ? 'instance-a' : 'instance-b',
    mode: 'protected' as const,
    transport: 'trusted-https' as const,
  }
}

async function mountActiveProfileA() {
  render(
    <ServerProfileGate>
      <ProfileProbe />
    </ServerProfileGate>,
  )
  await waitFor(() => {
    expect(seams.activeContext?.profile.id).toBe('profile-a')
    expect(seams.activeContext?.bearer).toBe('token-a')
  })
}

beforeEach(() => {
  consumePendingMobileHandoff(pendingMobileHandoffSnapshot().id)
  seams.activeContext = null
  seams.credentials.clear()
  seams.credentials.set('profile-a', 'token-a')
  seams.credentials.set('profile-b', 'token-b')
  seams.runtime.length = 0
  seams.socket.length = 0
  seams.renders.length = 0
  seams.preflight.mockReset()
  seams.preflight.mockImplementation(async (origin: string) => successfulPreflight(origin))
  seams.saveProfiles.mockClear()
  seams.getCredential.mockReset()
  seams.getCredential.mockImplementation(
    async (profileId) => seams.credentials.get(profileId) ?? null,
  )
  seams.setCredential.mockReset()
  seams.setCredential.mockImplementation(async (profileId, bearer) => {
    seams.credentials.set(profileId, bearer)
  })
  seams.deleteCredential.mockReset()
  seams.deleteCredential.mockImplementation(async (profileId) => {
    seams.credentials.delete(profileId)
  })
})

afterEach(() => {
  cleanup()
})

describe('handoff profile selection', () => {
  it('selects another exact saved profile before an authenticated client mounts', async () => {
    await mountActiveProfileA()
    const link = formatPodiumLink(PODIUM_SCHEME, {
      kind: 'session',
      session: 'session-on-b',
      search: '?origin=https%3A%2F%2Fb.example&instance=instance-b',
    })

    act(() => {
      expect(captureMobileHandoffUrl(link)).toBe(true)
    })

    await waitFor(() => expect(seams.activeContext?.profile.id).toBe('profile-b'))
    expect(seams.preflight).toHaveBeenCalledWith('https://b.example')
    expect(seams.saveProfiles).toHaveBeenCalledWith(
      expect.objectContaining({ activeProfileId: 'profile-b' }),
    )
    expect(pendingMobileHandoffSnapshot().request).not.toBeNull()
    expect(pendingMobileHandoffSnapshot().profileSelected).toBe(true)
    expect([...seams.runtime, ...seams.socket]).not.toContainEqual({
      origin: 'https://b.example',
      bearer: 'token-a',
    })
  })

  it('re-evaluates the latest handoff after an older profile switch settles', async () => {
    await mountActiveProfileA()
    let releaseProfileB = () => {}
    const profileBReleased = new Promise<void>((resolve) => {
      releaseProfileB = resolve
    })
    let reportProfileBStarted = () => {}
    const profileBStarted = new Promise<void>((resolve) => {
      reportProfileBStarted = resolve
    })
    seams.preflight.mockImplementation(async (origin: string) => {
      if (origin === 'https://b.example') {
        reportProfileBStarted()
        await profileBReleased
      }
      return successfulPreflight(origin)
    })

    act(() => {
      captureMobileHandoffUrl(
        formatPodiumLink(PODIUM_SCHEME, {
          kind: 'session',
          session: 'older-session-on-b',
          search: '?origin=https%3A%2F%2Fb.example&instance=instance-b',
        }),
      )
    })
    await profileBStarted

    act(() => {
      captureMobileHandoffUrl(
        formatPodiumLink(PODIUM_SCHEME, {
          kind: 'session',
          session: 'newer-session-on-a',
          search: '?origin=https%3A%2F%2Fa.example&instance=instance-a',
        }),
      )
    })
    const newerRequestId = pendingMobileHandoffSnapshot().id
    expect(pendingMobileHandoffSnapshot()).toMatchObject({
      id: newerRequestId,
      profileSelected: false,
      request: {
        kind: 'destination',
        destination: { sessionId: 'newer-session-on-a' },
      },
    })

    await act(async () => {
      releaseProfileB()
      await profileBReleased
    })

    await waitFor(() => expect(seams.activeContext?.profile.id).toBe('profile-a'))
    await waitFor(() => expect(pendingMobileHandoffSnapshot().profileSelected).toBe(true))
    expect(pendingMobileHandoffSnapshot()).toMatchObject({
      id: newerRequestId,
      request: {
        kind: 'destination',
        destination: { sessionId: 'newer-session-on-a' },
      },
    })
    expect(seams.preflight.mock.calls.map(([origin]) => origin)).toEqual([
      'https://a.example',
      'https://b.example',
      'https://a.example',
    ])
  })
})

describe('profile credential completion races', () => {
  it('rolls back an A login write that becomes stale while B is activating', async () => {
    await mountActiveProfileA()
    const updateA = seams.activeContext!.updateCredential
    const switchToB = seams.activeContext!.switchProfile
    let releaseLateWrite = () => {}
    const lateWriteReleased = new Promise<void>((resolve) => {
      releaseLateWrite = resolve
    })
    let reportLateWriteStarted = () => {}
    const lateWriteStarted = new Promise<void>((resolve) => {
      reportLateWriteStarted = resolve
    })
    seams.setCredential.mockImplementation(async (profileId, bearer) => {
      seams.credentials.set(profileId, bearer)
      if (profileId === 'profile-a' && bearer === 'late-token-a') {
        reportLateWriteStarted()
        await lateWriteReleased
      }
    })

    const lateLogin = updateA('late-token-a').then(
      () => null,
      (error: unknown) => error,
    )
    await lateWriteStarted
    const switching = switchToB('profile-b')
    releaseLateWrite()

    let lateLoginError: unknown
    await act(async () => {
      ;[lateLoginError] = await Promise.all([lateLogin, switching])
    })

    expect(lateLoginError).toMatchObject({ name: 'StaleCredentialOwnerError' })
    expect(seams.credentials.get('profile-a')).toBe('token-a')
    expect(seams.credentials.get('profile-b')).toBe('token-b')
    expect(seams.activeContext?.profile.id).toBe('profile-b')
    expect(seams.activeContext?.bearer).toBe('token-b')
    expect(seams.renders).not.toContainEqual({
      profileId: 'profile-b',
      origin: 'https://b.example',
      bearer: 'late-token-a',
    })
    expect([...seams.runtime, ...seams.socket]).not.toContainEqual({
      origin: 'https://b.example',
      bearer: 'late-token-a',
    })
  })

  it('refuses a late A expiry without clearing B or publishing an A/B pairing', async () => {
    await mountActiveProfileA()
    const expireA = seams.activeContext!.updateCredential

    await act(async () => {
      await seams.activeContext!.switchProfile('profile-b')
    })
    const deletesBeforeExpiry = seams.deleteCredential.mock.calls.length
    await expect(expireA(null)).rejects.toMatchObject({ name: 'StaleCredentialOwnerError' })

    expect(seams.deleteCredential).toHaveBeenCalledTimes(deletesBeforeExpiry)
    expect(seams.credentials.get('profile-b')).toBe('token-b')
    expect(seams.activeContext?.profile.id).toBe('profile-b')
    expect(seams.activeContext?.bearer).toBe('token-b')
    expect(seams.renders).not.toContainEqual({
      profileId: 'profile-b',
      origin: 'https://b.example',
      bearer: 'token-a',
    })
    expect([...seams.runtime, ...seams.socket]).not.toContainEqual({
      origin: 'https://b.example',
      bearer: 'token-a',
    })
  })
})
