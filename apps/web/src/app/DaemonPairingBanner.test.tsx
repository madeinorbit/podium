import { act, cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { NativeDesktopBridge } from '@/lib/nativeDesktop'
import {
  DAEMON_CONNECTIVITY_POLL_MS,
  DAEMON_PAIRING_BANNER_HEIGHT_VAR,
  DaemonPairingBanner,
} from './DaemonPairingBanner'

const desktop = globalThis as {
  __PODIUM_DESKTOP__?: NativeDesktopBridge
  __PODIUM_SETTINGS__?: () => void
}

afterEach(() => {
  cleanup()
  vi.useRealTimers()
  delete desktop.__PODIUM_DESKTOP__
  delete desktop.__PODIUM_SETTINGS__
  document.documentElement.style.removeProperty(DAEMON_PAIRING_BANNER_HEIGHT_VAR)
})

function bridge(
  daemonConnectivity: NonNullable<NativeDesktopBridge['daemonConnectivity']>,
): NativeDesktopBridge {
  return {
    platform: 'linux',
    launchMode: 'daemon',
    minimize: vi.fn(async () => {}),
    toggleMaximize: vi.fn(async () => {}),
    close: vi.fn(async () => {}),
    daemonConnectivity,
  }
}

describe('DaemonPairingBanner', () => {
  it('stays silent for a valid pairing and reachable server', async () => {
    desktop.__PODIUM_DESKTOP__ = bridge(
      vi.fn(async () => ({
        state: 'connected' as const,
        serverUrl: 'wss://podium.example',
        updatedAt: '2026-08-26T10:00:00.000Z',
      })),
    )

    await act(async () => render(<DaemonPairingBanner />))

    expect(screen.queryByRole('alert')).toBeNull()
    expect(document.documentElement.style.getPropertyValue(DAEMON_PAIRING_BANNER_HEIGHT_VAR)).toBe(
      '',
    )
  })

  it('polls startup until it exposes a terminal refusal and its recovery', async () => {
    vi.useFakeTimers()
    const read = vi.fn().mockResolvedValueOnce(null).mockResolvedValueOnce({
      state: 'unauthorized',
      serverUrl: 'wss://operator:secret@podium.example/?token=secret',
      authorizationReason: 'peerHelloRejected: invalid or expired code',
      updatedAt: '2026-08-26T10:00:00.000Z',
    })
    desktop.__PODIUM_DESKTOP__ = bridge(read)
    desktop.__PODIUM_SETTINGS__ = vi.fn()
    render(<DaemonPairingBanner />)

    await act(async () => {
      await Promise.resolve()
      vi.advanceTimersByTime(DAEMON_CONNECTIVITY_POLL_MS)
      await Promise.resolve()
    })

    const alert = screen.getByRole('alert')
    expect(alert.textContent).toMatch(/wss:\/\/podium\.example/)
    expect(alert.textContent).not.toMatch(/operator|secret|token/)
    expect(alert.textContent).toMatch(/invalid, expired, or has already been used/i)
    expect(alert.textContent).toMatch(/create a new one-use code/i)
    expect(alert.textContent).not.toMatch(/try again/i)
    screen.getByRole('button', { name: /open settings/i }).click()
    expect(desktop.__PODIUM_SETTINGS__).toHaveBeenCalledOnce()
    expect(
      document.documentElement.style.getPropertyValue(DAEMON_PAIRING_BANNER_HEIGHT_VAR),
    ).not.toBe('')
  })

  it('does not run in a browser or client-only shell', async () => {
    const read = vi.fn()
    desktop.__PODIUM_DESKTOP__ = { ...bridge(read), launchMode: 'client' }
    await act(async () => render(<DaemonPairingBanner />))
    expect(read).not.toHaveBeenCalled()
    expect(screen.queryByRole('alert')).toBeNull()
  })
})
