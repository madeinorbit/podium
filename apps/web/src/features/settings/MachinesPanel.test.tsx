import '@/test-support/mock-pool-store-handle'
import { relativeTime } from '@podium/client-core/focus'
import type { MachineWire } from '@podium/model'
import { asMachineId } from '@podium/model'
import { act, cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react'
import type { ReactElement } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { NativeDesktopBridge } from '@/lib/nativeDesktop'
import { renderSettingsPool } from '@/test-support/mock-settings-pool-fixture'

const state = {
  machines: [] as MachineWire[],
  trpc: {} as import('@/app/trpc').Trpc,
  setSettingsTab: vi.fn(),
}
vi.mock('@/app/store', () => ({ readFixture: (read: (s: typeof state) => unknown) => read(state) }))
vi.mock('@/app/trpc', async (original) => ({
  ...(await original<typeof import('@/app/trpc')>()),
  makeTrpc: () =>
    new Proxy({}, { get: (_target, key) => (state.trpc as Record<PropertyKey, unknown>)[key] }),
}))
vi.mock('@/lib/workspace-request', async (original) => ({
  ...(await original<typeof import('@/lib/workspace-request')>()),
  workspaceFetch: async () => ({ ok: false }),
}))
vi.mock('@/lib/member-roster', () => ({
  useMemberRoster: () => ({
    currentMemberId: 'alice',
    members: [],
    nameOf: (id: string) => (id === 'bob' ? 'Bob' : 'Alice'),
  }),
}))
vi.mock('@/features/setup/RepoScanFlow', () => ({ RepoScanFlow: () => <div>Repository scan</div> }))

import { resetUpdateStatus } from '@/lib/update-status'
import { AdminViewerContext } from './admin-viewer'
import { MachinesPanel } from './MachinesPanel'
import { SettingsOpening } from './SettingsOpening'
import { SettingsFrame } from './settings-frame'

const admin = {
  status: 'ready' as const,
  sections: ['machines', 'access', 'people', 'instance', 'audit'],
  retry: vi.fn(),
}
function frame(ui: ReactElement, isAdmin = true) {
  const viewer = isAdmin ? admin : { ...admin, sections: [] }
  return (
    <SettingsOpening>
      <AdminViewerContext.Provider value={viewer}>
        <SettingsFrame
          page="machines"
          viewer={viewer}
          onPageChange={state.setSettingsTab}
          onClose={vi.fn()}
        >
          {ui}
        </SettingsFrame>
      </AdminViewerContext.Provider>
    </SettingsOpening>
  )
}
function render(isAdmin = true) {
  const view = renderSettingsPool(frame(<MachinesPanel />, isAdmin))
  return { ...view, refresh: () => view.rerender(frame(<MachinesPanel />, isAdmin)) }
}
function machine(over: Partial<MachineWire> & { custodian?: string | null } = {}): MachineWire {
  return {
    id: asMachineId('m-1'),
    name: 'Build box',
    hostname: 'build.example',
    online: true,
    owned: true,
    transferable: true,
    supersedable: true,
    use: 'granted',
    custodian: 'alice',
    grants: [],
    appVersion: '0.5.0',
    versionState: 'current',
    ...over,
  } as MachineWire
}
function client(over: Record<string, unknown> = {}) {
  state.trpc = {
    machines: {
      pairingCode: {
        mutate: vi
          .fn()
          .mockResolvedValue({ code: 'ABCD-EFGH', joinCommand: 'podium join ABCD-EFGH' }),
      },
      ...over,
    },
    setup: {
      info: { query: vi.fn().mockResolvedValue({ publicUrl: 'https://podium.example.com' }) },
    },
    updates: {
      fleet: { query: vi.fn().mockResolvedValue({ machines: [], allMachines: [], behind: 0 }) },
    },
    operations: { active: { query: vi.fn().mockResolvedValue(null) } },
  } as unknown as import('@/app/trpc').Trpc
}
function open(name = 'Build box') {
  fireEvent.click(screen.getByRole('button', { name }))
}
function machineRow(name = 'Build box') {
  const button = screen.getByRole('button', { name })
  const row = button.closest<HTMLElement>('.settings-list-row')
  if (!row) throw new Error('Machine row is missing')
  return row
}
function detail(name = 'Build box') {
  return within(screen.getByRole('region', { name }))
}
function stubBridge(over: Partial<NativeDesktopBridge> = {}) {
  const bridge = {
    platform: 'macos',
    launchMode: 'client',
    minimize: vi.fn(),
    toggleMaximize: vi.fn(),
    close: vi.fn(),
    enableHosting: vi.fn().mockResolvedValue(undefined),
    ...over,
  } as NativeDesktopBridge
  ;(globalThis as { __PODIUM_DESKTOP__?: NativeDesktopBridge }).__PODIUM_DESKTOP__ = bridge
  return bridge
}
afterEach(() => {
  cleanup()
  resetUpdateStatus()
  vi.restoreAllMocks()
  vi.useRealTimers()
  vi.clearAllMocks()
  state.machines = []
  ;(globalThis as { __PODIUM_DESKTOP__?: NativeDesktopBridge }).__PODIUM_DESKTOP__ = undefined
  ;(window as unknown as { __PODIUM_RESTART__?: () => void }).__PODIUM_RESTART__ = undefined
})

describe('machine list and detail routing', () => {
  it('opens detail without a second dialog and returns to the list', () => {
    client()
    state.machines = [machine()]
    render()
    expect(machineRow('Build box').textContent).toContain('Looked after by you')
    expect(screen.getByText(/0 sessions.*memory/)).toBeTruthy()
    expect(screen.queryByRole('textbox', { name: 'Name' })).toBeNull()
    open()
    expect(screen.getByRole('textbox', { name: 'Name' })).toHaveProperty('value', 'Build box')
    expect(screen.getByRole('heading', { name: 'Who else can run agents here' })).toBeTruthy()
    expect(screen.getAllByRole('dialog')).toHaveLength(1)
    fireEvent.click(detail().getByRole('button', { name: 'Machines' }))
    expect(screen.getByRole('button', { name: 'Build box' })).toBeTruthy()
  })
  it('members see only machines they look after or can use, with other machines read-only', () => {
    client()
    state.machines = [
      machine({ id: asMachineId('own'), name: 'Mine' }),
      machine({
        id: asMachineId('shared'),
        name: 'Shared',
        owned: false,
        transferable: false,
        custodian: 'bob',
      }),
      machine({
        id: asMachineId('see'),
        name: 'Visibility only',
        owned: false,
        transferable: false,
        use: 'denied',
      }),
    ]
    render(false)
    expect(screen.getByText('The computers you look after or may run agents on.')).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Visibility only' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Add machine' })).toBeNull()
    open('Shared')
    expect(screen.queryByRole('textbox', { name: 'Name' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Remove' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Find repositories' })).toBeNull()
    expect(screen.queryByRole('button', { name: /apply update/i })).toBeNull()
  })
  it('links a machine behind its target to Updates', () => {
    client()
    state.machines = [machine({ versionState: 'behind' })]
    render()
    open()
    fireEvent.click(detail().getByRole('button', { name: 'Updates' }))
    expect(state.setSettingsTab).toHaveBeenCalledWith('updates')
  })
})

