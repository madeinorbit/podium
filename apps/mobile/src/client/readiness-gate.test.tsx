import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ReadinessGate } from './ReadinessGate'

// ReadinessGate shares its production module graph with the launch and profile
// composition roots plus the press-feedback primitive. None of those native
// integrations is under test here, and loading their CommonJS graphs bypasses
// Vite's react-native-web alias.
vi.mock('expo-router', () => ({
  SplashScreen: {
    preventAutoHideAsync: vi.fn(async () => {}),
    hideAsync: vi.fn(async () => {}),
  },
  useRouter: () => ({ replace: vi.fn() }),
}))
vi.mock('expo-haptics', () => ({
  ImpactFeedbackStyle: { Light: 'light' },
  impactAsync: vi.fn(async () => {}),
}))
vi.mock('./ServerProfileGate', () => ({ useOptionalServerProfile: () => null }))

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  window.history.replaceState({}, '', '/')
})

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
})
