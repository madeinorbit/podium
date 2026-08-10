import type { MachineWire } from '@podium/model'
import { asMachineId } from '@podium/model'
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
  useReplicaIssues: () => [],
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
    id: asMachineId('m-1'),
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
    storeState.machines = [machine({ id: asMachineId('other') })]
    setTrpc(vi.fn())
    render(<MachinesPanel />)
    expect(enableCard()).toBeTruthy()
    expect(screen.queryByText(/this machine/i)).toBeNull()
  })

  it('marks the paired row and offers inline Enable when offline, instead of the card', () => {
    stubBridge({ machineId: asMachineId('m-1') })
    storeState.machines = [
      machine({ id: asMachineId('m-1'), online: false }),
      machine({ id: asMachineId('other') }),
    ]
    setTrpc(vi.fn())
    render(<MachinesPanel />)
    expect(enableCard()).toBeNull()
    expect(screen.getByText(/this machine/i)).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Enable' })).toBeTruthy()
  })

  it('shows the badge but no Enable button when this device is online', () => {
    stubBridge({ machineId: asMachineId('m-1') })
    storeState.machines = [machine({ id: asMachineId('m-1'), online: true })]
    setTrpc(vi.fn())
    render(<MachinesPanel />)
    expect(enableCard()).toBeNull()
    expect(screen.getByText(/this machine/i)).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Enable' })).toBeNull()
  })

  it('inline Enable mints a code, hands it to the shell, and restarts', async () => {
    const bridge = stubBridge({ machineId: asMachineId('m-1') })
    const restart = vi.fn()
    ;(window as unknown as { __PODIUM_RESTART__?: () => void }).__PODIUM_RESTART__ = restart
    const mutate = vi.fn().mockResolvedValue({ code: 'ABCD-EFGH', joinCommand: null })
    storeState.machines = [machine({ id: asMachineId('m-1'), online: false })]
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
    stubBridge({ machineId: asMachineId('m-1') })
    ;(window as unknown as { __PODIUM_RESTART__?: () => unknown }).__PODIUM_RESTART__ = vi
      .fn()
      .mockRejectedValue(new Error('process.restart not allowed'))
    storeState.machines = [machine({ id: asMachineId('m-1'), online: false })]
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

// POD-838/POD-1873: each row shows the daemon's reported build version and compares it
// with that machine's selected channel target. Legacy projections fall back to the server.
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

  it('does not badge a machine current on its selected channel when the server differs', async () => {
    storeState.machines = [
      machine({
        inventory: {
          os: 'linux',
          arch: 'x64',
          podiumVersion: '0.1.3-edge.1',
          agents: [],
          tools: [],
        },
        appVersion: '0.1.3-edge.1',
        updateChannel: 'edge',
        targetVersion: '0.1.3-edge.1',
        versionState: 'current',
      }),
    ]
    setTrpcWithVersion('dev+7de565e')
    render(<MachinesPanel />)

    expect(await screen.findByText('0.1.3-edge.1')).toBeTruthy()
    expect(screen.queryByText(/update available/i)).toBeNull()
  })

  it('badges a machine behind its selected channel even when the server build differs', async () => {
    storeState.machines = [
      machine({
        inventory: {
          os: 'linux',
          arch: 'x64',
          podiumVersion: '0.4.1',
          agents: [],
          tools: [],
        },
        appVersion: '0.4.1',
        updateChannel: 'stable',
        targetVersion: '0.5.0',
        versionState: 'behind',
      }),
    ]
    setTrpcWithVersion('dev+7de565e')
    render(<MachinesPanel />)

    expect(await screen.findByText(/update available/i)).toBeTruthy()
  })

  it('never badges dev builds or machines with no reported version', async () => {
    storeState.machines = [
      machine({
        id: asMachineId('m-dev'),
        name: 'devbox',
        inventory: { os: 'linux', arch: 'x64', podiumVersion: 'dev', agents: [], tools: [] },
      }),
      machine({ id: asMachineId('m-old'), name: 'pre-inventory' }),
    ]
    setTrpcWithVersion('0.5.0')
    render(<MachinesPanel />)

    expect(await screen.findByText('dev')).toBeTruthy()
    expect(screen.queryByText(/update available/i)).toBeNull()
  })
})

