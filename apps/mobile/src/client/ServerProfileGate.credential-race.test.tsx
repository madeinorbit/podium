import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { PODIUM_SCHEME, formatPodiumLink } from '@podium/protocol'
import type { ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ServerProfileContextValue } from './server-profile-context'
import type { ServerProfileState } from './server-profiles'

const seams = vi.hoisted(() => ({
  activeContext: null as ServerProfileContextValue | null,
  alert: vi.fn(),
  announce: vi.fn(),
  claimPairing: vi.fn(),
  credentials: new Map<string, string>(),
  deleteCredential: vi.fn<(profileId: string) => Promise<void>>(),
  durableProfiles: null as ServerProfileState | null,
  getCredential: vi.fn<(profileId: string) => Promise<string | null>>(),
  getInitialUrl: vi.fn<() => Promise<string | null>>(),
  linkListener: null as ((event: { url: string }) => void) | null,
  loadProfiles: vi.fn<() => Promise<ServerProfileState>>(),
  logout: vi.fn(),
  parsePairing: vi.fn(),
  pollPairing: vi.fn(),
  preflight: vi.fn(),
  purgeCredentials: vi.fn<(profileIds: string[]) => Promise<void>>(),
  router: { replace: vi.fn() },
  runtime: [] as Array<{ origin: string | null; bearer: string | null }>,
  saveProfiles: vi.fn<(state: ServerProfileState) => Promise<void>>(),
  setCredential: vi.fn<(profileId: string, bearer: string) => Promise<void>>(),
  socket: [] as Array<{ origin: string | null; bearer: string | null }>,
  renders: [] as Array<{ profileId: string; origin: string; bearer: string | null }>,
}))

