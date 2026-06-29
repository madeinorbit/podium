import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SetupGate } from './SetupGate'

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  vi.useRealTimers()
  ;(globalThis as { __PODIUM_SKIP_SETUP__?: boolean }).__PODIUM_SKIP_SETUP__ = undefined
})

const child = <div>APP-READY</div>

describe('SetupGate', () => {
  it('skips the probe and renders the app when __PODIUM_SKIP_SETUP__ is set (client/daemon)', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    ;(globalThis as { __PODIUM_SKIP_SETUP__?: boolean }).__PODIUM_SKIP_SETUP__ = true
    render(<SetupGate>{child}</SetupGate>)
    expect(await screen.findByText('APP-READY')).toBeTruthy()
    expect(fetchMock).not.toHaveBeenCalled() // must not probe the remote's /setup/config
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

  it('surfaces an error (not the app) when the backend is unreachable', async () => {
    vi.useFakeTimers()
    // Reject every probe — the cross-origin/CORS-blocked case that used to silently skip onboarding.
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Failed to fetch')))
    render(<SetupGate>{child}</SetupGate>)
    // Drive all bounded-backoff retries to exhaustion.
    for (let i = 0; i < 8; i++) await vi.advanceTimersByTimeAsync(4000)
    expect(screen.getByText(/can.t reach the podium backend/i)).toBeTruthy()
    expect(screen.queryByText('APP-READY')).toBeNull()
  })
})
