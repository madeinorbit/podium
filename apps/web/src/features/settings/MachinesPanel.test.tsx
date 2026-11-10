import '@/test-support/mock-pool-store-handle'
import type { MachineWire } from '@podium/model'
import { asMachineId } from '@podium/model'
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react'
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
  fireEvent.click(screen.getByRole('button', { name: `Open ${name}` }))
}
function detail() {
  return within(screen.getByRole('region', { name: 'Build box' }))
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
    expect(screen.getByRole('button', { name: 'Open Build box' }).textContent).toContain(
      'Looked after by you',
    )
    expect(screen.getByText(/0 sessions.*memory/)).toBeTruthy()
    expect(screen.queryByRole('textbox', { name: 'Name' })).toBeNull()
    open()
    expect(screen.getByRole('textbox', { name: 'Name' })).toHaveProperty('value', 'Build box')
    expect(screen.getByRole('heading', { name: 'Who else can run agents here' })).toBeTruthy()
    expect(screen.getAllByRole('dialog')).toHaveLength(1)
    fireEvent.click(detail().getByRole('button', { name: 'Machines', exact: true }))
    expect(screen.getByRole('button', { name: 'Open Build box' })).toBeTruthy()
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
    expect(screen.queryByRole('button', { name: 'Open Visibility only' })).toBeNull()
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
    fireEvent.click(detail().getByRole('button', { name: 'Updates', exact: true }))
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
    fireEvent.click(await screen.findByRole('button', { name: 'Open Access' }))
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
    fireEvent.click(screen.getByRole('button', { name: 'Remove', exact: true }))
    fireEvent.click(screen.getByRole('button', { name: 'Remove machine', exact: true }))
    expect(await screen.findByRole('alert')).toHaveProperty(
      'textContent',
      'Machine is still the server',
    )
    fireEvent.click(screen.getByRole('button', { name: 'Remove machine', exact: true }))
    await waitFor(() =>
      expect(screen.queryByRole('button', { name: 'Remove machine', exact: true })).toBeNull(),
    )
    expect(mutate).toHaveBeenCalledTimes(2)
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
    expect(screen.queryByRole('button', { name: 'Replace machine', exact: true })).toBeNull()
    fireEvent.click(screen.getByLabelText('Replacement machine'))
    const options = await screen.findAllByRole('option')
    expect(options.map((option) => option.textContent).join(' ')).not.toContain('Retired')
    fireEvent.click(screen.getByRole('option', { name: /New box/ }))
    fireEvent.click(screen.getByRole('button', { name: 'Replace machine', exact: true }))
    expect(await screen.findByRole('alert')).toHaveProperty('textContent', 'Replacement retired')
    expect(mutate).toHaveBeenCalledWith({ id: 'm-1', replacementId: 'new' })
  })
  it('enables the paired offline device from its detail and stays busy while restarting', async () => {
    client()
    const bridge = stubBridge({ machineId: asMachineId('m-1') })
    const restart = vi.fn(() => new Promise<void>(() => {}))
    ;(window as unknown as { __PODIUM_RESTART__?: () => void }).__PODIUM_RESTART__ = restart
    state.machines = [machine({ online: false })]
    render()
    open()
    fireEvent.click(screen.getByRole('button', { name: 'Enable', exact: true }))
    await waitFor(() => expect(restart).toHaveBeenCalled())
    expect(bridge.enableHosting).toHaveBeenCalledWith('ABCD-EFGH')
    expect(screen.getByRole('button', { name: 'Enabling…' })).toHaveProperty('disabled', true)
  })
})