vi.mock('expo-haptics', () => ({ selectionAsync: vi.fn() }))
vi.mock('expo-router', () => ({ router: seams.router, useRouter: () => seams.router }))
vi.mock('react-native', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react-native')>()
  return {
    ...actual,
    Platform: { ...actual.Platform, OS: 'ios' },
    Alert: { ...actual.Alert, alert: seams.alert },
    AccessibilityInfo: {
      ...actual.AccessibilityInfo,
      announceForAccessibility: seams.announce,
    },
    Linking: {
      getInitialURL: seams.getInitialUrl,
      addEventListener: vi.fn((_event: string, listener: (event: { url: string }) => void) => {
        seams.linkListener = listener
        return { remove: vi.fn() }
      }),
      openSettings: vi.fn(),
    },
    TextInput: ({
      accessibilityLabel,
      onChangeText,
      placeholder,
      value,
    }: {
      accessibilityLabel?: string
      onChangeText?(value: string): void
      placeholder?: string
      value?: string
    }) => (
      <input
        aria-label={accessibilityLabel}
        placeholder={placeholder}
        value={value}
        onChange={(event) => onChangeText?.(event.currentTarget.value)}
      />
    ),
  }
})
vi.mock('../components/PairingScanner', () => ({ PairingScanner: () => null }))
vi.mock('../components/KeyboardAvoidingRoot', () => ({
  KeyboardAvoidingRoot: ({ children }: { children: ReactNode }) => children,
}))
vi.mock('../components/PressableScale', () => ({
  PressableScale: ({
    accessibilityLabel,
    children,
    onPress,
  }: {
    accessibilityLabel?: string
    children?: ReactNode
    onPress?(): void
  }) => (
    <button type="button" aria-label={accessibilityLabel} onClick={onPress}>
      {children}
    </button>
  ),
}))
vi.mock('./launch-ready', () => ({
  LaunchReadyView: ({ children }: { children: ReactNode }) => children,
}))
vi.mock('./pairing', () => ({
  claimMobilePairing: seams.claimPairing,
  normalizeManualServer: (origin: string) => origin,
  parsePairingLink: seams.parsePairing,
  pollMobilePairing: seams.pollPairing,
  preflightServer: seams.preflight,
}))
vi.mock('./profile-credentials', () => ({
  deleteProfileCredential: seams.deleteCredential,
  getProfileCredential: seams.getCredential,
  purgeOrphanedProfileCredentials: seams.purgeCredentials,
  setProfileCredential: seams.setCredential,
}))
vi.mock('./server-profiles', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./server-profiles')>()
  return {
    ...actual,
    loadServerProfiles: seams.loadProfiles,
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
vi.mock('./auth', () => ({ logout: seams.logout }))

import {
  resetInitialNativeLinkConsumptionForTests,
  ServerProfileGate,
  useServerProfile,
} from './ServerProfileGate'
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
  const instanceId =
    origin === 'https://a.example'
      ? 'instance-a'
      : origin === 'https://pair.example'
        ? 'pair-instance'
        : 'instance-b'
  return {
    ok: true as const,
    httpOrigin: origin,
    wsClientUrl: `${origin.replace('https:', 'wss:')}/client`,
    instanceId,
    mode: 'protected' as const,
    transport: 'trusted-https' as const,
  }
}

function handoffLink(origin: string, instanceId: string, session = 'session-private-id'): string {
  return formatPodiumLink(PODIUM_SCHEME, {
    kind: 'session',
    session,
    search: `?origin=${encodeURIComponent(origin)}&instance=${encodeURIComponent(instanceId)}`,
  })
}

const PAIRING_SECRET = 'pairing-secret-must-not-survive'
const PAIRING_LINK = `podium://pair?url=${encodeURIComponent(`https://pair.example/mobile#pair=${PAIRING_SECRET}`)}`

function storedProfiles() {
  return {
    activeProfileId: 'profile-a',
    profiles: [
      {
        id: 'profile-a',
        name: 'Server A',
        httpOrigin: 'https://a.example',
        instanceId: 'instance-a',
        mode: 'protected' as const,
        transport: 'trusted-https' as const,
        userId: 'user:a',
        createdAt: '2026-08-01T00:00:00.000Z',
        updatedAt: '2026-08-01T00:00:00.000Z',
      },
      {
        id: 'profile-b',
        name: 'Server B',
        httpOrigin: 'https://b.example',
        instanceId: 'instance-b',
        mode: 'protected' as const,
        transport: 'trusted-https' as const,
        userId: 'user:b',
        createdAt: '2026-08-01T00:00:00.000Z',
        updatedAt: '2026-08-01T00:00:00.000Z',
      },
    ],
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
  resetInitialNativeLinkConsumptionForTests()
  consumePendingMobileHandoff(pendingMobileHandoffSnapshot().id)
  seams.activeContext = null
  seams.alert.mockReset()
  seams.announce.mockReset()
  seams.getInitialUrl.mockReset()
  seams.getInitialUrl.mockResolvedValue(null)
  seams.linkListener = null
  seams.durableProfiles = storedProfiles()
  seams.loadProfiles.mockReset()
  seams.loadProfiles.mockImplementation(async () => seams.durableProfiles!)
  seams.parsePairing.mockReset()
  seams.parsePairing.mockReturnValue({
    source: 'custom-scheme',
    envelope: {
      v: 2,
      kind: 'mobile-client',
      mode: 'pair',
      serverUrl: 'https://pair.example',
      pairCode: '0123456789abcdef0123456789abcdef',
      expiresAt: '2099-01-01T00:00:00.000Z',
      instanceId: 'pair-instance',
    },
  })
  seams.credentials.clear()
  seams.credentials.set('profile-a', 'token-a')
  seams.credentials.set('profile-b', 'token-b')
  seams.runtime.length = 0
  seams.socket.length = 0
  seams.renders.length = 0
  seams.preflight.mockReset()
  seams.preflight.mockImplementation(async (origin: string) => successfulPreflight(origin))
  seams.claimPairing.mockReset()
  seams.claimPairing.mockResolvedValue({
    claimToken: 'claim-token',
    phrase: ['safe', 'profile', 'handoff'],
  })
  seams.pollPairing.mockReset()
  seams.pollPairing.mockResolvedValue({
    status: 'paired',
    bearer: 'token-c',
    userId: 'user:c',
  })
  seams.purgeCredentials.mockReset()
  seams.purgeCredentials.mockResolvedValue(undefined)
  seams.router.replace.mockReset()
  seams.logout.mockReset()
  seams.logout.mockResolvedValue(undefined)
  seams.saveProfiles.mockReset()
  seams.saveProfiles.mockImplementation(async (state) => {
    seams.durableProfiles = state
  })
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
  it('captures a cold ordinary navigation link without invoking pairing', async () => {
    seams.getInitialUrl.mockResolvedValue(
      formatPodiumLink(PODIUM_SCHEME, { kind: 'issue', issue: 'POD-1710' }),
    )
    render(
      <ServerProfileGate>
        <ProfileProbe />
      </ServerProfileGate>,
    )

    await waitFor(() => expect(pendingMobileHandoffSnapshot().profileSelected).toBe(true))
    expect(pendingMobileHandoffSnapshot().request).toEqual({
      kind: 'navigation',
      target: { kind: 'issue', issue: 'POD-1710' },
    })
    expect(seams.parsePairing).not.toHaveBeenCalled()
  })

  it('captures a warm ordinary navigation link without invoking pairing', async () => {
    await mountActiveProfileA()

    act(() => {
      seams.linkListener?.({
        url: formatPodiumLink(PODIUM_SCHEME, {
          kind: 'session',
          session: 'POD-1710-A',
        }),
      })
    })

    await waitFor(() => expect(pendingMobileHandoffSnapshot().profileSelected).toBe(true))
    expect(pendingMobileHandoffSnapshot().request).toEqual({
      kind: 'navigation',
      target: { kind: 'session', session: 'POD-1710-A' },
    })
    expect(seams.parsePairing).not.toHaveBeenCalled()
  })

  it('keeps a warm event authoritative over an older deferred initial URL', async () => {
    let resolveInitialUrl = (_url: string | null) => {}
    const initialUrlResolved = new Promise<string | null>((resolve) => {
      resolveInitialUrl = resolve
    })
    seams.getInitialUrl.mockImplementation(() => initialUrlResolved)
    render(
      <ServerProfileGate>
        <ProfileProbe />
      </ServerProfileGate>,
    )
    await waitFor(() => expect(seams.linkListener).not.toBeNull())

    act(() => {
      seams.linkListener?.({
        url: handoffLink('https://b.example', 'instance-b', 'newer-warm-session'),
      })
    })
    await act(async () => {
      resolveInitialUrl(PAIRING_LINK)
      await initialUrlResolved
    })

    await waitFor(() => expect(seams.activeContext?.profile.id).toBe('profile-b'))
    expect(pendingMobileHandoffSnapshot()).toMatchObject({
      profileSelected: true,
      request: {
        kind: 'destination',
        destination: { sessionId: 'newer-warm-session' },
      },
    })
    expect(seams.parsePairing).not.toHaveBeenCalled()
    expect(seams.getInitialUrl).toHaveBeenCalledTimes(1)
    expect(JSON.stringify(pendingMobileHandoffSnapshot())).not.toContain(PAIRING_SECRET)
  })

  it('resolves a cold initial handoff before releasing the previously active profile', async () => {
    seams.getInitialUrl.mockResolvedValue(
      handoffLink('https://b.example', 'instance-b', 'cold-session-on-b'),
    )

    render(
      <ServerProfileGate>
        <ProfileProbe />
      </ServerProfileGate>,
    )

    await waitFor(() => expect(seams.activeContext?.profile.id).toBe('profile-b'))
    expect(seams.preflight.mock.calls.map(([origin]) => origin)).toEqual(['https://b.example'])
    expect(seams.getCredential).not.toHaveBeenCalledWith('profile-a')
    expect([...seams.runtime, ...seams.socket]).not.toContainEqual({
      origin: 'https://a.example',
      bearer: 'token-a',
    })
  })

  it('fails a cold unmatched handoff to Work and restores the saved active profile', async () => {
    seams.getInitialUrl.mockResolvedValue(
      handoffLink('https://missing.example', 'missing-instance', 'unavailable-session'),
    )

    render(
      <ServerProfileGate>
        <ProfileProbe />
      </ServerProfileGate>,
    )

    await waitFor(() => {
      expect(seams.activeContext?.profile.id).toBe('profile-a')
      expect(seams.activeContext?.bearer).toBe('token-a')
    })
    expect(pendingMobileHandoffSnapshot().request).toBeNull()
    expect(seams.router.replace).toHaveBeenCalledWith('/work')
    expect(seams.router.replace.mock.calls.map(([route]) => route)).toEqual(['/', '/work'])
    expect(seams.preflight.mock.calls.map(([origin]) => origin)).toEqual(['https://a.example'])
    expect(seams.getInitialUrl).toHaveBeenCalledTimes(1)
    expect(seams.announce).toHaveBeenCalledWith(
      'Opened Work because the matching saved server is unavailable.',
    )
  })

  it('reselects a warm handoff that arrives while stored startup is pending', async () => {
    let releaseProfileA = () => {}
    const profileAReleased = new Promise<void>((resolve) => {
      releaseProfileA = resolve
    })
    let reportProfileAStarted = () => {}
    const profileAStarted = new Promise<void>((resolve) => {
      reportProfileAStarted = resolve
    })
    seams.preflight.mockImplementation(async (origin: string) => {
      if (origin === 'https://a.example') {
        reportProfileAStarted()
        await profileAReleased
      }
      return successfulPreflight(origin)
    })
    render(
      <ServerProfileGate>
        <ProfileProbe />
      </ServerProfileGate>,
    )
    await profileAStarted

    act(() => {
      seams.linkListener?.({
        url: handoffLink('https://b.example', 'instance-b', 'warm-session-on-b'),
      })
      releaseProfileA()
    })

    await waitFor(() => expect(seams.activeContext?.profile.id).toBe('profile-b'))
    expect(seams.preflight.mock.calls.map(([origin]) => origin)).toEqual([
      'https://a.example',
      'https://b.example',
    ])
    expect(seams.getCredential).not.toHaveBeenCalledWith('profile-a')
    expect([...seams.runtime, ...seams.socket]).not.toContainEqual({
      origin: 'https://a.example',
      bearer: 'token-a',
    })
  })

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

  it('clears a cold-start activation failure after the handoff profile verifies', async () => {
    seams.preflight.mockImplementation(async (origin: string) => {
      if (origin === 'https://a.example') {
        return {
          ok: false as const,
          kind: 'not-podium' as const,
          title: 'Not a Podium server',
          detail: 'The saved server identity could not be verified.',
          transport: 'trusted-https' as const,
        }
      }
      return successfulPreflight(origin)
    })
    render(
      <ServerProfileGate>
        <ProfileProbe />
      </ServerProfileGate>,
    )
    await waitFor(() => expect(seams.preflight).toHaveBeenCalledWith('https://a.example'))
    expect(seams.activeContext).toBeNull()

    act(() => {
      captureMobileHandoffUrl(
        formatPodiumLink(PODIUM_SCHEME, {
          kind: 'session',
          session: 'session-on-b',
          search: '?origin=https%3A%2F%2Fb.example&instance=instance-b',
        }),
      )
    })

    await waitFor(() => expect(seams.activeContext?.profile.id).toBe('profile-b'))
    expect(seams.activeContext?.bearer).toBe('token-b')
    expect(pendingMobileHandoffSnapshot().profileSelected).toBe(true)
  })
})

describe('pairing supersedes handoff intent', () => {
  it('restores the saved profile when cold initial pairing is canceled', async () => {
    seams.getInitialUrl.mockResolvedValue(PAIRING_LINK)
    render(
      <ServerProfileGate>
        <ProfileProbe />
      </ServerProfileGate>,
    )

    const cancel = await screen.findByLabelText('Cancel server setup')
    expect(seams.getCredential).not.toHaveBeenCalledWith('profile-a')
    fireEvent.click(cancel)

    await waitFor(() => {
      expect(seams.activeContext?.profile.id).toBe('profile-a')
      expect(seams.activeContext?.bearer).toBe('token-a')
    })
    expect(pendingMobileHandoffSnapshot().request).toBeNull()
    expect(seams.preflight).toHaveBeenCalledWith('https://a.example')
    expect(seams.getInitialUrl).toHaveBeenCalledTimes(1)
  })

  it('retires a pending handoff before parsing a newer pairing secret', async () => {
    await mountActiveProfileA()
    act(() => {
      captureMobileHandoffUrl(handoffLink('https://a.example', 'instance-a'))
    })
    const handoffId = pendingMobileHandoffSnapshot().id

    act(() => {
      seams.linkListener?.({ url: PAIRING_LINK })
    })

    expect(pendingMobileHandoffSnapshot()).toMatchObject({
      id: expect.any(Number),
      request: null,
      profileSelected: false,
    })
    expect(pendingMobileHandoffSnapshot().id).toBeGreaterThan(handoffId)
    expect(seams.router.replace).toHaveBeenCalledWith('/')
    expect(seams.parsePairing).toHaveBeenCalledWith(PAIRING_LINK)
    expect(seams.router.replace.mock.invocationCallOrder.at(-1)).toBeLessThan(
      seams.parsePairing.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY,
    )
    expect(JSON.stringify(pendingMobileHandoffSnapshot())).not.toContain(PAIRING_SECRET)
  })

  it('does not publish a pairing completion superseded during its profile save', async () => {
    await mountActiveProfileA()
    seams.logout.mockRejectedValueOnce(new Error('revocation unavailable'))
    let releasePairingSave = () => {}
    const pairingSaveReleased = new Promise<void>((resolve) => {
      releasePairingSave = resolve
    })
    let reportPairingSaveStarted = () => {}
    const pairingSaveStarted = new Promise<void>((resolve) => {
      reportPairingSaveStarted = resolve
    })
    seams.saveProfiles.mockImplementation(async (state) => {
      const active = state.profiles.find((profile) => profile.id === state.activeProfileId)
      if (active?.httpOrigin === 'https://pair.example') {
        seams.durableProfiles = state
        reportPairingSaveStarted()
        await pairingSaveReleased
        throw new Error('pair profile storage failed')
      }
      seams.durableProfiles = state
    })
    act(() => {
      seams.linkListener?.({ url: PAIRING_LINK })
    })
    fireEvent.click(await screen.findByLabelText('Request approval'))
    await pairingSaveStarted

    act(() => {
      seams.linkListener?.({
        url: handoffLink('https://b.example', 'instance-b', 'newest-session-on-b'),
      })
    })
    await act(async () => {
      releasePairingSave()
      await pairingSaveReleased
    })

    await waitFor(() => {
      expect(seams.activeContext?.profile.id).toBe('profile-b')
      expect(seams.activeContext?.bearer).toBe('token-b')
      expect(pendingMobileHandoffSnapshot().profileSelected).toBe(true)
    })
    expect(seams.durableProfiles?.activeProfileId).toBe('profile-b')
    expect([...seams.credentials.values()]).not.toContain('token-c')
    expect(seams.logout).toHaveBeenCalledWith('https://pair.example', 'token-c')
    expect(seams.alert).toHaveBeenCalledWith(
      'Phone session still active',
      'A superseded phone session could not be revoked. Revoke it from Settings → Connected devices on the server.',
    )
    expect(JSON.stringify(seams.alert.mock.calls)).not.toContain('token-c')
    expect(pendingMobileHandoffSnapshot()).toMatchObject({
      request: {
        kind: 'destination',
        destination: { sessionId: 'newest-session-on-b' },
      },
    })
  })

  it('does not publish an offline save superseded during its profile write', async () => {
    await mountActiveProfileA()
    seams.preflight.mockImplementation(async (origin: string) => {
      if (origin === 'https://offline.example') {
        return {
          ok: false as const,
          kind: 'unreachable' as const,
          title: 'Server unavailable',
          detail: 'Try again when this phone can reach the server.',
          transport: 'trusted-https' as const,
        }
      }
      return successfulPreflight(origin)
    })
    let releaseOfflineSave = () => {}
    const offlineSaveReleased = new Promise<void>((resolve) => {
      releaseOfflineSave = resolve
    })
    let reportOfflineSaveStarted = () => {}
    const offlineSaveStarted = new Promise<void>((resolve) => {
      reportOfflineSaveStarted = resolve
    })
    seams.saveProfiles.mockImplementation(async (state) => {
      const active = state.profiles.find((profile) => profile.id === state.activeProfileId)
      if (active?.httpOrigin === 'https://offline.example') {
        seams.durableProfiles = state
        reportOfflineSaveStarted()
        await offlineSaveReleased
        return
      }
      seams.durableProfiles = state
    })
    seams.parsePairing.mockImplementationOnce(() => {
      throw new Error('Use a server address instead.')
    })
    act(() => {
      seams.linkListener?.({ url: PAIRING_LINK })
    })
    fireEvent.click(await screen.findByLabelText('Enter server address'))
    fireEvent.change(screen.getByPlaceholderText('https://podium.example'), {
      target: { value: 'https://offline.example' },
    })
    fireEvent.click(screen.getByLabelText('Check server'))
    fireEvent.click(await screen.findByLabelText('Save for later'))
    await offlineSaveStarted

    act(() => {
      seams.linkListener?.({
        url: handoffLink('https://a.example', 'instance-a', 'newest-session-on-a'),
      })
    })
    await act(async () => {
      releaseOfflineSave()
      await offlineSaveReleased
    })

    await waitFor(() => {
      expect(seams.activeContext?.profile.id).toBe('profile-a')
      expect(pendingMobileHandoffSnapshot().profileSelected).toBe(true)
    })
    expect(seams.durableProfiles?.activeProfileId).toBe('profile-a')
    expect(seams.durableProfiles?.profiles).not.toContainEqual(
      expect.objectContaining({ httpOrigin: 'https://offline.example' }),
    )
  })

  it('waits for cold handoff rollback before recovering from pairing cancellation', async () => {
    seams.getInitialUrl.mockResolvedValue(
      handoffLink('https://b.example', 'instance-b', 'cold-session-on-b'),
    )
    let releaseProfileBSave = () => {}
    const profileBSaveReleased = new Promise<void>((resolve) => {
      releaseProfileBSave = resolve
    })
    let reportProfileBSaveStarted = () => {}
    const profileBSaveStarted = new Promise<void>((resolve) => {
      reportProfileBSaveStarted = resolve
    })
    seams.saveProfiles.mockImplementation(async (state) => {
      if (state.activeProfileId === 'profile-b') {
        // Model a store whose durable value becomes observable before its
        // completion promise settles.
        seams.durableProfiles = state
        reportProfileBSaveStarted()
        await profileBSaveReleased
        return
      }
      seams.durableProfiles = state
    })
    render(
      <ServerProfileGate>
        <ProfileProbe />
      </ServerProfileGate>,
    )
    await profileBSaveStarted

    act(() => {
      seams.linkListener?.({ url: PAIRING_LINK })
    })
    fireEvent.click(await screen.findByLabelText('Cancel server setup'))
    expect(seams.durableProfiles?.activeProfileId).toBe('profile-b')

    await act(async () => {
      releaseProfileBSave()
      await profileBSaveReleased
    })

    await waitFor(() => {
      expect(seams.activeContext?.profile.id).toBe('profile-a')
      expect(seams.activeContext?.bearer).toBe('token-a')
    })
    expect(seams.durableProfiles?.activeProfileId).toBe('profile-a')
    expect(seams.getCredential).not.toHaveBeenCalledWith('profile-b')
    expect([...seams.runtime, ...seams.socket]).not.toContainEqual({
      origin: 'https://b.example',
      bearer: 'token-b',
    })
  })

  it('keeps a pairing credential durable when pairing completes during cold startup purge', async () => {
    let releasePurge = () => {}
    const purgeReleased = new Promise<void>((resolve) => {
      releasePurge = resolve
    })
    let reportPurgeStarted = () => {}
    const purgeStarted = new Promise<void>((resolve) => {
      reportPurgeStarted = resolve
    })
    seams.purgeCredentials.mockImplementation(async (profileIds) => {
      reportPurgeStarted()
      await purgeReleased
      for (const profileId of seams.credentials.keys()) {
        if (!profileIds.includes(profileId)) seams.credentials.delete(profileId)
      }
    })
    render(
      <ServerProfileGate>
        <ProfileProbe />
      </ServerProfileGate>,
    )
    await purgeStarted
    await waitFor(() => expect(seams.linkListener).not.toBeNull())

    act(() => {
      seams.linkListener?.({ url: PAIRING_LINK })
    })
    fireEvent.click(await screen.findByLabelText('Request approval'))

    await waitFor(() => {
      const durableActive = seams.durableProfiles?.profiles.find(
        (profile) => profile.id === seams.durableProfiles?.activeProfileId,
      )
      expect(durableActive?.httpOrigin).toBe('https://pair.example')
    })
    expect(seams.setCredential).not.toHaveBeenCalledWith(expect.any(String), 'token-c')

    await act(async () => {
      releasePurge()
      await purgeReleased
    })

    await waitFor(() => {
      expect(seams.activeContext?.config.httpOrigin).toBe('https://pair.example')
      expect(seams.activeContext?.bearer).toBe('token-c')
    })
    const durableActive = seams.durableProfiles?.profiles.find(
      (profile) => profile.id === seams.durableProfiles?.activeProfileId,
    )
    expect(durableActive).toMatchObject({
      instanceId: 'pair-instance',
      userId: 'user:c',
    })
    expect(seams.credentials.get(durableActive?.id ?? '')).toBe('token-c')
    expect(seams.purgeCredentials).toHaveBeenCalledWith(['profile-a', 'profile-b'])
  })

  it('lets pairing completion own a still-draining cold handoff startup', async () => {
    seams.getInitialUrl.mockResolvedValue(
      handoffLink('https://b.example', 'instance-b', 'cold-session-on-b'),
    )
    let releaseProfileBSave = () => {}
    const profileBSaveReleased = new Promise<void>((resolve) => {
      releaseProfileBSave = resolve
    })
    let reportProfileBSaveStarted = () => {}
    const profileBSaveStarted = new Promise<void>((resolve) => {
      reportProfileBSaveStarted = resolve
    })
    seams.saveProfiles.mockImplementation(async (state) => {
      if (state.activeProfileId === 'profile-b') {
        seams.durableProfiles = state
        reportProfileBSaveStarted()
        await profileBSaveReleased
        return
      }
      seams.durableProfiles = state
    })
    render(
      <ServerProfileGate>
        <ProfileProbe />
      </ServerProfileGate>,
    )
    await profileBSaveStarted

    act(() => {
      seams.linkListener?.({ url: PAIRING_LINK })
    })
    fireEvent.click(await screen.findByLabelText('Request approval'))

    await act(async () => {
      releaseProfileBSave()
      await profileBSaveReleased
    })

    await waitFor(() => {
      expect(seams.activeContext?.config.httpOrigin).toBe('https://pair.example')
      expect(seams.activeContext?.bearer).toBe('token-c')
    })
    const durableActive = seams.durableProfiles?.profiles.find(
      (profile) => profile.id === seams.durableProfiles?.activeProfileId,
    )
    expect(durableActive).toMatchObject({
      httpOrigin: 'https://pair.example',
      instanceId: 'pair-instance',
      userId: 'user:c',
    })
    expect(seams.getCredential).not.toHaveBeenCalledWith('profile-b')
    expect([...seams.runtime, ...seams.socket]).not.toContainEqual({
      origin: 'https://b.example',
      bearer: 'token-b',
    })
  })

  it('lets an offline profile save own a still-draining cold handoff startup', async () => {
    seams.getInitialUrl.mockResolvedValue(
      handoffLink('https://b.example', 'instance-b', 'cold-session-on-b'),
    )
    seams.preflight.mockImplementation(async (origin: string) => {
      if (origin === 'https://offline.example') {
        return {
          ok: false as const,
          kind: 'unreachable' as const,
          title: 'Server unavailable',
          detail: 'Try again when this phone can reach the server.',
          transport: 'trusted-https' as const,
        }
      }
      return successfulPreflight(origin)
    })
    let releaseProfileBSave = () => {}
    const profileBSaveReleased = new Promise<void>((resolve) => {
      releaseProfileBSave = resolve
    })
    let reportProfileBSaveStarted = () => {}
    const profileBSaveStarted = new Promise<void>((resolve) => {
      reportProfileBSaveStarted = resolve
    })
    seams.saveProfiles.mockImplementation(async (state) => {
      if (state.activeProfileId === 'profile-b') {
        seams.durableProfiles = state
        reportProfileBSaveStarted()
        await profileBSaveReleased
        return
      }
      seams.durableProfiles = state
    })
    render(
      <ServerProfileGate>
        <ProfileProbe />
      </ServerProfileGate>,
    )
    await profileBSaveStarted

    seams.parsePairing.mockImplementationOnce(() => {
      throw new Error('Use a server address instead.')
    })
    act(() => {
      seams.linkListener?.({ url: PAIRING_LINK })
    })
    fireEvent.click(await screen.findByLabelText('Enter server address'))
    fireEvent.change(screen.getByPlaceholderText('https://podium.example'), {
      target: { value: 'https://offline.example' },
    })
    fireEvent.click(screen.getByLabelText('Check server'))
    fireEvent.click(await screen.findByLabelText('Save for later'))

    await act(async () => {
      releaseProfileBSave()
      await profileBSaveReleased
    })

    await waitFor(() => expect(screen.getByText('Server saved for later')).toBeTruthy())
    const durableActive = seams.durableProfiles?.profiles.find(
      (profile) => profile.id === seams.durableProfiles?.activeProfileId,
    )
    expect(durableActive).toMatchObject({ httpOrigin: 'https://offline.example' })
    expect(seams.getCredential).not.toHaveBeenCalledWith('profile-b')
    expect([...seams.runtime, ...seams.socket]).not.toContainEqual({
      origin: 'https://b.example',
      bearer: 'token-b',
    })

    seams.preflight.mockImplementation(async (origin: string) => successfulPreflight(origin))
    fireEvent.click(screen.getByLabelText('Retry safely'))
    await waitFor(() => {
      expect(seams.activeContext?.config.httpOrigin).toBe('https://offline.example')
      expect(seams.activeContext?.profile.id).toBe(durableActive?.id)
    })
    expect(seams.getInitialUrl).toHaveBeenCalledTimes(1)
  })

  it('rolls back a late switch save before recovering from pairing cancellation', async () => {
    await mountActiveProfileA()
    let releaseProfileBSave = () => {}
    const profileBSaveReleased = new Promise<void>((resolve) => {
      releaseProfileBSave = resolve
    })
    let reportProfileBSaveStarted = () => {}
    const profileBSaveStarted = new Promise<void>((resolve) => {
      reportProfileBSaveStarted = resolve
    })
    seams.saveProfiles.mockImplementation(async (state) => {
      if (state.activeProfileId === 'profile-b') {
        reportProfileBSaveStarted()
        await profileBSaveReleased
      }
      seams.durableProfiles = state
    })

    act(() => {
      captureMobileHandoffUrl(handoffLink('https://b.example', 'instance-b'))
    })
    await profileBSaveStarted
    act(() => {
      seams.linkListener?.({ url: PAIRING_LINK })
    })
    fireEvent.click(await screen.findByLabelText('Cancel server setup'))

    await act(async () => {
      releaseProfileBSave()
      await profileBSaveReleased
    })

    await waitFor(() => {
      expect(seams.activeContext?.profile.id).toBe('profile-a')
      expect(seams.activeContext?.bearer).toBe('token-a')
    })
    expect(pendingMobileHandoffSnapshot().request).toBeNull()
    expect(seams.durableProfiles?.activeProfileId).toBe('profile-a')
    expect(seams.saveProfiles.mock.calls.at(-1)?.[0]).toMatchObject({
      activeProfileId: 'profile-a',
    })
    expect([...seams.runtime, ...seams.socket]).not.toContainEqual({
      origin: 'https://b.example',
      bearer: 'token-b',
    })
  })

  it('lets pairing completion durably win over an older blocked switch save', async () => {
    await mountActiveProfileA()
    let releaseProfileBSave = () => {}
    const profileBSaveReleased = new Promise<void>((resolve) => {
      releaseProfileBSave = resolve
    })
    let reportProfileBSaveStarted = () => {}
    const profileBSaveStarted = new Promise<void>((resolve) => {
      reportProfileBSaveStarted = resolve
    })
    seams.saveProfiles.mockImplementation(async (state) => {
      if (state.activeProfileId === 'profile-b') {
        reportProfileBSaveStarted()
        await profileBSaveReleased
      }
      seams.durableProfiles = state
    })

    act(() => {
      captureMobileHandoffUrl(handoffLink('https://b.example', 'instance-b'))
    })
    await profileBSaveStarted
    act(() => {
      seams.linkListener?.({ url: PAIRING_LINK })
    })
    fireEvent.click(await screen.findByLabelText('Request approval'))

    await act(async () => {
      releaseProfileBSave()
      await profileBSaveReleased
    })

    await waitFor(() => {
      expect(seams.activeContext?.config.httpOrigin).toBe('https://pair.example')
      expect(seams.activeContext?.bearer).toBe('token-c')
    })
    const durableActive = seams.durableProfiles?.profiles.find(
      (profile) => profile.id === seams.durableProfiles?.activeProfileId,
    )
    expect(durableActive).toMatchObject({
      httpOrigin: 'https://pair.example',
      instanceId: 'pair-instance',
      userId: 'user:c',
    })
    expect(seams.saveProfiles.mock.calls.at(-1)?.[0].activeProfileId).toBe(durableActive?.id)
    expect(pendingMobileHandoffSnapshot().request).toBeNull()
    expect(JSON.stringify(seams.durableProfiles)).not.toContain(PAIRING_SECRET)
  })
})

describe('profile credential completion races', () => {
  it('merges a delayed A principal record before handoff activates B', async () => {
    await mountActiveProfileA()
    const recordUserA = seams.activeContext!.recordUser
    let releaseRecord = () => {}
    const recordReleased = new Promise<void>((resolve) => {
      releaseRecord = resolve
    })
    let reportRecordStarted = () => {}
    const recordStarted = new Promise<void>((resolve) => {
      reportRecordStarted = resolve
    })
    seams.saveProfiles.mockImplementation(async (state) => {
      const profileA = state.profiles.find((profile) => profile.id === 'profile-a')
      if (state.activeProfileId === 'profile-a' && profileA?.userId === 'user:a-late') {
        seams.durableProfiles = state
        reportRecordStarted()
        await recordReleased
        return
      }
      seams.durableProfiles = state
    })
    const recording = recordUserA('user:a-late').then(
      () => null,
      (error: unknown) => error,
    )
    await recordStarted

    act(() => {
      seams.linkListener?.({
        url: handoffLink('https://b.example', 'instance-b', 'session-on-b'),
      })
    })
    await act(async () => {
      releaseRecord()
      await recordReleased
    })
    const recordError = await recording

    await waitFor(() => {
      expect(seams.activeContext?.profile.id).toBe('profile-b')
      expect(seams.activeContext?.bearer).toBe('token-b')
    })
    expect(recordError).toBeNull()
    expect(seams.durableProfiles?.activeProfileId).toBe('profile-b')
    expect(
      seams.durableProfiles?.profiles.find((profile) => profile.id === 'profile-a')?.userId,
    ).toBe('user:a-late')
    expect([...seams.runtime, ...seams.socket]).not.toContainEqual({
      origin: 'https://a.example',
      bearer: 'token-b',
    })
  })

  it('completes a delayed principal record without disrupting a same-profile handoff', async () => {
    await mountActiveProfileA()
    const recordUserA = seams.activeContext!.recordUser
    let releaseRecord = () => {}
    const recordReleased = new Promise<void>((resolve) => {
      releaseRecord = resolve
    })
    let reportRecordStarted = () => {}
    const recordStarted = new Promise<void>((resolve) => {
      reportRecordStarted = resolve
    })
    seams.saveProfiles.mockImplementation(async (state) => {
      const profileA = state.profiles.find((profile) => profile.id === 'profile-a')
      if (profileA?.userId === 'user:a-late') {
        seams.durableProfiles = state
        reportRecordStarted()
        await recordReleased
        return
      }
      seams.durableProfiles = state
    })
    const recording = recordUserA('user:a-late')
    await recordStarted

    act(() => {
      seams.linkListener?.({
        url: handoffLink('https://a.example', 'instance-a', 'same-profile-session'),
      })
    })
    await act(async () => {
      releaseRecord()
      await Promise.all([recordReleased, recording])
    })

    await waitFor(() => {
      expect(pendingMobileHandoffSnapshot().profileSelected).toBe(true)
      expect(seams.activeContext?.profile.id).toBe('profile-a')
      expect(seams.activeContext?.bearer).toBe('token-a')
    })
    expect(
      seams.durableProfiles?.profiles.find((profile) => profile.id === 'profile-a')?.userId,
    ).toBe('user:a-late')
    expect(seams.activeContext?.profile.userId).toBe('user:a-late')
    await act(async () => {
      await seams.activeContext!.updateCredential('post-handoff-token-a')
    })
    expect(seams.activeContext?.bearer).toBe('post-handoff-token-a')
  })

  it('preserves a queued principal merge when pairing becomes active', async () => {
    await mountActiveProfileA()
    const recordUserA = seams.activeContext!.recordUser
    let releaseRecord = () => {}
    const recordReleased = new Promise<void>((resolve) => {
      releaseRecord = resolve
    })
    let reportRecordStarted = () => {}
    const recordStarted = new Promise<void>((resolve) => {
      reportRecordStarted = resolve
    })
    seams.saveProfiles.mockImplementation(async (state) => {
      const profileA = state.profiles.find((profile) => profile.id === 'profile-a')
      if (state.activeProfileId === 'profile-a' && profileA?.userId === 'user:a-late') {
        seams.durableProfiles = state
        reportRecordStarted()
        await recordReleased
        return
      }
      seams.durableProfiles = state
    })
    const recording = recordUserA('user:a-late')
    await recordStarted

    act(() => {
      seams.linkListener?.({ url: PAIRING_LINK })
    })
    fireEvent.click(await screen.findByLabelText('Request approval'))
    await act(async () => {
      releaseRecord()
      await Promise.all([recordReleased, recording])
    })

    await waitFor(() => {
      expect(seams.activeContext?.config.httpOrigin).toBe('https://pair.example')
      expect(seams.activeContext?.bearer).toBe('token-c')
    })
    expect(
      seams.durableProfiles?.profiles.find((profile) => profile.id === 'profile-a')?.userId,
    ).toBe('user:a-late')
  })

  it('preserves a queued principal merge when an offline profile is saved', async () => {
    await mountActiveProfileA()
    const recordUserA = seams.activeContext!.recordUser
    seams.preflight.mockImplementation(async (origin: string) => {
      if (origin === 'https://offline.example') {
        return {
          ok: false as const,
          kind: 'unreachable' as const,
          title: 'Server unavailable',
          detail: 'Try again when this phone can reach the server.',
          transport: 'trusted-https' as const,
        }
      }
      return successfulPreflight(origin)
    })
    let releaseRecord = () => {}
    const recordReleased = new Promise<void>((resolve) => {
      releaseRecord = resolve
    })
    let reportRecordStarted = () => {}
    const recordStarted = new Promise<void>((resolve) => {
      reportRecordStarted = resolve
    })
    seams.saveProfiles.mockImplementation(async (state) => {
      const profileA = state.profiles.find((profile) => profile.id === 'profile-a')
      if (state.activeProfileId === 'profile-a' && profileA?.userId === 'user:a-late') {
        seams.durableProfiles = state
        reportRecordStarted()
        await recordReleased
        return
      }
      seams.durableProfiles = state
    })
    const recording = recordUserA('user:a-late')
    await recordStarted

    seams.parsePairing.mockImplementationOnce(() => {
      throw new Error('Use a server address instead.')
    })
    act(() => {
      seams.linkListener?.({ url: PAIRING_LINK })
    })
    fireEvent.click(await screen.findByLabelText('Enter server address'))
    fireEvent.change(screen.getByPlaceholderText('https://podium.example'), {
      target: { value: 'https://offline.example' },
    })
    fireEvent.click(screen.getByLabelText('Check server'))
    fireEvent.click(await screen.findByLabelText('Save for later'))
    await act(async () => {
      releaseRecord()
      await Promise.all([recordReleased, recording])
    })

    await waitFor(() => expect(screen.getByText('Server saved for later')).toBeTruthy())
    const durableActive = seams.durableProfiles?.profiles.find(
      (profile) => profile.id === seams.durableProfiles?.activeProfileId,
    )
    expect(durableActive?.httpOrigin).toBe('https://offline.example')
    expect(
      seams.durableProfiles?.profiles.find((profile) => profile.id === 'profile-a')?.userId,
    ).toBe('user:a-late')
  })

  it('rebinds credential ownership after a same-profile handoff', async () => {
    await mountActiveProfileA()
    const priorUpdateCredential = seams.activeContext!.updateCredential

    act(() => {
      seams.linkListener?.({
        url: handoffLink('https://a.example', 'instance-a', 'same-profile-session'),
      })
    })
    await waitFor(() => {
      expect(pendingMobileHandoffSnapshot().profileSelected).toBe(true)
      expect(seams.activeContext?.updateCredential).not.toBe(priorUpdateCredential)
    })

    await act(async () => {
      await seams.activeContext!.updateCredential('refreshed-token-a')
    })
    expect(seams.credentials.get('profile-a')).toBe('refreshed-token-a')
    expect(seams.activeContext?.bearer).toBe('refreshed-token-a')
  })

  it('rebinds credential ownership after pairing is opened and canceled', async () => {
    await mountActiveProfileA()
    const priorUpdateCredential = seams.activeContext!.updateCredential

    act(() => {
      seams.linkListener?.({ url: PAIRING_LINK })
    })
    fireEvent.click(await screen.findByLabelText('Cancel server setup'))
    await waitFor(() => {
      expect(seams.activeContext?.updateCredential).not.toBe(priorUpdateCredential)
    })

    await act(async () => {
      await seams.activeContext!.updateCredential('post-cancel-token-a')
    })
    expect(seams.credentials.get('profile-a')).toBe('post-cancel-token-a')
    expect(seams.activeContext?.bearer).toBe('post-cancel-token-a')
  })

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