/**
 * POD-1495 — the transfer affordance. The panel's ONE job at this boundary is to
 * not construct a call POD-1480's gate would refuse, and the refusals it must
 * not contradict are all reachable from `MachineWire.owned` alone.
 */
function setTransferTrpc(transferMutate: () => Promise<unknown>) {
  storeState.trpc = {
    machines: {
      pairingCode: { mutate: vi.fn() },
      transferOwnership: { mutate: transferMutate },
    },
    setup: { info: { query: vi.fn().mockResolvedValue({ publicUrl: null }) } },
  } as unknown as Store['trpc']
}

const transferButton = () => screen.queryByRole('button', { name: 'Transfer' })

describe('MachinesPanel ownership transfer', () => {
  it('offers Transfer on a machine you own', () => {
    storeState.machines = [machine({ owned: true })]
    setTransferTrpc(vi.fn())
    render(<MachinesPanel />)
    expect(transferButton()).toBeTruthy()
  })

  it('says NOTHING about transfer when you are not the owner — no disabled control, no explanation', () => {
    // A manage grantee and a see-only admin arrive here identically: `owned`
    // false. A disabled button or a "you cannot transfer this" line would
    // contradict the server, which answers absent-shaped for the machines it
    // will not confirm the existence of.
    storeState.machines = [machine({ owned: false })]
    setTransferTrpc(vi.fn())
    render(<MachinesPanel />)
    expect(transferButton()).toBeNull()
    expect(screen.queryByText(/transfer/i)).toBeNull()
  })

  it('treats an unevaluated `owned` as NO, never as yes', () => {
    // Absent means NOT EVALUATED — the same closed reading `use` carries. The
    // paired case above proves the row CAN render the button, so this null is
    // about the missing field.
    storeState.machines = [machine({})]
    setTransferTrpc(vi.fn())
    render(<MachinesPanel />)
    expect(transferButton()).toBeNull()
  })

  it('the confirmation names the loss of access AND the dropped shares', () => {
    storeState.machines = [machine({ owned: true, name: 'builder' })]
    setTransferTrpc(vi.fn())
    render(<MachinesPanel />)
    fireEvent.click(screen.getByRole('button', { name: 'Transfer' }))

    // The three facts a transfer dialog that omits any of them ships as a defect:
    // the recipient gets it, the giver loses it irreversibly, the shares go.
    const dialog = screen.getByRole('dialog')
    expect(dialog.textContent).toMatch(/you lose all three/i)
    expect(dialog.textContent).toMatch(/not be able to undo this or transfer it back/i)
    expect(dialog.textContent).toMatch(/every share on/i)
  })

  it('will not fire until a recipient is named and the machine name is typed back', async () => {
    const transferMutate = vi.fn().mockResolvedValue({})
    storeState.machines = [machine({ owned: true, name: 'builder' })]
    setTransferTrpc(transferMutate)
    render(<MachinesPanel />)
    fireEvent.click(screen.getByRole('button', { name: 'Transfer' }))

    const confirm = screen.getByRole('button', { name: 'Transfer ownership' })
    expect(confirm).toHaveProperty('disabled', true)

    // A recipient alone is not enough — this is the irreversible act.
    fireEvent.change(screen.getByLabelText(/new owner's account name/i), {
      target: { value: 'colleague' },
    })
    expect(confirm).toHaveProperty('disabled', true)

    // A WRONG machine name is not enough either, so the gate is the name and not
    // merely "something was typed".
    const nameField = screen.getByLabelText(/type the machine name to confirm/i)
    fireEvent.change(nameField, { target: { value: 'not-the-builder' } })
    expect(confirm).toHaveProperty('disabled', true)

    fireEvent.change(nameField, { target: { value: 'builder' } })
    expect(confirm).toHaveProperty('disabled', false)

    fireEvent.click(confirm)
    await waitFor(() =>
      expect(transferMutate).toHaveBeenCalledWith({ id: 'm-1', newOwnerUserId: 'colleague' }),
    )
  })

  it("surfaces the server's own refusal verbatim rather than a friendlier rewrite", async () => {
    const transferMutate = vi.fn().mockRejectedValue(new Error('unknown recipient'))
    storeState.machines = [machine({ owned: true, name: 'builder' })]
    setTransferTrpc(transferMutate)
    render(<MachinesPanel />)
    fireEvent.click(screen.getByRole('button', { name: 'Transfer' }))
    fireEvent.change(screen.getByLabelText(/new owner's account name/i), {
      target: { value: 'ghost' },
    })
    fireEvent.change(screen.getByLabelText(/type the machine name to confirm/i), {
      target: { value: 'builder' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Transfer ownership' }))

    expect(await screen.findByRole('alert')).toHaveProperty('textContent', 'unknown recipient')
    // The dialog stays open on refusal: the owner has typed two fields, and
    // closing it would discard them along with the reason it failed.
    expect(screen.getByRole('dialog')).toBeTruthy()
  })
})

describe('MachinesPanel server transfer', () => {
  function setServerTransferTrpc(transferMutate: () => Promise<unknown>) {
    storeState.trpc = {
      machines: {
        pairingCode: { mutate: vi.fn().mockResolvedValue({ code: 'CODE', joinCommand: 'join' }) },
        transferServer: { mutate: transferMutate },
      },
      setup: {
        info: { query: vi.fn().mockResolvedValue({ publicUrl: 'https://podium.example.com' }) },
      },
    } as unknown as Store['trpc']
  }

  it('offers Make server only for an owned online target', () => {
    storeState.machines = [
      machine({ id: asMachineId('target'), name: 'vps', online: true, owned: true }),
      machine({ id: asMachineId('other'), name: 'shared', online: true, owned: false }),
    ]
    setServerTransferTrpc(vi.fn())
    render(<MachinesPanel />)

    expect(screen.getAllByRole('button', { name: 'Make server' })).toHaveLength(1)
  })

  it('requires the target name and passes the stable URL to the transfer command', async () => {
    const transferMutate = vi.fn().mockResolvedValue({ state: 'committed' })
    storeState.machines = [
      machine({ id: asMachineId('target'), name: 'vps', online: true, owned: true }),
    ]
    setServerTransferTrpc(transferMutate)
    render(<MachinesPanel />)

    fireEvent.click(screen.getByRole('button', { name: 'Make server' }))
    const confirm = await screen.findByRole('button', { name: 'Transfer server' })
    expect(confirm).toHaveProperty('disabled', true)

    fireEvent.change(await screen.findByLabelText('Type the target machine name to confirm'), {
      target: { value: 'vps' },
    })
    expect(confirm).toHaveProperty('disabled', false)
    fireEvent.click(confirm)

    await waitFor(() =>
      expect(transferMutate).toHaveBeenCalledWith({
        targetMachineId: 'target',
        publicUrl: 'https://podium.example.com',
        confirmation: true,
      }),
    )
    expect((await screen.findByRole('status')).textContent).toMatch(/transfer committed/i)
  })

  it('recommends making the first added machine the server', async () => {
    storeState.machines = [
      machine({ id: asMachineId('current'), name: 'mac', online: true, owned: true }),
    ]
    setServerTransferTrpc(vi.fn())
    render(<MachinesPanel />)

    fireEvent.click(screen.getByRole('button', { name: 'Add machine' }))
    expect(await screen.findByText(/recommended: make this the server/i)).toBeTruthy()
  })
})
