import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

// This gate never renders sign-in. Keep its native animation stack out of the
// web test module graph so the case measures only the offline admission chain.
vi.mock('../screens/LoginScreen', () => ({ LoginScreen: () => null }))

import {
  preparePrincipalNamespace,
  REPLICA_KEY_PREFIX,
  replicaNamespaceKey,
} from '@podium/client-core/replica'
import { AuthGate } from './AuthGate'
import { ReadinessGate } from './ReadinessGate'
import { ServerProfileContext, type ServerProfileContextValue } from './server-profile-context'

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  window.localStorage.clear()
})

function offlineProfile(): ServerProfileContextValue {
  const noop = async () => {}
  return {
    profile: {
      id: 'saved-server',
      name: 'Saved server',
      httpOrigin: 'https://podium.example',
      instanceId: 'instance-a',
      mode: 'protected',
      transport: 'trusted-https',
      userId: 'user:alice',
      memberId: 'user:alice',
      syncBoundaryId: 'installation-a',
      createdAt: '2026-08-01T00:00:00.000Z',
      updatedAt: '2026-08-01T00:00:00.000Z',
    },
    profiles: [],
    config: {
      httpOrigin: 'https://podium.example',
      wsClientUrl: 'wss://podium.example/client',
      override: false,
    },
    bearer: null,
    activation: 'offline-cache',
    runtimeKey: 'saved-server:0',
    isEphemeralOverride: false,
    beginAddServer: () => {},
    switchProfile: noop,
    renameProfile: noop,
    removeProfile: noop,
    updateCredential: noop,
    recordUser: noop,
    revalidateOfflineProfile: noop,
  }
}

describe('profile-bound offline gate chain', () => {
  it('mounts the saved workspace without asking the network to name another principal', async () => {
    const fetch = vi.fn(async () => {
      throw new TypeError('Network request failed')
    })
    vi.stubGlobal('fetch', fetch)
    const profile = offlineProfile()
    profile.profiles.push(profile.profile)

    render(
      <ServerProfileContext.Provider value={profile}>
        <ReadinessGate>
          <AuthGate>
            <div>SAVED WORKSPACE</div>
          </AuthGate>
        </ReadinessGate>
      </ServerProfileContext.Provider>,
    )

    expect(await screen.findByText('SAVED WORKSPACE')).toBeTruthy()
    expect(fetch).not.toHaveBeenCalled()
  })

  // POD-7176: the phone web, started online (a verified profile), mounted again
  // with no network. It holds the replica a verified connection opened, so
  // neither gate stops it; the replica boot names the same member offline.
  it('phone web: a remount with no network opens the replica this browser holds', async () => {
    preparePrincipalNamespace({
      storage: window.localStorage,
      enumerateKeys: () => Object.keys(window.localStorage),
      basePrefix: REPLICA_KEY_PREFIX,
      principal: replicaNamespaceKey({ syncBoundaryId: 'installation-a', memberId: 'mem_alice' }),
    })
    const fetch = vi.fn(async () => {
      throw new TypeError('Failed to fetch')
    })
    vi.stubGlobal('fetch', fetch)
    const profile = offlineProfile()
    profile.activation = 'verified'
    profile.profile = {
      id: 'single-server',
      name: 'podium.example',
      httpOrigin: 'https://podium.example',
      mode: 'protected',
      transport: 'trusted-https',
      createdAt: '2026-08-01T00:00:00.000Z',
      updatedAt: '2026-08-01T00:00:00.000Z',
    }

    render(
      <ServerProfileContext.Provider value={profile}>
        <ReadinessGate>
          <AuthGate>
            <div>SAVED WORKSPACE</div>
          </AuthGate>
        </ReadinessGate>
      </ServerProfileContext.Provider>,
    )

    expect(await screen.findByText('SAVED WORKSPACE')).toBeTruthy()
    expect(screen.queryByText('Cannot reach this Podium server')).toBeNull()
  })

  it('phone web: with nothing held, no network is still "Cannot reach this Podium server"', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('Failed to fetch')
      }),
    )
    const profile = offlineProfile()
    profile.activation = 'verified'

    render(
      <ServerProfileContext.Provider value={profile}>
        <ReadinessGate>
          <AuthGate>
            <div>SAVED WORKSPACE</div>
          </AuthGate>
        </ReadinessGate>
      </ServerProfileContext.Provider>,
    )

    expect(await screen.findByText('Cannot reach this Podium server')).toBeTruthy()
    expect(screen.queryByText('SAVED WORKSPACE')).toBeNull()
  })
})
