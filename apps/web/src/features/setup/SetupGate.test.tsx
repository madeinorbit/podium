import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

const connect = vi.hoisted(() => vi.fn().mockResolvedValue({ mode: 'all-in-one' }))

vi.mock('@/app/trpc', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/app/trpc')>()
  return {
    ...actual,
    makeTrpc: () => ({ setup: { connect: { mutate: connect } } }),
  }
})

import {
  classifySetupStatus,
  isTrustedLocalSetupOrigin,
  SetupGate,
  shouldApplyLocalSetupDefault,
} from './SetupGate'

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  vi.useRealTimers()
  ;(globalThis as { __PODIUM_SKIP_SETUP__?: boolean }).__PODIUM_SKIP_SETUP__ = undefined
  ;(globalThis as { __PODIUM_LOCAL_SETUP__?: boolean }).__PODIUM_LOCAL_SETUP__ = undefined
  connect.mockClear()
})

const child = <div>APP-READY</div>

describe('SetupGate', () => {
  it('trusts only loopback and bundled desktop origins for automatic local setup', () => {
    expect(isTrustedLocalSetupOrigin({ protocol: 'http:', hostname: 'localhost' })).toBe(true)
    expect(isTrustedLocalSetupOrigin({ protocol: 'http:', hostname: '127.0.0.1' })).toBe(true)
    expect(isTrustedLocalSetupOrigin({ protocol: 'http:', hostname: '[::1]' })).toBe(true)
    expect(isTrustedLocalSetupOrigin({ protocol: 'tauri:', hostname: 'tauri.localhost' })).toBe(
      true,
    )
    expect(isTrustedLocalSetupOrigin({ protocol: 'https:', hostname: 'podium.example' })).toBe(
      false,
    )
    expect(
      shouldApplyLocalSetupDefault(
        { needsSetup: true },
        { protocol: 'https:', hostname: 'podium.example' },
        false,
        true,
      ),
    ).toBe(false)
  })

  it('uses only public readiness for a ready remote desktop client', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ state: 'ready', reason: null, dataPlane: 'available' }),
    })
    vi.stubGlobal('fetch', fetchMock)
    ;(globalThis as { __PODIUM_SKIP_SETUP__?: boolean }).__PODIUM_SKIP_SETUP__ = true
    render(<SetupGate>{child}</SetupGate>)
    expect(await screen.findByText('APP-READY')).toBeTruthy()
    expect(fetchMock).toHaveBeenCalledOnce()
    expect(fetchMock.mock.calls[0]?.[0]).toMatch(/\/readiness$/)
  })

  it('directs an unconfigured remote desktop client back to its host without mutations', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        state: 'unconfigured',
        reason: 'setup_required',
        dataPlane: 'blocked',
      }),
    })
    vi.stubGlobal('fetch', fetchMock)
    ;(globalThis as { __PODIUM_SKIP_SETUP__?: boolean }).__PODIUM_SKIP_SETUP__ = true
    render(<SetupGate>{child}</SetupGate>)

    expect(await screen.findByText(/finish setup on the server/i)).toBeTruthy()
    expect(screen.queryByText('APP-READY')).toBeNull()
    expect(connect).not.toHaveBeenCalled()
    expect(fetchMock.mock.calls[0]?.[0]).toMatch(/\/readiness$/)
  })

  it('keeps compatibility with a remote server that predates public readiness', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('CORS unavailable')))
    ;(globalThis as { __PODIUM_SKIP_SETUP__?: boolean }).__PODIUM_SKIP_SETUP__ = true
    render(<SetupGate>{child}</SetupGate>)

    expect(await screen.findByText('APP-READY')).toBeTruthy()
  })

  it('shows onboarding when the backend reports needsSetup', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue({ status: 200, ok: true, json: async () => ({ needsSetup: true }) }),
    )
    render(<SetupGate>{child}</SetupGate>)
    expect(await screen.findByText(/welcome to podium/i)).toBeTruthy()
    expect(screen.queryByText('APP-READY')).toBeNull()
  })

  it('sends an unconfigured remote browser to the host without exposing mutations', () => {
    expect(
      classifySetupStatus(
        {
          needsSetup: true,
          state: 'unconfigured',
          reason: 'setup_required',
          dataPlane: 'blocked',
        },
        { protocol: 'https:', hostname: 'podium.example' },
      ),
    ).toBe('remote-setup')
  })

  it('renders activation pending as restart-only and never reconnects setup', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        status: 200,
        ok: true,
        headers: new Headers(),
        json: async () => ({
          needsSetup: true,
          state: 'activation_pending',
          reason: 'restart_required',
          dataPlane: 'blocked',
        }),
      }),
    )
    render(<SetupGate>{child}</SetupGate>)
    expect(await screen.findByText(/setup is saved; podium needs to restart/i)).toBeTruthy()
    expect(connect).not.toHaveBeenCalled()
  })

  it('renders the app for degraded readiness because the data plane is available', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        status: 200,
        ok: true,
        headers: new Headers(),
        json: async () => ({
          needsSetup: false,
          state: 'degraded',
          reason: 'agent_unavailable',
          dataPlane: 'available',
        }),
      }),
    )
    render(<SetupGate>{child}</SetupGate>)
    expect(await screen.findByText('APP-READY')).toBeTruthy()
  })

  it('applies a source launcher local default before entering the app', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        status: 200,
        ok: true,
        headers: new Headers({ 'X-Podium-Local-Setup': 'all-in-one' }),
        json: async () => ({ needsSetup: true }),
      }),
    )
    render(<SetupGate>{child}</SetupGate>)
    expect(await screen.findByText(/starting podium on this machine/i)).toBeTruthy()
    expect(screen.queryByText(/how should this install run/i)).toBeNull()
    expect(connect).toHaveBeenCalledWith({ mode: 'all-in-one' })
  })

  it('renders the app when setup is already done', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        status: 200,
        ok: true,
        json: async () => ({ needsSetup: false }),
      }),
    )
    render(<SetupGate>{child}</SetupGate>)
    expect(await screen.findByText('APP-READY')).toBeTruthy()
  })

  it('treats a 404 (backend without the setup route) as ready, not a block', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ status: 404, ok: false, json: async () => ({}) }),
    )
    render(<SetupGate>{child}</SetupGate>)
    expect(await screen.findByText('APP-READY')).toBeTruthy()
  })

  it('treats a 200 that is not JSON (SPA index.html fallback) as ready, not unreachable', async () => {
    // A relay without the setup route serves the SPA HTML for /setup/config — res.json() throws.
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        status: 200,
        ok: true,
        json: async () => {
          throw new SyntaxError('Unexpected token < in JSON')
        },
      }),
    )
    render(<SetupGate>{child}</SetupGate>)
    expect(await screen.findByText('APP-READY')).toBeTruthy()
  })

  it('treats a 200 with an unexpected JSON shape as ready, not a block', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ status: 200, ok: true, json: async () => ({ unrelated: 1 }) }),
    )
    render(<SetupGate>{child}</SetupGate>)
    expect(await screen.findByText('APP-READY')).toBeTruthy()
  })

  it('surfaces an error (not the app) when the backend is unreachable', async () => {
    vi.useFakeTimers()
    // Reject every probe — the cross-origin/CORS-blocked case that used to silently skip onboarding.
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Failed to fetch')))
    render(<SetupGate>{child}</SetupGate>)
    // Drive all bounded-backoff retries to exhaustion.
    for (let i = 0; i < 8; i++) await vi.advanceTimersByTimeAsync(4000)
    expect(screen.getByRole('heading', { name: /the backend went quiet/i })).toBeTruthy()
    expect(screen.getByText('podium status')).toBeTruthy()
    expect(screen.getByRole('button', { name: /retry connection/i })).toBeTruthy()
    expect(screen.queryByText('APP-READY')).toBeNull()
  })

  it('restarts the setup probe when the recovery console retries', async () => {
    vi.useFakeTimers()
    const fetchMock = vi.fn().mockRejectedValue(new TypeError('Failed to fetch'))
    vi.stubGlobal('fetch', fetchMock)
    render(<SetupGate>{child}</SetupGate>)
    for (let i = 0; i < 8; i++) await vi.advanceTimersByTimeAsync(4000)

    screen.getByRole('button', { name: /retry connection/i }).click()
    await vi.advanceTimersByTimeAsync(1)

    expect(fetchMock.mock.calls.length).toBeGreaterThan(7)
  })
})
