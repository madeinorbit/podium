import type { PodiumTarget } from '@podium/protocol'
// @vitest-environment happy-dom
import { formatPodiumLink, PODIUM_SCHEME } from '@podium/protocol'
import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import { NavigationContainerRefContext } from 'expo-router/build/react-navigation/core/NavigationContainerRefContext'
import type { ComponentProps } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { expoRootStateReader } from '../../test/expo-root-state'
import { poolRouteFixture } from '../../test/pool-routes'
import type { ServerProfileContextValue } from '../client/server-profile-context'
import type { ServerProfile } from '../client/server-profiles'

const seams = vi.hoisted(() => ({
  announce: vi.fn(),
  router: { replace: vi.fn(), push: vi.fn() },
  httpOrigin: 'https://current.example',
  issues: [] as Array<{ id: string; displayRef?: string }>,
  sessions: [] as Array<{ sessionId: string; displayRef?: string }>,
  booting: false,
  authStatus: { needsAuth: true, authed: true, userId: 'user-one' } as {
    needsAuth: boolean
    authed: boolean
    userId: string | null
  } | null,
  serverProfile: null as ServerProfileContextValue | null,
}))

vi.mock('expo-router', () => ({ useRouter: () => seams.router }))
vi.mock('react-native', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react-native')>()
  return {
    ...actual,
    Platform: { ...actual.Platform, OS: 'ios' },
    AccessibilityInfo: {
      ...actual.AccessibilityInfo,
      announceForAccessibility: seams.announce,
    },
  }
})
vi.mock('../client/auth-context', () => ({ useAuthStatus: () => seams.authStatus }))
vi.mock('../client/hooks', () => ({
  useHttpOrigin: () => seams.httpOrigin,
}))
vi.mock('../client/use-pool-links', () => ({
  usePoolLinkData: (target: PodiumTarget | null) => {
    const fixture = poolRouteFixture({ issues: seams.issues, sessions: seams.sessions })
    const route = target ? fixture.route(target) : null
    const session = target?.kind === 'session' ? fixture.views.session(target.session) : undefined
    fixture.dispose()
    return {
      booting: seams.booting,
      route,
      sessions: session && typeof session !== 'symbol' ? [session] : [],
      resolveRoute: (next: PodiumTarget) => {
        const current = poolRouteFixture({ issues: seams.issues, sessions: seams.sessions })
        try {
          return current.route(next)
        } finally {
          current.dispose()
        }
      },
    }
  },
}))
vi.mock('../client/server-profile-context', () => ({
  useServerProfile: () => seams.serverProfile,
}))

import {
  captureMobileHandoffUrl,
  consumePendingMobileHandoff,
  markPendingMobileHandoffProfileSelected,
  pendingMobileHandoffSnapshot,
} from '../client/mobile-handoff'
import { followPodiumLink } from '../lib/podium-link'
import { PodiumLinkHost } from './PodiumLinkHost'

const SESSION_ID = 'session-private-id'

function profile(overrides: Partial<ServerProfile> = {}): ServerProfile {
  return {
    id: 'profile-one',
    name: 'Current',
    httpOrigin: 'https://current.example',
    instanceId: 'instance-one',
    mode: 'protected',
    transport: 'trusted-https',
    userId: 'user-one',
    createdAt: '2026-08-31T00:00:00.000Z',
    updatedAt: '2026-08-31T00:00:00.000Z',
    ...overrides,
  }
}

function handoff(origin: string, instanceId = 'instance-one', sessionId = SESSION_ID): string {
  return formatPodiumLink(PODIUM_SCHEME, {
    kind: 'session',
    session: sessionId,
    search: `?origin=${encodeURIComponent(origin)}&instance=${encodeURIComponent(instanceId)}`,
  })
}

function context(
  active: ServerProfile,
  profiles: ServerProfile[],
  switchProfile = vi.fn(async () => {}),
): ServerProfileContextValue {
  return {
    profile: active,
    profiles,
    config: {
      httpOrigin: active.httpOrigin,
      wsClientUrl: `${active.httpOrigin.replace(/^http/, 'ws')}/client?v=1`,
      override: false,
    },
    bearer: 'bearer-is-never-rendered',
    activation: 'verified',
    runtimeKey: active.id,
    isEphemeralOverride: false,
    beginAddServer: vi.fn(),
    switchProfile,
    renameProfile: vi.fn(async () => {}),
    removeProfile: vi.fn(async () => {}),
    updateCredential: vi.fn(async () => {}),
    recordUser: vi.fn(async () => {}),
    revalidateOfflineProfile: vi.fn(async () => {}),
  }
}

beforeEach(() => {
  seams.announce.mockReset()
  seams.router.replace.mockReset()
  seams.router.push.mockReset()
  seams.sessions = []
  seams.issues = []
  seams.booting = false
  seams.authStatus = { needsAuth: true, authed: true, userId: 'user-one' }
  const current = profile()
  seams.serverProfile = context(current, [current])
  consumePendingMobileHandoff(pendingMobileHandoffSnapshot().id)
})

afterEach(() => cleanup())

