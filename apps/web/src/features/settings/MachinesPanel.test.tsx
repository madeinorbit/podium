import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Store } from '@/app/store'
import type { NativeDesktopBridge } from '@/lib/nativeDesktop'
import { HostThisDeviceCard } from './MachinesPanel'

// [spec:SP-3701] The "host sessions on this device" card for the desktop shell.

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  ;(globalThis as { __PODIUM_DESKTOP__?: NativeDesktopBridge }).__PODIUM_DESKTOP__ = undefined
  ;(window as unknown as { __PODIUM_RESTART__?: () => void }).__PODIUM_RESTART__ = undefined
})

function stubBridge(overrides: Partial<NativeDesktopBridge> = {}): NativeDesktopBridge {
  const bridge: NativeDesktopBridge = {
    platform: 'macos',
    launchMode: 'client',
    minimize: vi.fn(),
    toggleMaximize: vi.fn(),
    close: vi.fn(),
    enableHosting: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  }
  ;(globalThis as { __PODIUM_DESKTOP__?: NativeDesktopBridge }).__PODIUM_DESKTOP__ = bridge
  return bridge
}

function stubTrpc(mutate: () => Promise<{ code: string; joinCommand: string | null }>) {
  return { machines: { pairingCode: { mutate } } } as unknown as Store['trpc']
}

describe('HostThisDeviceCard', () => {
  it('renders nothing outside the desktop shell', () => {
    const { container } = render(
      <HostThisDeviceCard trpc={stubTrpc(vi.fn().mockResolvedValue({ code: 'X', joinCommand: null }))} />,
    )
    expect(container.innerHTML).toBe('')
  })

  it('renders nothing when the shell is not in client mode', () => {
    // A daemon/all-in-one install already hosts; the shell also omits enableHosting there.
    stubBridge({ launchMode: 'daemon', enableHosting: undefined })
    const { container } = render(
      <HostThisDeviceCard trpc={stubTrpc(vi.fn().mockResolvedValue({ code: 'X', joinCommand: null }))} />,
    )
    expect(container.innerHTML).toBe('')
  })

  it('mints a code, hands it to the shell, and restarts', async () => {
    const bridge = stubBridge()
    const restart = vi.fn()
    ;(window as unknown as { __PODIUM_RESTART__?: () => void }).__PODIUM_RESTART__ = restart
    const mutate = vi.fn().mockResolvedValue({ code: 'ABCD-EFGH', joinCommand: null })
    render(<HostThisDeviceCard trpc={stubTrpc(mutate)} />)

    fireEvent.click(screen.getByRole('button', { name: /host sessions on this device/i }))

    await waitFor(() => expect(restart).toHaveBeenCalled())
    expect(mutate).toHaveBeenCalledTimes(1)
    expect(bridge.enableHosting).toHaveBeenCalledWith('ABCD-EFGH')
    // The app is restarting — the button must stay disabled (no double-enroll window).
    expect(screen.getByRole('button', { name: /enabling/i })).toHaveProperty('disabled', true)
  })

  it('falls back to manual-relaunch guidance when restart is refused', async () => {
    // Remote-loaded windows on older shells lack the process.restart grant; the config is
    // already flipped by then, so the card must instruct rather than hang on "Enabling…".
    stubBridge()
    ;(window as unknown as { __PODIUM_RESTART__?: () => unknown }).__PODIUM_RESTART__ = vi
      .fn()
      .mockRejectedValue(new Error('process.restart not allowed'))
    const mutate = vi.fn().mockResolvedValue({ code: 'ABCD-EFGH', joinCommand: null })
    render(<HostThisDeviceCard trpc={stubTrpc(mutate)} />)

    fireEvent.click(screen.getByRole('button', { name: /host sessions on this device/i }))

    expect(await screen.findByText(/quit and reopen the app/i)).toBeTruthy()
  })

  it('surfaces errors and re-enables the button', async () => {
    stubBridge()
    const mutate = vi.fn().mockRejectedValue(new Error('pairing is disabled on this server'))
    render(<HostThisDeviceCard trpc={stubTrpc(mutate)} />)

    fireEvent.click(screen.getByRole('button', { name: /host sessions on this device/i }))

    expect(await screen.findByText(/pairing is disabled on this server/)).toBeTruthy()
    expect(
      screen.getByRole('button', { name: /host sessions on this device/i }),
    ).toHaveProperty('disabled', false)
  })
})
