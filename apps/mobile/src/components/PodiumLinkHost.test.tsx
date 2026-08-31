// @vitest-environment happy-dom
import { PODIUM_SCHEME, formatPodiumLink } from '@podium/protocol'
import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ServerProfileContextValue } from '../client/server-profile-context'
import type { ServerProfile } from '../client/server-profiles'

const seams = vi.hoisted(() => ({
  router: { replace: vi.fn(), push: vi.fn() },
  httpOrigin: 'https://current.example',
  issues: [] as Array<{ id: string }>,
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
vi.mock('../client/auth-context', () => ({ useAuthStatus: () => seams.authStatus }))
vi.mock('../client/hooks', () => ({
  useHttpOrigin: () => seams.httpOrigin,
  useIssues: () => seams.issues,
  useSessions: () => seams.sessions,
  useBooting: () => seams.booting,
}))
vi.mock('../client/server-profile-context', () => ({
  useServerProfile: () => seams.serverProfile,
}))

import {
  captureMobileHandoffUrl,
  consumePendingMobileHandoff,
  pendingMobileHandoffSnapshot,
} from '../client/mobile-handoff'
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
  seams.router.replace.mockReset()
  seams.router.push.mockReset()
  seams.sessions = []
  seams.booting = false
  seams.authStatus = { needsAuth: true, authed: true, userId: 'user-one' }
  const current = profile()
  seams.serverProfile = context(current, [current])
  consumePendingMobileHandoff(pendingMobileHandoffSnapshot().id)
})

afterEach(() => cleanup())

describe('PodiumLinkHost mobile handoff integration', () => {
  it('uses native replace only after the authorized replica contains the session', async () => {
    seams.sessions = [{ sessionId: SESSION_ID }]
    render(<PodiumLinkHost />)

    act(() => {
      captureMobileHandoffUrl(handoff('https://current.example'))
    })

    await waitFor(() => expect(seams.router.replace).toHaveBeenCalledWith(`/session/${SESSION_ID}`))
    expect(seams.router.push).not.toHaveBeenCalled()
    expect(screen.getByRole('status').textContent).toBe('Opening the session.')
  })

  it('fails an old link closed when the active origin now names a replacement instance', async () => {
    const replacement = profile({ instanceId: 'new-instance' })
    const switchProfile = vi.fn(async () => {})
    seams.serverProfile = context(replacement, [replacement], switchProfile)
    render(<PodiumLinkHost />)

    act(() => {
      captureMobileHandoffUrl(handoff(replacement.httpOrigin, 'old-instance'))
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
    })

    await waitFor(() => expect(seams.router.replace).toHaveBeenCalledWith('/work'))
    const status = screen.getByRole('status').textContent ?? ''
    expect(status).toContain('not available to this profile')
    expect(status).not.toContain(SESSION_ID)
  })
})
