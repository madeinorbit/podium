import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

// This gate never renders sign-in. Keep its native animation stack out of the
// web test module graph so the case measures only the offline admission chain.
vi.mock('../screens/LoginScreen', () => ({ LoginScreen: () => null }))

import { AuthGate } from './AuthGate'
import { ReadinessGate } from './ReadinessGate'
import { ServerProfileContext, type ServerProfileContextValue } from './server-profile-context'

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
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
})