describe('add machine choices', () => {
  it('mints only after the login choice, which stays fixed while the command is shown', async () => {
    client()
    render()
    fireEvent.click(screen.getByRole('button', { name: 'Add machine' }))
    const mint = state.trpc.machines.pairingCode.mutate
    expect(mint).not.toHaveBeenCalled()
    fireEvent.click(
      screen.getByRole('switch', { name: 'Copy agent logins from your other machines' }),
    )
    expect(mint).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Create command' }))
    await waitFor(() =>
      expect(mint).toHaveBeenCalledWith({ copyAgentCredentials: true, podiumManaged: false }),
    )
    expect(await screen.findByText('podium join ABCD-EFGH')).toBeTruthy()
    expect(screen.getByRole('switch')).toHaveProperty('disabled', true)
    fireEvent.click(screen.getByRole('button', { name: 'Change choice' }))
    expect(screen.queryByText('podium join ABCD-EFGH')).toBeNull()
    expect(mint).toHaveBeenCalledTimes(1)
  })
  it('links a missing public address to Access', async () => {
    client()
    state.trpc.setup.info.query = vi.fn().mockResolvedValue({ publicUrl: null })
    state.trpc.machines.pairingCode.mutate = vi
      .fn()
      .mockResolvedValue({ code: 'ABCD-EFGH', joinCommand: null })
    render()
    fireEvent.click(screen.getByRole('button', { name: 'Add machine' }))
    fireEvent.click(screen.getByRole('button', { name: 'Create command' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Access' }))
    expect(state.setSettingsTab).toHaveBeenCalledWith('access')
  })
})

describe('machine actions', () => {
  it('adopts an unowned machine only with projected authority', async () => {
    const mutate = vi.fn().mockResolvedValue([])
    client({ adopt: { mutate } })
    state.machines = [
      machine({ unowned: true, custodian: null, owned: false, use: 'denied', adoptable: true }),
    ]
    render()
    expect(screen.getByText('Nobody looks after it')).toBeTruthy()
    open()
    fireEvent.click(screen.getByRole('button', { name: 'Adopt it' }))
    await waitFor(() => expect(mutate).toHaveBeenCalledWith({ id: 'm-1' }))
  })
  it('keeps a refused removal inline for retry and returns to the list on success', async () => {
    const mutate = vi
      .fn()
      .mockRejectedValueOnce(new Error('Machine is still the server'))
      .mockResolvedValue([])
    client({ revoke: { mutate } })
    state.machines = [machine()]
    render()
    open()
    fireEvent.click(screen.getByRole('button', { name: 'Remove' }))
    fireEvent.click(screen.getByRole('button', { name: 'Remove machine' }))
    expect(await screen.findByRole('alert')).toHaveProperty(
      'textContent',
      'Machine is still the server',
    )
    expect(state.machines[0]?.revokedAt).toBeUndefined()
    expect(screen.getByRole('button', { name: 'Remove machine' })).toHaveProperty('disabled', false)
    fireEvent.click(screen.getByRole('button', { name: 'Remove machine' }))
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Remove machine' })).toBeNull())
    expect(mutate).toHaveBeenCalledTimes(2)
    expect(mutate).toHaveBeenLastCalledWith({ id: 'm-1' })
    expect(screen.getByRole('button', { name: 'Build box' })).toBeTruthy()
  })
  it('requires an eligible replacement and preserves refusal for retry', async () => {
    const mutate = vi
      .fn()
      .mockRejectedValueOnce(new Error('Replacement retired'))
      .mockResolvedValue([])
    client({ supersede: { mutate } })
    state.machines = [
      machine(),
      machine({ id: asMachineId('new'), name: 'New box' }),
      machine({ id: asMachineId('retired'), name: 'Retired', revokedAt: 'now' }),
    ]
    render()
    open()
    fireEvent.click(screen.getByRole('button', { name: 'Replace…' }))
    expect(screen.queryByRole('button', { name: 'Replace machine' })).toBeNull()
    fireEvent.click(screen.getByLabelText('Replacement machine'))
    const options = await screen.findAllByRole('option')
    expect(options.map((option) => option.textContent).join(' ')).not.toContain('Retired')
    fireEvent.click(screen.getByRole('option', { name: /New box/ }))
    fireEvent.click(screen.getByRole('button', { name: 'Replace machine' }))
    expect(await screen.findByRole('alert')).toHaveProperty('textContent', 'Replacement retired')
    expect(mutate).toHaveBeenCalledWith({ id: 'm-1', replacementId: 'new' })
    expect(screen.getByText(/cancels its access grants and queued work/)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Replace machine' }))
    await waitFor(() =>
      expect(screen.queryByRole('button', { name: 'Replace machine' })).toBeNull(),
    )
    expect(mutate).toHaveBeenCalledTimes(2)
  })
  it('enables the paired offline device from its detail and stays busy while restarting', async () => {
    client()
    const bridge = stubBridge({ machineId: asMachineId('m-1') })
    const restart = vi.fn(() => new Promise<void>(() => {}))
    ;(window as unknown as { __PODIUM_RESTART__?: () => void }).__PODIUM_RESTART__ = restart
    state.machines = [machine({ online: false })]
    render()
    open()
    fireEvent.click(screen.getByRole('button', { name: 'Enable' }))
    await waitFor(() => expect(restart).toHaveBeenCalled())
    expect(state.trpc.machines.pairingCode.mutate).toHaveBeenCalledTimes(1)
    expect(bridge.enableHosting).toHaveBeenCalledWith('ABCD-EFGH')
    expect(screen.getByRole('button', { name: 'Enabling…' })).toHaveProperty('disabled', true)
  })
})

describe('machine presence and service states', () => {
  it('keeps offline last-seen answers at thirty-second precision and releases its clock', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(100_000)
    const lastSeenAt = new Date(30_000).toISOString()
    client()
    state.machines = [machine({ online: false, lastSeenAt })]
    const view = render()
    await act(async () => {})
    const label = (at: number) => `Offline · Last seen ${relativeTime(lastSeenAt, at)}`
    expect(screen.getByText(label(100_000))).toBeTruthy()
    act(() => vi.advanceTimersByTime(29_999))
    expect(screen.getByText(label(100_000))).toBeTruthy()
    act(() => vi.advanceTimersByTime(1))
    expect(screen.getByText(label(130_000))).toBeTruthy()
    view.unmount()
    resetUpdateStatus()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('distinguishes healthy, deliberately disabled, degraded and offline machines', () => {
    const observedAt = '2026-08-26T12:00:00.000Z'
    const stopped = { policy: 'disabled' as const, state: 'stopped' as const, observedAt }
    client()
    state.machines = [
      machine({
        id: asMachineId('healthy'),
        name: 'Healthy',
        serviceAssignment: { server: false, agentExecution: true },
        services: {
          server: stopped,
          agentExecution: { policy: 'enabled', state: 'available', observedAt },
        },
      }),
      machine({
        id: asMachineId('disabled'),
        name: 'Agents off',
        serviceAssignment: { server: false, agentExecution: false },
        services: { server: stopped, agentExecution: stopped },
      }),
      machine({
        id: asMachineId('agent-degraded'),
        name: 'Agent degraded',
        serviceAssignment: { server: false, agentExecution: true },
        services: {
          server: stopped,
          agentExecution: {
            policy: 'enabled',
            state: 'refused',
            reason: 'daemon configuration refused',
            observedAt,
          },
        },
      }),
      machine({
        id: asMachineId('server-degraded'),
        name: 'Server degraded',
        serviceAssignment: { server: true, agentExecution: false },
        services: {
          server: { policy: 'enabled', state: 'stopped', reason: 'server exited', observedAt },
          agentExecution: stopped,
        },
      }),
      machine({
        id: asMachineId('offline'),
        name: 'Offline box',
        online: false,
        lastSeenAt: observedAt,
      }),
    ]
    render()
    expect(within(machineRow('Healthy')).getByText('Online')).toBeTruthy()
    expect(within(machineRow('Agents off')).getByText('Online · Agent hosting off')).toBeTruthy()
    expect(within(machineRow('Agent degraded')).getByText('Online · Degraded: agents')).toBeTruthy()
    expect(
      within(machineRow('Server degraded')).getByText('Online · Degraded: server'),
    ).toBeTruthy()
    expect(within(machineRow('Offline box')).getByText(/Offline · Last seen/)).toBeTruthy()
    open('Agents off')
    expect(detail('Agents off').getByText('Disabled on this machine')).toBeTruthy()
    fireEvent.click(detail('Agents off').getByRole('button', { name: 'Machines' }))
    open('Agent degraded')
    expect(detail('Agent degraded').getByText('daemon configuration refused')).toBeTruthy()
    fireEvent.click(detail('Agent degraded').getByRole('button', { name: 'Machines' }))
    open('Server degraded')
    expect(detail('Server degraded').getByText('server exited')).toBeTruthy()
  })

  it.each([
    'inventory pending',
    '2 quarantined',
    'retrying handshake',
  ])('keeps recovery reason %s distinct from online', (reason) => {
    client()
    state.machines = [
      machine({ daemonReadiness: { state: 'recovering', reason, quarantinedBindings: 2 } }),
    ]
    render()
    expect(screen.getByText(`Not ready · ${reason}`)).toBeTruthy()
    expect(screen.queryByText('Online')).toBeNull()
    open()
    expect(detail().getByText('2 quarantined')).toBeTruthy()
    expect(detail().queryByText(/Restart Podium on this machine/)).toBeNull()
  })
})

describe('host-this-device and paired-device hosting', () => {
  it('shows neither the hosting card nor this-computer pill outside the desktop shell', () => {
    client()
    state.machines = [machine()]
    render()
    expect(screen.queryByRole('button', { name: 'Host sessions on this device' })).toBeNull()
    expect(screen.queryByText('this computer')).toBeNull()
  })
  it('shows the unchanged hosting card for an unpaired desktop device', () => {
    client()
    stubBridge({ machineId: undefined })
    state.machines = [machine({ id: asMachineId('another-machine') })]
    render()
    expect(screen.getByRole('button', { name: 'Host sessions on this device' })).toBeTruthy()
    expect(screen.queryByText('this computer')).toBeNull()
  })
  it('marks a paired offline device and offers Enable in detail instead of the card', () => {
    client()
    stubBridge({ machineId: asMachineId('m-1') })
    state.machines = [
      machine({ online: false }),
      machine({ id: asMachineId('another-machine'), name: 'Another box' }),
    ]
    render()
    expect(screen.queryByRole('button', { name: 'Host sessions on this device' })).toBeNull()
    expect(screen.getByText('this computer')).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Enable' })).toBeNull()
    open()
    expect(detail().getByRole('button', { name: 'Enable' })).toBeTruthy()
  })
  it('marks a paired online device without offering Enable', () => {
    client()
    stubBridge({ machineId: asMachineId('m-1') })
    state.machines = [machine({ online: true })]
    render()
    expect(screen.getByText('this computer')).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Host sessions on this device' })).toBeNull()
    open()
    expect(detail().queryByRole('button', { name: 'Enable' })).toBeNull()
  })
  it('shows manual relaunch guidance when the native restart is refused', async () => {
    client()
    stubBridge({ machineId: asMachineId('m-1') })
    ;(window as unknown as { __PODIUM_RESTART__?: () => unknown }).__PODIUM_RESTART__ = vi
      .fn()
      .mockRejectedValue(new Error('process.restart not allowed'))
    state.machines = [machine({ online: false })]
    render()
    open()
    fireEvent.click(detail().getByRole('button', { name: 'Enable' }))
    expect(await detail().findByText(/quit and reopen the app/i)).toBeTruthy()
    expect(detail().getByRole('button', { name: 'Enable' })).toHaveProperty('disabled', false)
  })
  it('shows a pairing failure and re-enables the standalone hosting action', async () => {
    const mutate = vi.fn().mockRejectedValue(new Error('pairing is disabled on this server'))
    client({ pairingCode: { mutate } })
    stubBridge({ machineId: undefined })
    render()
    fireEvent.click(screen.getByRole('button', { name: 'Host sessions on this device' }))
    expect(await screen.findByText('pairing is disabled on this server')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Host sessions on this device' })).toHaveProperty(
      'disabled',
      false,
    )
  })
})

function versionControl(name = 'Build box') {
  return within(detail(name).getByRole('group', { name: 'Podium version' }))
}
function versionClient(appVersion: string, allMachines: unknown[] = []) {
  client()
  state.trpc.setup.info.query = vi.fn().mockResolvedValue({ publicUrl: null, appVersion })
  state.trpc.updates.fleet.query = vi
    .fn()
    .mockResolvedValue({ machines: [], allMachines, behind: 0 })
}
const inventory = (podiumVersion: string) => ({
  os: 'linux' as const,
  arch: 'x64' as const,
  podiumVersion,
  agents: [],
  tools: [],
})

describe('machine version offers in detail', () => {
  it('keeps waiting offers quiet while showing a current online machine refusal', async () => {
    const behind = {
      appVersion: '0.4.1',
      inventory: inventory('0.4.1'),
      targetVersion: '0.5.0',
      versionState: 'behind' as const,
    }
    state.machines = [machine(behind)]
    versionClient('0.5.0')
    const waiting = render()
    open()
    const pending = await versionControl().findByRole('button', { name: 'Updates' })
    expect(pending.className).not.toContain('warning')
    expect(detail().getByText(/waiting to be accepted/)).toBeTruthy()
    waiting.unmount()
    resetUpdateStatus()
    state.machines = [
      machine({ ...behind, online: true, appVersion: '0.5.0', versionState: 'current' }),
    ]
    versionClient('0.5.0', [
      {
        id: 'm-1',
        version: '0.4.1',
        state: 'current',
        reason: {
          code: 'daemon-refused',
          message: 'Daemon refused to start: address already in use.',
          source: 'machine',
          at: 1000,
        },
        online: true,
        busy: false,
      },
    ])
    render()
    open()
    const reason = await detail().findByText('Daemon refused to start: address already in use.')
    expect(reason.className).toContain('text-warning')
    expect(detail().getByText('reported by the machine')).toBeTruthy()
    expect(versionControl().getByText('0.5.0')).toBeTruthy()
    expect(detail().queryByText(/waiting to be accepted/)).toBeNull()
  })
  it('shows the daemon version and offers Updates when a legacy machine is behind the server', async () => {
    state.machines = [
      machine({ appVersion: '0.4.1', versionState: undefined, inventory: inventory('0.4.1') }),
    ]
    versionClient('0.5.0')
    render()
    open()
    expect(versionControl().getByText('0.4.1')).toBeTruthy()
    expect(await versionControl().findByRole('button', { name: 'Updates' })).toBeTruthy()
  })
  it('does not offer Updates for a legacy machine on the server version', async () => {
    state.machines = [
      machine({ appVersion: '0.5.0', versionState: undefined, inventory: inventory('0.5.0') }),
    ]
    versionClient('0.5.0')
    render()
    open()
    await act(async () => {})
    expect(versionControl().getByText('0.5.0')).toBeTruthy()
    expect(versionControl().queryByRole('button', { name: 'Updates' })).toBeNull()
  })
  it('does not offer Updates for a current selected channel when the server build differs', async () => {
    state.machines = [
      machine({
        appVersion: '0.1.3-edge.1',
        inventory: inventory('0.1.3-edge.1'),
        updateChannel: 'edge',
        targetVersion: '0.1.3-edge.1',
        versionState: 'current',
      }),
    ]
    versionClient('dev+7de565e')
    render()
    open()
    await act(async () => {})
    expect(versionControl().getByText('0.1.3-edge.1')).toBeTruthy()
    expect(versionControl().queryByRole('button', { name: 'Updates' })).toBeNull()
  })
  it('offers Updates for a machine behind its selected channel when the server build differs', async () => {
    state.machines = [
      machine({
        appVersion: '0.4.1',
        inventory: inventory('0.4.1'),
        updateChannel: 'stable',
        targetVersion: '0.5.0',
        versionState: 'behind',
      }),
    ]
    versionClient('dev+7de565e')
    render()
    open()
    expect(await versionControl().findByRole('button', { name: 'Updates' })).toBeTruthy()
  })
  it('does not invent legacy update offers for dev or unreported versions', async () => {
    state.machines = [
      machine({
        id: asMachineId('dev'),
        name: 'Dev box',
        appVersion: 'dev',
        versionState: undefined,
        inventory: inventory('dev'),
      }),
      machine({
        id: asMachineId('old'),
        name: 'Unreported box',
        appVersion: undefined,
        versionState: undefined,
      }),
    ]
    versionClient('0.5.0')
    render()
    open('Dev box')
    await act(async () => {})
    expect(versionControl('Dev box').getByText('dev')).toBeTruthy()
    expect(versionControl('Dev box').queryByRole('button', { name: 'Updates' })).toBeNull()
    fireEvent.click(detail('Dev box').getByRole('button', { name: 'Machines' }))
    open('Unreported box')
    await act(async () => {})
    expect(versionControl('Unreported box').getByText('Not reported')).toBeTruthy()
    expect(versionControl('Unreported box').queryByRole('button', { name: 'Updates' })).toBeNull()
  })
})

it('shows recorded agent versions and the unverified marker in machine detail', () => {
  client()
  state.machines = [
    machine({
      harnessVersions: [
        {
          harness: 'codex',
          version: '0.154.0',
          firstSeen: '2026-09-16T10:00:00.000Z',
          lastSeen: '2026-09-16T11:00:00.000Z',
          verifiedThrough: '0.151.0',
          unverified: true,
        },
      ],
    }),
  ]
  render()
  open()
  const agents = detail().getByRole('list', { name: 'Agents installed' })
  expect(agents.textContent).toContain('Codex')
  expect(agents.textContent).toContain('0.154.0')
  expect(within(agents).getByText('unverified').getAttribute('title')).toBe(
    'Verified through 0.151.0',
  )
  expect(detail().queryByRole('alert')).toBeNull()
})

describe('retained adoption, removal and replacement behavior', () => {
  it('withholds Adopt it without affirmative adoption authority', () => {
    client()
    state.machines = [
      machine({ unowned: true, custodian: null, owned: false, adoptable: undefined }),
    ]
    render()
    open()
    expect(detail().getByText('Nobody looks after this machine')).toBeTruthy()
    expect(detail().queryByRole('button', { name: 'Adopt it' })).toBeNull()
  })
  it('shows adoption errors, re-enables Adopt it and permits retry', async () => {
    const mutate = vi
      .fn()
      .mockRejectedValueOnce(new Error('machine already has an owner'))
      .mockResolvedValue([])
    client({ adopt: { mutate } })
    state.machines = [machine({ unowned: true, custodian: null, owned: false, adoptable: true })]
    render()
    open()
    fireEvent.click(detail().getByRole('button', { name: 'Adopt it' }))
    expect(await detail().findByRole('alert')).toHaveProperty(
      'textContent',
      'machine already has an owner',
    )
    expect(detail().getByRole('button', { name: 'Adopt it' })).toHaveProperty('disabled', false)
    fireEvent.click(detail().getByRole('button', { name: 'Adopt it' }))
    await waitFor(() => expect(mutate).toHaveBeenCalledTimes(2))
    expect(mutate).toHaveBeenLastCalledWith({ id: 'm-1' })
    await waitFor(() => expect(detail().queryByRole('alert')).toBeNull())
  })
  it('retains the removed machine and renders the server-authoritative removed state', async () => {
    const mutate = vi.fn().mockResolvedValue([])
    client({ revoke: { mutate } })
    state.machines = [machine()]
    const view = render()
    open()
    fireEvent.click(detail().getByRole('button', { name: 'Remove' }))
    fireEvent.click(detail().getByRole('button', { name: 'Remove machine' }))
    await waitFor(() => expect(screen.getByRole('button', { name: 'Build box' })).toBeTruthy())
    state.machines = [
      machine({
        revokedAt: '2026-09-17T12:00:00.000Z',
        online: false,
        lastSeenAt: '2026-09-17T11:00:00.000Z',
      }),
    ]
    view.refresh()
    const retained = within(machineRow('Build box'))
    expect(retained.getByText('Removed')).toBeTruthy()
    expect(retained.queryByText(/Offline · Last seen/)).toBeNull()
    open()
    expect(detail().queryByRole('button', { name: 'Remove' })).toBeNull()
    expect(detail().queryByRole('button', { name: /apply update/i })).toBeNull()
    expect(detail().queryByRole('textbox', { name: 'Name' })).toBeNull()
  })
  it('keeps the replacement pointer visible for the retained retired identity', () => {
    client()
    state.machines = [
      machine({
        revokedAt: '2026-09-17T12:00:00.000Z',
        online: false,
        supersededBy: asMachineId('replacement'),
      }),
    ]
    render()
    open()
    expect(detail().getByText('Replaced by replacement')).toBeTruthy()
    expect(detail().getByText('Replaced')).toBeTruthy()
    expect(detail().queryByRole('button', { name: 'Replace…' })).toBeNull()
  })
  it('does not offer Replace without the projected replacement authority', () => {
    client()
    state.machines = [machine({ transferable: true, supersedable: undefined })]
    render()
    open()
    expect(detail().getByRole('textbox', { name: 'Name' })).toBeTruthy()
    expect(detail().queryByRole('button', { name: 'Replace…' })).toBeNull()
  })
})
