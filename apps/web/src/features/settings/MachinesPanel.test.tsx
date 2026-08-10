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

import {
  MachinesPanel,
  SERVER_TRANSFER_CONFIRMATION,
  ServerTransferProgress,
  type ServerTransferStatusSnapshot,
} from './MachinesPanel'

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
  function status(
    overrides: Partial<ServerTransferStatusSnapshot> = {},
  ): ServerTransferStatusSnapshot {
    return {
      sourceMachineId: 'source',
      targetEligibility: [{ targetMachineId: 'target', eligible: true }],
      transfer: null,
      ...overrides,
    }
  }

  const phaseByState: Record<
    NonNullable<ServerTransferStatusSnapshot['transfer']>['state'],
    NonNullable<ServerTransferStatusSnapshot['transfer']>['phase']
  > = {
    preparing: 'preparing',
    staged: 'copying',
    validated: 'validating',
    'source-fenced': 'switching',
    committing: 'switching',
    committed: 'switching',
    aborted: 'aborted',
    'commit-uncertain': 'commit-uncertain',
  }
  function transferStatus(
    state: NonNullable<ServerTransferStatusSnapshot['transfer']>['state'],
    overrides: Partial<NonNullable<ServerTransferStatusSnapshot['transfer']>> = {},
  ): NonNullable<ServerTransferStatusSnapshot['transfer']> {
    return {
      targetMachineId: 'target',
      state,
      phase: phaseByState[state],
      sourceFenced: false,
      targetProof: false,
      transferId: 'transfer-1',
      publicUrl: 'https://new-podium.example.com',
      sourceConnected: false,
      ...overrides,
    }
  }

  function setServerTransferTrpc(
    transferMutate: () => Promise<unknown>,
    statusQuery = vi.fn().mockResolvedValue(status()),
  ) {
    storeState.trpc = {
      machines: {
        pairingCode: { mutate: vi.fn().mockResolvedValue({ code: 'CODE', joinCommand: 'join' }) },
        transferServer: { mutate: transferMutate },
        serverTransferStatus: { query: statusQuery },
      },
      setup: {
        info: { query: vi.fn().mockResolvedValue({ publicUrl: 'https://source.example.com' }) },
      },
    } as unknown as Store['trpc']
    return statusQuery
  }

  it('renders Make server only from server-computed eligibility', async () => {
    storeState.machines = [
      machine({ id: asMachineId('target'), name: 'vps', online: false, owned: false }),
      machine({ id: asMachineId('other'), name: 'owned laptop', online: true, owned: true }),
    ]
    setServerTransferTrpc(
      vi.fn(),
      vi.fn().mockResolvedValue(
        status({
          targetEligibility: [
            { targetMachineId: 'target', eligible: true },
            { targetMachineId: 'other', eligible: false, reason: 'current-server' },
          ],
        }),
      ),
    )
    render(<MachinesPanel />)

    expect(await screen.findAllByRole('button', { name: 'Make server' })).toHaveLength(1)
  })

  it('requires a new public URL and the exact confirmation phrase', async () => {
    const transferMutate = vi.fn().mockResolvedValue({ state: 'committed' })
    const statusQuery = vi
      .fn()
      .mockResolvedValueOnce(status())
      .mockResolvedValue(status({ transfer: transferStatus('preparing') }))
    storeState.machines = [
      machine({ id: asMachineId('source'), name: 'laptop', online: true }),
      machine({ id: asMachineId('target'), name: 'vps', online: true }),
    ]
    setServerTransferTrpc(transferMutate, statusQuery)
    render(<MachinesPanel />)

    fireEvent.click(await screen.findByRole('button', { name: 'Make server' }))
    const confirm = await screen.findByRole('button', { name: 'Transfer server' })
    expect(confirm).toHaveProperty('disabled', true)
    expect((screen.getByLabelText('New public URL') as HTMLInputElement).value).toBe('')

    fireEvent.change(screen.getByLabelText('New public URL'), {
      target: { value: 'https://new-podium.example.com' },
    })
    expect(confirm).toHaveProperty('disabled', true)

    fireEvent.change(screen.getByLabelText('Server transfer confirmation'), {
      target: { value: SERVER_TRANSFER_CONFIRMATION },
    })
    expect(confirm).toHaveProperty('disabled', false)
    fireEvent.click(confirm)

    await waitFor(() =>
      expect(transferMutate).toHaveBeenCalledWith({
        targetMachineId: 'target',
        publicUrl: 'https://new-podium.example.com',
        confirmation: SERVER_TRANSFER_CONFIRMATION,
      }),
    )
    expect((await screen.findByRole('status')).textContent).toMatch(/preparing/i)
    expect(screen.getByText('Connected').getAttribute('data-transfer-state')).toBe('pending')
  })

  it('does not show Connected until target proof and source reconnection are both true', async () => {
    storeState.machines = [machine({ id: asMachineId('target'), name: 'vps', online: true })]
    setServerTransferTrpc(
      vi.fn(),
      vi.fn().mockResolvedValue(
        status({
          transfer: transferStatus('committed', {
            sourceFenced: true,
            targetProof: true,
            sourceConnected: false,
          }),
        }),
      ),
    )
    render(<MachinesPanel />)

    expect((await screen.findByRole('status')).textContent).toMatch(/switching/i)
    expect(screen.getByText('Connected').getAttribute('data-transfer-state')).toBe('pending')

    cleanup()
    setServerTransferTrpc(
      vi.fn(),
      vi.fn().mockResolvedValue(
        status({
          transfer: transferStatus('committed', {
            phase: 'connected',
            sourceFenced: true,
            targetProof: true,
            sourceConnected: true,
          }),
        }),
      ),
    )
    render(<MachinesPanel />)

    expect((await screen.findByRole('status')).textContent).toMatch(/proved it is serving/i)
    expect(screen.getByText('Connected').getAttribute('data-transfer-state')).toBe('complete')
  })

  it('keeps commit-uncertain in recovery and offers Check target', async () => {
    storeState.machines = [machine({ id: asMachineId('target'), name: 'vps', online: true })]
    let rejectCheck: ((reason?: unknown) => void) | undefined
    const transferMutate = vi.fn(
      () =>
        new Promise<void>((_resolve, reject) => {
          rejectCheck = reject
        }),
    )
    const statusQuery = setServerTransferTrpc(
      transferMutate,
      vi.fn().mockResolvedValue(
        status({
          transfer: transferStatus('commit-uncertain', {
            sourceFenced: true,
            error: { code: 'commit-uncertain', message: 'promotion reply was lost' },
          }),
        }),
      ),
    )
    render(<MachinesPanel />)

    expect((await screen.findByRole('alert')).textContent).toMatch(/promotion reply was lost/i)
    fireEvent.click(screen.getByRole('button', { name: 'View transfer' }))
    const statusCallsBeforeCheck = statusQuery.mock.calls.length
    fireEvent.click(await screen.findByRole('button', { name: 'Check target' }))

    expect(screen.getByRole('button', { name: 'Checking…' })).toHaveProperty('disabled', true)
    expect(transferMutate).toHaveBeenCalledWith({
      targetMachineId: 'target',
      publicUrl: 'https://new-podium.example.com',
      confirmation: SERVER_TRANSFER_CONFIRMATION,
    })

    rejectCheck?.(new Error('target inspection unavailable'))

    await waitFor(() => expect(statusQuery.mock.calls.length).toBeGreaterThan(statusCallsBeforeCheck))
    expect(await screen.findByRole('button', { name: 'Check target' })).toHaveProperty(
      'disabled',
      false,
    )
    expect(screen.getAllByRole('alert')[0]?.textContent).toMatch(/promotion reply was lost/i)
    expect(screen.getByText(/target inspection unavailable/i)).toBeTruthy()
    expect(screen.queryByText(/transfer stopped safely/i)).toBeNull()
  })

  it('recommends only the first additional machine and waits for server eligibility after pairing', async () => {
    const current = machine({ id: asMachineId('source'), name: 'laptop', online: true })
    const target = machine({ id: asMachineId('target'), name: 'vps', online: true })
    storeState.machines = [current]
    setServerTransferTrpc(vi.fn())
    const view = render(<MachinesPanel />)

    fireEvent.click(screen.getByRole('button', { name: 'Add machine' }))
    expect(await screen.findByText(/recommended: make this the server/i)).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Review transfer' })).toBeNull()

    storeState.machines = [current, target]
    view.rerender(<MachinesPanel />)
    fireEvent.click(await screen.findByRole('button', { name: 'Review transfer' }))

    expect((await screen.findByRole('dialog')).textContent).toMatch(/laptop to vps/i)
  })

  it('does not recommend a server when adding before the first or after the second machine', async () => {
    setServerTransferTrpc(vi.fn())
    render(<MachinesPanel />)
    fireEvent.click(screen.getByRole('button', { name: 'Add machine' }))
    expect(screen.queryByText(/recommended: make this the server/i)).toBeNull()

    cleanup()
    storeState.machines = [
      machine({ id: asMachineId('source') }),
      machine({ id: asMachineId('other') }),
    ]
    setServerTransferTrpc(vi.fn())
    render(<MachinesPanel />)
    fireEvent.click(screen.getByRole('button', { name: 'Add machine' }))
    expect(screen.queryByText(/recommended: make this the server/i)).toBeNull()
  })

  it('cancelling the add-machine recommendation never starts a transfer', async () => {
    const transferMutate = vi.fn()
    storeState.machines = [machine({ id: asMachineId('source'), online: true })]
    setServerTransferTrpc(transferMutate)
    render(<MachinesPanel />)

    fireEvent.click(screen.getByRole('button', { name: 'Add machine' }))
    await screen.findByText(/recommended: make this the server/i)
    const [close] = screen.getAllByRole('button', { name: 'Close' })
    if (!close) throw new Error('close control missing')
    fireEvent.click(close)

    expect(transferMutate).not.toHaveBeenCalled()
  })
})

