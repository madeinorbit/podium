import type { MachineWire } from '@podium/protocol'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Store } from '@/app/store'
import type { NativeDesktopBridge } from '@/lib/nativeDesktop'

// [spec:SP-3701] Hosting affordances in the machines panel: standalone card for
// never-paired devices, "this machine" badge + inline Enable for paired ones.

const storeState: { machines: MachineWire[]; trpc: Store['trpc']; setSettingsTab: () => void } = {
  machines: [],
  trpc: {} as Store['trpc'],
  setSettingsTab: () => {},
}

vi.mock('@/app/store', () => ({
  useStoreSelector: (selector: (s: typeof storeState) => unknown) => selector(storeState),
}))

// NetworkStep/RepoScanFlow drag in the whole setup flow; the card/row tests never render them.
vi.mock('@/features/setup/SetupView', () => ({ NetworkStep: () => null }))
vi.mock('@/features/setup/RepoScanFlow', () => ({ RepoScanFlow: () => null }))

import { MachinesPanel } from './MachinesPanel'

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  storeState.machines = []
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

function machine(overrides: Partial<MachineWire>): MachineWire {
  return {
    id: 'm-1',
    name: 'mac',
    hostname: 'mac.local',
    online: false,
    lastSeenAt: Date.now() - 60_000,
    ...overrides,
  } as MachineWire
}

function setTrpc(mutate: () => Promise<{ code: string; joinCommand: string | null }>) {
  storeState.trpc = {
    machines: { pairingCode: { mutate } },
    setup: { info: { query: vi.fn().mockResolvedValue({ publicUrl: null }) } },
  } as unknown as Store['trpc']
}

const enableCard = () => screen.queryByRole('button', { name: /host sessions on this device/i })

describe('MachinesPanel hosting affordances', () => {
  it('shows neither card nor badge outside the desktop shell', () => {
    storeState.machines = [machine({})]
    setTrpc(vi.fn())
    render(<MachinesPanel />)
    expect(enableCard()).toBeNull()
    expect(screen.queryByText(/this machine/i)).toBeNull()
  })

  it('shows the standalone card when this device never paired', () => {
    stubBridge({ machineId: undefined })
    storeState.machines = [machine({ id: 'other' })]
    setTrpc(vi.fn())
    render(<MachinesPanel />)
    expect(enableCard()).toBeTruthy()
    expect(screen.queryByText(/this machine/i)).toBeNull()
  })

  it('marks the paired row and offers inline Enable when offline, instead of the card', () => {
    stubBridge({ machineId: 'm-1' })
    storeState.machines = [machine({ id: 'm-1', online: false }), machine({ id: 'other' })]
    setTrpc(vi.fn())
    render(<MachinesPanel />)
    expect(enableCard()).toBeNull()
    expect(screen.getByText(/this machine/i)).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Enable' })).toBeTruthy()
  })

  it('shows the badge but no Enable button when this device is online', () => {
    stubBridge({ machineId: 'm-1' })
    storeState.machines = [machine({ id: 'm-1', online: true })]
    setTrpc(vi.fn())
    render(<MachinesPanel />)
    expect(enableCard()).toBeNull()
    expect(screen.getByText(/this machine/i)).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Enable' })).toBeNull()
  })

  it('inline Enable mints a code, hands it to the shell, and restarts', async () => {
    const bridge = stubBridge({ machineId: 'm-1' })
    const restart = vi.fn()
    ;(window as unknown as { __PODIUM_RESTART__?: () => void }).__PODIUM_RESTART__ = restart
    const mutate = vi.fn().mockResolvedValue({ code: 'ABCD-EFGH', joinCommand: null })
    storeState.machines = [machine({ id: 'm-1', online: false })]
    setTrpc(mutate)
    render(<MachinesPanel />)

    fireEvent.click(screen.getByRole('button', { name: 'Enable' }))

    await waitFor(() => expect(restart).toHaveBeenCalled())
    expect(mutate).toHaveBeenCalledTimes(1)
    expect(bridge.enableHosting).toHaveBeenCalledWith('ABCD-EFGH')
    // The app is restarting — the button must stay disabled (no double-enroll window).
    expect(screen.getByRole('button', { name: /enabling/i })).toHaveProperty('disabled', true)
  })

  it('falls back to manual-relaunch guidance when restart is refused', async () => {
    // Remote-loaded windows on older shells lack the process.restart grant; the config is
    // already flipped by then, so the UI must instruct rather than hang on "Enabling…".
    stubBridge({ machineId: 'm-1' })
    ;(window as unknown as { __PODIUM_RESTART__?: () => unknown }).__PODIUM_RESTART__ = vi
      .fn()
      .mockRejectedValue(new Error('process.restart not allowed'))
    storeState.machines = [machine({ id: 'm-1', online: false })]
    setTrpc(vi.fn().mockResolvedValue({ code: 'ABCD-EFGH', joinCommand: null }))
    render(<MachinesPanel />)

    fireEvent.click(screen.getByRole('button', { name: 'Enable' }))

    expect(await screen.findByText(/quit and reopen the app/i)).toBeTruthy()
  })

  it('surfaces errors and re-enables the card button', async () => {
    stubBridge({ machineId: undefined })
    setTrpc(vi.fn().mockRejectedValue(new Error('pairing is disabled on this server')))
    render(<MachinesPanel />)

    const button = enableCard()
    if (!button) throw new Error('card missing')
    fireEvent.click(button)

    expect(await screen.findByText(/pairing is disabled on this server/)).toBeTruthy()
    expect(enableCard()).toHaveProperty('disabled', false)
  })
})

// POD-838: each row shows the daemon's reported build version; a version that trails the
// server's gets an "update available" badge. 'dev' builds never badge (no comparable number).
describe('MachinesPanel version skew', () => {
  function setTrpcWithVersion(appVersion: string) {
    storeState.trpc = {
      setup: { info: { query: vi.fn().mockResolvedValue({ publicUrl: null, appVersion }) } },
    } as unknown as Store['trpc']
  }

  it('shows the daemon version and badges a machine behind the server', async () => {
    storeState.machines = [
      machine({
        inventory: { os: 'darwin', arch: 'arm64', podiumVersion: '0.4.1', agents: [], tools: [] },
      }),
    ]
    setTrpcWithVersion('0.5.0')
    render(<MachinesPanel />)

    expect(await screen.findByText('0.4.1')).toBeTruthy()
    expect(await screen.findByText(/update available/i)).toBeTruthy()
  })

  it('does not badge a machine on the server version', async () => {
    storeState.machines = [
      machine({
        inventory: { os: 'linux', arch: 'x64', podiumVersion: '0.5.0', agents: [], tools: [] },
      }),
    ]
    setTrpcWithVersion('0.5.0')
    render(<MachinesPanel />)

    expect(await screen.findByText('0.5.0')).toBeTruthy()
    expect(screen.queryByText(/update available/i)).toBeNull()
  })

  it('never badges dev builds or machines with no reported version', async () => {
    storeState.machines = [
      machine({
        id: 'm-dev',
        name: 'devbox',
        inventory: { os: 'linux', arch: 'x64', podiumVersion: 'dev', agents: [], tools: [] },
      }),
      machine({ id: 'm-old', name: 'pre-inventory' }),
    ]
    setTrpcWithVersion('0.5.0')
    render(<MachinesPanel />)

    expect(await screen.findByText('dev')).toBeTruthy()
    expect(screen.queryByText(/update available/i)).toBeNull()
  })
})