describe('PodiumLinkHost mobile handoff integration', () => {
  it.each([
    'in-app markdown/action card',
    'OS deep link',
  ])('dismisses a root sheet before opening a console from an %s', async (source) => {
    seams.sessions = [{ sessionId: SESSION_ID }]
    const tabs = { key: 'tabs', name: '(tabs)' }
    const mission = { key: 'mission', name: 'mission/[missionId]', params: { missionId: 'root' } }
    const state = {
      key: 'root',
      type: 'stack',
      index: 2,
      routes: [tabs, mission, { key: 'sheet', name: 'launch/[issueId]' }],
    }
    const dispatch = vi.fn()
    const navigation = {
      getRootState: expoRootStateReader(() => state),
      dispatch,
    } as unknown as NonNullable<
      ComponentProps<typeof NavigationContainerRefContext.Provider>['value']
    >
    render(
      <NavigationContainerRefContext value={navigation}>
        <PodiumLinkHost />
      </NavigationContainerRefContext>,
    )

    act(() => {
      const url = `podium://session/${SESSION_ID}/terminal`
      if (source === 'OS deep link') {
        captureMobileHandoffUrl(url)
        markPendingMobileHandoffProfileSelected(pendingMobileHandoffSnapshot().id)
      } else followPodiumLink(url)
    })

    await waitFor(() => expect(seams.router.push).toHaveBeenCalledTimes(1))
    expect(seams.router.push.mock.calls[0]?.[0]).toBe(`/session/${SESSION_ID}/terminal`)
    expect(dispatch).toHaveBeenCalledWith({
      type: 'RESET',
      target: 'root',
      payload: { ...state, index: 1, routes: [tabs, mission] },
    })
    expect(dispatch.mock.invocationCallOrder[0]).toBeLessThan(
      seams.router.push.mock.invocationCallOrder[0] ?? 0,
    )
    expect(seams.router.replace).not.toHaveBeenCalled()
  })

  it('routes an OS-delivered issue through the pool route', async () => {
    seams.issues = [{ id: 'iss-1710', displayRef: 'POD-1710' }]
    render(<PodiumLinkHost />)

    act(() => {
      captureMobileHandoffUrl(formatPodiumLink(PODIUM_SCHEME, { kind: 'issue', issue: 'POD-1710' }))
      markPendingMobileHandoffProfileSelected(pendingMobileHandoffSnapshot().id)
    })

    await waitFor(() =>
      expect(seams.router.push).toHaveBeenCalledExactlyOnceWith('/issue/iss-1710', {
        withAnchor: true,
      }),
    )
    expect(seams.router.replace).not.toHaveBeenCalled()
  })

  it('waits for profile selection before opening from the authorized replica', async () => {
    seams.sessions = [{ sessionId: SESSION_ID }]
    render(<PodiumLinkHost />)

    act(() => {
      captureMobileHandoffUrl(handoff('https://current.example'))
    })

    await waitFor(() =>
      expect(screen.getByRole('status').textContent).toBe('Checking the matching saved server.'),
    )
    expect(seams.router.replace).not.toHaveBeenCalled()

    act(() => {
      markPendingMobileHandoffProfileSelected(pendingMobileHandoffSnapshot().id)
    })
    await waitFor(() =>
      expect(seams.router.push).toHaveBeenCalledExactlyOnceWith(`/session/${SESSION_ID}`, {
        withAnchor: true,
      }),
    )
    expect(seams.router.replace).not.toHaveBeenCalled()
    expect(screen.getByRole('status').textContent).toBe('Opening the session.')
  })

  it('fails an old link closed when the active origin now names a replacement instance', async () => {
    const replacement = profile({ instanceId: 'new-instance' })
    const switchProfile = vi.fn(async () => {})
    seams.serverProfile = context(replacement, [replacement], switchProfile)
    render(<PodiumLinkHost />)

    act(() => {
      captureMobileHandoffUrl(handoff(replacement.httpOrigin, 'old-instance'))
      markPendingMobileHandoffProfileSelected(pendingMobileHandoffSnapshot().id)
    })

    await waitFor(() => expect(seams.router.replace).toHaveBeenCalledWith('/work'))
    expect(switchProfile).not.toHaveBeenCalled()
    const status = screen.getByRole('status').textContent ?? ''
    expect(status).toContain('matching saved server is unavailable')
    expect(status).not.toContain(SESSION_ID)
    expect(status).not.toContain('old-instance')
  })

  it('falls back to Work without disclosing an absent session id', async () => {
    render(<PodiumLinkHost />)

    act(() => {
      captureMobileHandoffUrl(handoff('https://current.example'))
      markPendingMobileHandoffProfileSelected(pendingMobileHandoffSnapshot().id)
    })

    await waitFor(() => expect(seams.router.replace).toHaveBeenCalledWith('/work'))
    const status = screen.getByRole('status').textContent ?? ''
    expect(status).toContain('not available to this profile')
    expect(status).not.toContain(SESSION_ID)
    expect(seams.announce).toHaveBeenCalledWith(
      'Opened Work because this session is not available to this profile.',
    )
  })
})
