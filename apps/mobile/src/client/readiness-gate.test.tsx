import {
  preparePrincipalNamespace,
  REPLICA_KEY_PREFIX,
  replicaNamespaceKey,
} from '@podium/client-core/replica'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

// AsyncStorage's CommonJS entry loads Flow-typed React Native under vitest, so
// every mobile test stands it in. On the phone web it IS localStorage: read
// the markers the producer wrote there.
vi.mock('@react-native-async-storage/async-storage', () => ({
  default: {
    getAllKeys: async () => Object.keys(window.localStorage),
    multiGet: async (keys: readonly string[]) =>
      keys.map((key) => [key, window.localStorage.getItem(key)] as const),
  },
}))

import { ReadinessGate } from './ReadinessGate'

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  window.history.replaceState({}, '', '/')
  window.localStorage.clear()
})

/** What a replica opening writes once the server named its member. */
function holdReplica(): void {
  preparePrincipalNamespace({
    storage: window.localStorage,
    enumerateKeys: () => Object.keys(window.localStorage),
    basePrefix: REPLICA_KEY_PREFIX,
    principal: replicaNamespaceKey({ syncBoundaryId: 'installation-a', memberId: 'mem_alice' }),
  })
}

function response(body: unknown) {
  vi.stubGlobal(
    'fetch',
    vi.fn(
      async () =>
        new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } }),
    ),
  )
}

describe('mobile server readiness gate', () => {
  it('does not mount the operator product while setup is unconfigured', async () => {
    response({ state: 'unconfigured', reason: 'setup_required', dataPlane: 'blocked' })
    render(
      <ReadinessGate>
        <div>OPERATOR PRODUCT</div>
      </ReadinessGate>,
    )
    expect(await screen.findByText('Finish setup on the server')).toBeTruthy()
    expect(screen.queryByText('OPERATOR PRODUCT')).toBeNull()
  })

  it('names the saved-setup restart boundary', async () => {
    response({ state: 'activation_pending', reason: 'restart_required', dataPlane: 'blocked' })
    render(
      <ReadinessGate>
        <div>OPERATOR PRODUCT</div>
      </ReadinessGate>,
    )
    expect(await screen.findByText('Setup is saved; Podium needs to restart')).toBeTruthy()
    expect(screen.queryByText('OPERATOR PRODUCT')).toBeNull()
  })

  it('opens immediately only when the server reports ready', async () => {
    response({ state: 'ready', reason: null, dataPlane: 'available' })
    render(
      <ReadinessGate>
        <div>OPERATOR PRODUCT</div>
      </ReadinessGate>,
    )
    expect(await screen.findByText('OPERATOR PRODUCT')).toBeTruthy()
  })

  it('makes degraded entry explicit before allowing review', async () => {
    response({ state: 'degraded', reason: 'agent_unavailable', dataPlane: 'available' })
    render(
      <ReadinessGate>
        <div>OPERATOR PRODUCT</div>
      </ReadinessGate>,
    )
    expect(await screen.findByText('Server online; no agent machine available')).toBeTruthy()
    expect(screen.queryByText('OPERATOR PRODUCT')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Review work' }))
    expect(await screen.findByText('OPERATOR PRODUCT')).toBeTruthy()
  })

  it('distinguishes a corrupt live configuration from a disconnected agent machine', async () => {
    response({ state: 'degraded', reason: 'configuration_invalid', dataPlane: 'available' })
    render(
      <ReadinessGate>
        <div>OPERATOR PRODUCT</div>
      </ReadinessGate>,
    )
    expect(await screen.findByText('Server configuration needs repair')).toBeTruthy()
    expect(screen.queryByText('OPERATOR PRODUCT')).toBeNull()
  })

  it('uses network-safe recovery copy and retries the status probe', async () => {
    const fetch = vi
      .fn()
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ state: 'ready', reason: null, dataPlane: 'available' }), {
          headers: { 'content-type': 'application/json' },
        }),
      )
    vi.stubGlobal('fetch', fetch)
    render(
      <ReadinessGate>
        <div>OPERATOR PRODUCT</div>
      </ReadinessGate>,
    )
    expect(await screen.findByText('Cannot reach this Podium server')).toBeTruthy()
    expect(screen.getByText(/on-device data has not been changed/i)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    await waitFor(() => expect(screen.queryByText('OPERATOR PRODUCT')).toBeTruthy())
  })

  it('fails closed on a contradictory readiness response', async () => {
    response({ state: 'ready', reason: null, dataPlane: 'blocked' })
    render(
      <ReadinessGate>
        <div>OPERATOR PRODUCT</div>
      </ReadinessGate>,
    )
    expect(await screen.findByText('Cannot reach this Podium server')).toBeTruthy()
    expect(screen.queryByText('OPERATOR PRODUCT')).toBeNull()
  })

  // POD-7176: offline, the phone opens what it holds, as the desktop shell does.
  it('opens the data this device holds when the server cannot be asked at all', async () => {
    holdReplica()
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('Failed to fetch')
      }),
    )
    render(
      <ReadinessGate>
        <div>OPERATOR PRODUCT</div>
      </ReadinessGate>,
    )
    expect(await screen.findByText('OPERATOR PRODUCT')).toBeTruthy()
    expect(screen.queryByText('Cannot reach this Podium server')).toBeNull()
  })

  it('still fails closed on an answer that is not a readiness fact, data held or not', async () => {
    holdReplica()
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('bad gateway', { status: 502 })),
    )
    render(
      <ReadinessGate>
        <div>OPERATOR PRODUCT</div>
      </ReadinessGate>,
    )
    expect(await screen.findByText('Cannot reach this Podium server')).toBeTruthy()
    expect(screen.queryByText('OPERATOR PRODUCT')).toBeNull()
  })
})