describe('ServerTransferProgress', () => {
  it.each([
    ['preparing', 'Preparing'],
    ['copying', 'Copying'],
    ['validating', 'Validating'],
    ['switching', 'Switching'],
    ['connected', 'Connected'],
  ] as const)('renders %s as its own phase', (state, label) => {
    render(<ServerTransferProgress state={state} targetName="vps" />)

    expect(screen.getByText(label).getAttribute('data-transfer-state')).toBe(
      state === 'connected' ? 'complete' : 'active',
    )
    expect(screen.getByRole('status').textContent).toContain(label)
  })

  it('keeps commit-uncertain distinct and warns against retrying', () => {
    render(<ServerTransferProgress state="commit-uncertain" targetName="vps" />)

    const alert = screen.getByRole('alert')
    expect(alert.textContent).toMatch(/could not be confirmed/i)
    expect(alert.textContent).toMatch(/do not retry/i)
    expect(alert.textContent).toMatch(/check the target/i)
  })

  it('describes an abort as safe for the current server', () => {
    render(<ServerTransferProgress state="aborted" targetName="vps" />)

    const alert = screen.getByRole('alert')
    expect(alert.textContent).toMatch(/stopped safely/i)
    expect(alert.textContent).toMatch(/current server is still active/i)
  })
})
