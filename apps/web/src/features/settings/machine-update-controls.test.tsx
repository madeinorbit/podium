import '@/test-support/mock-pool-store-handle'
import type { MachineWire } from '@podium/model'
import { asMachineId } from '@podium/model'
import { act, cleanup, fireEvent, screen, waitFor } from '@testing-library/react'
import type { ReactElement } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { NativeDesktopBridge } from '@/lib/nativeDesktop'
import { renderSettingsPool } from '@/test-support/mock-settings-pool-fixture'

// The unchanged per-machine updater behavior, independent of the Machines page layout.

const storeState: {
  machines: MachineWire[]
  trpc: import('@/app/trpc').Trpc
  setSettingsTab: () => void
} = {
  machines: [],
  trpc: {} as import('@/app/trpc').Trpc,
  setSettingsTab: () => {},
}

vi.mock('@/app/store', () => ({
  readFixture: (selector: (s: typeof storeState) => unknown) => selector(storeState),
}))

// The update-status reader (POD-6683) builds its own plain-HTTP client; here it
// is this test's store client (whichever one the test set last), and the page's
// `/version` reads answer nothing.
vi.mock('@/app/trpc', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/app/trpc')>()),
  makeTrpc: () =>
    new Proxy(
      {},
      { get: (_target, key) => (storeState.trpc as Record<PropertyKey, unknown>)[key] },
    ),
}))
vi.mock('@/lib/workspace-request', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/workspace-request')>()),
  workspaceFetch: async () => ({ ok: false }),
}))

import { observer } from '@podium/client-graph/react'
import { useFleetConvergence } from '@/app/MachinesPanel'
import { resetUpdateStatus } from '@/lib/update-status'
import { MachineUpdateControls } from './machine-update-controls'
import { useSettingsMachines } from './readers'
import { SettingsOpening } from './SettingsOpening'

/** The panel reads its machines through the Settings opening (its machine
 * readers over the pool), so every render mounts that root, as Settings does. */
function render(ui: ReactElement) {
  const view = renderSettingsPool(<SettingsOpening>{ui}</SettingsOpening>)
  return {
    ...view,
    rerender: (next: ReactElement) => view.rerender(<SettingsOpening>{next}</SettingsOpening>),
  }
}

/** Settings → Labs "Podium development" (POD-1882). */
let developing = false
vi.mock('@/lib/use-feature', () => ({ useFeature: () => developing }))

afterEach(() => {
  cleanup()
  resetUpdateStatus()
  vi.restoreAllMocks()
  vi.useRealTimers()
  storeState.machines = []
  developing = false
  ;(globalThis as { __PODIUM_DESKTOP__?: NativeDesktopBridge }).__PODIUM_DESKTOP__ = undefined
  ;(window as unknown as { __PODIUM_RESTART__?: () => void }).__PODIUM_RESTART__ = undefined
})

function machine(overrides: Partial<MachineWire>): MachineWire {
  return {
    id: asMachineId('m-1'),
    name: 'mac',
    hostname: 'build.example',
    online: false,
    lastSeenAt: Date.now() - 60_000,
    ...overrides,
  } as MachineWire
}

const UpdateControlsPanel = observer(function UpdateControlsPanel() {
  const machines = useSettingsMachines()
  const convergence = useFleetConvergence()
  return (
    <>
      {machines.map((machine) => (
        <MachineUpdateControls
          key={machine.id}
          machine={machine}
          trpc={storeState.trpc}
          convergence={convergence.rows.get(machine.id) ?? null}
          onApplied={convergence.refresh}
        />
      ))}
    </>
  )
})

describe('MachineUpdateControls update rows', () => {
  function setUpdateTrpc() {
    storeState.trpc = {
      machines: { pairingCode: { mutate: vi.fn() }, applyUpdate: { mutate: vi.fn() } },
      setup: { info: { query: vi.fn().mockResolvedValue({ publicUrl: null }) } },
    } as unknown as import('@/app/trpc').Trpc
  }

  const applyButton = () => screen.getByRole('button', { name: /apply update to/i })

  it('offers the ordinary Apply path to a capable supervisor', async () => {
    storeState.machines = [
      machine({
        name: 'macbook',
        online: true,
        presenceSource: 'supervisor',
        deliveryCaps: ['update.delivery.feed'],
        targetVersion: '0.5.0',
      }),
    ]
    setUpdateTrpc()
    render(<UpdateControlsPanel />)

    expect(await screen.findByText('Target 0.5.0')).toBeTruthy()
    expect(applyButton().hasAttribute('disabled')).toBe(false)
    expect(screen.queryByText(/Managed by Podium Desktop/)).toBeNull()
  })

  it('keeps a Desktop-owned supervisor visible but disables server delivery', async () => {
    const observedAt = '2026-08-26T12:00:00.000Z'
    storeState.machines = [
      machine({
        name: 'macbook',
        online: true,
        presenceSource: 'supervisor',
        deliveryCaps: [],
        targetVersion: '0.5.0',
        services: {
          server: { policy: 'enabled', state: 'available', observedAt },
          agentExecution: { policy: 'disabled', state: 'stopped', observedAt },
          crashOwner: 'desktop',
        },
      }),
    ]
    setUpdateTrpc()
    render(<UpdateControlsPanel />)

    expect(
      await screen.findByText('Cannot take delivery: Managed by Desktop updater.'),
    ).toBeTruthy()
    expect(applyButton().hasAttribute('disabled')).toBe(true)
  })

  it('still offers Apply to an ordinary fleet machine', async () => {
    storeState.machines = [machine({ name: 'worker', online: true, targetVersion: '0.5.0' })]
    setUpdateTrpc()
    render(<UpdateControlsPanel />)

    expect(await screen.findByText('Target 0.5.0')).toBeTruthy()
    expect(applyButton().hasAttribute('disabled')).toBe(false)
    expect(screen.queryByText(/Managed by Podium Desktop/)).toBeNull()
  })

  it('says why there is nothing to apply, in prose', async () => {
    storeState.machines = [
      machine({
        name: 'worker',
        online: true,
        updateChannelOverride: 'stable',
        targetUnavailableReason: 'No update target is configured.',
      }),
    ]
    setUpdateTrpc()
    render(<UpdateControlsPanel />)

    expect(await screen.findByText('Nothing published on Stable yet.')).toBeTruthy()
    // The server's own sentence stays available on hover, and nowhere else.
    expect(screen.queryByText('No update target is configured.')).toBeNull()
  })
})

describe('MachineUpdateControls update action', () => {
  const managed = (over: Partial<MachineWire> = {}): MachineWire =>
    machine({
      id: asMachineId('buildbox'),
      name: 'buildbox',
      online: true,
      podiumManaged: true,
      updateChannel: 'dev',
      appVersion: 'dev+72c2e0e',
      targetVersion: 'dev+4f36e8e',
      ...over,
    })

  function setUpdateTrpc(over: {
    applyUpdate?: () => Promise<unknown>
    fleet?: () => Promise<unknown>
  }) {
    storeState.trpc = {
      machines: {
        pairingCode: { mutate: vi.fn() },
        applyUpdate: { mutate: over.applyUpdate ?? vi.fn() },
        setUpdateChannel: { mutate: vi.fn() },
      },
      updates: {
        fleet: {
          query:
            over.fleet ?? vi.fn().mockResolvedValue({ machines: [], allMachines: [], behind: 0 }),
        },
      },
      setup: { info: { query: vi.fn().mockResolvedValue({ publicUrl: null }) } },
    } as unknown as import('@/app/trpc').Trpc
  }

  const applyButton = () => screen.getByRole('button', { name: /apply update to buildbox/i })

  it('shows source ownership instead of a package Apply control', async () => {
    storeState.machines = [managed({ installKind: 'source' })]
    setUpdateTrpc({})
    render(<UpdateControlsPanel />)

    expect(await screen.findByText('Source checkout')).toBeTruthy()
    expect(screen.queryByRole('button', { name: /apply update to buildbox/i })).toBeNull()
  })

  it('says nothing about an update it never watched', async () => {
    storeState.machines = [managed({ appVersion: 'dev+4f36e8e' })]
    setUpdateTrpc({
      fleet: vi.fn().mockResolvedValue({
        allMachines: [{ id: 'buildbox', state: 'current', version: 'dev+4f36e8e' }],
      }),
    })
    render(<UpdateControlsPanel />)

    await waitFor(() => expect(storeState.trpc.updates.fleet.query).toHaveBeenCalled())
    // Let the snapshot land and its effects run; the point is that NOTHING is
    // announced once they have, not that the assertion beat them.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20))
    })
    expect(screen.queryByText(/is up to date/i)).toBeNull()
    expect(screen.queryByRole('status')).toBeNull()
  })

  it('shows progress and refuses further clicks while the machine is converging', async () => {
    storeState.machines = [managed()]
    setUpdateTrpc({
      fleet: vi.fn().mockResolvedValue({
        allMachines: [{ id: 'buildbox', state: 'downloading', version: 'dev+72c2e0e' }],
      }),
    })
    render(<UpdateControlsPanel />)

    // Convergence started elsewhere — this row still reports it after a reload.
    expect(await screen.findByText(/downloading update/i)).toBeTruthy()
    expect(applyButton()).toHaveProperty('disabled', true)
  })

  it('offers Try again for a terminal machine and issues a fresh apply', async () => {
    const applyUpdate = vi.fn().mockResolvedValue({
      machines: [managed()],
      outcome: { result: 'granted', version: 'dev+4f36e8e' },
    })
    storeState.machines = [managed()]
    setUpdateTrpc({
      applyUpdate,
      fleet: vi.fn().mockResolvedValue({
        allMachines: [{ id: 'buildbox', state: 'stuck', version: 'dev+72c2e0e' }],
      }),
    })
    render(<UpdateControlsPanel />)

    const retry = await screen.findByRole('button', { name: /apply update to buildbox/i })
    expect(retry.textContent).toBe('Try again')
    fireEvent.click(retry)
    await waitFor(() => expect(applyUpdate).toHaveBeenCalledWith({ id: 'buildbox' }))
  })

  it('keeps the action in one place when a message appears under it', async () => {
    const applyUpdate = vi.fn().mockResolvedValue({
      machines: [managed()],
      outcome: { result: 'offline' },
    })
    storeState.machines = [managed()]
    setUpdateTrpc({ applyUpdate })
    render(<UpdateControlsPanel />)

    const before = applyButton()
    const siblingsBefore = [...(before.parentElement?.children ?? [])].indexOf(before)
    fireEvent.click(before)

    // Actionable copy, not the coordinator's internal grant vocabulary.
    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toMatch(/buildbox is not connected/i)
    expect(alert.textContent).not.toMatch(/grant/i)

    const after = applyButton()
    expect([...(after.parentElement?.children ?? [])].indexOf(after)).toBe(siblingsBefore)
  })
})

/**
 * POD-1882. Choosing a source PER MACHINE is a Podium-development affordance; the
 * pin itself is durable and stays disclosed when the control is gone.
 */
describe('MachineUpdateControls per-machine update source', () => {
  function setTrpc() {
    storeState.trpc = {
      setup: {
        info: { query: vi.fn().mockResolvedValue({ publicUrl: null, appVersion: '0.5.0' }) },
      },
      machines: { setUpdateChannel: { mutate: vi.fn().mockResolvedValue([]) } },
    } as unknown as import('@/app/trpc').Trpc
  }

  it('hides the channel pin without the development lab', async () => {
    storeState.machines = [
      machine({ updateChannel: 'dev', updateChannelOverride: 'dev', targetVersion: '0.6.0' }),
    ]
    setTrpc()
    render(<UpdateControlsPanel />)

    expect(await screen.findByText('Target 0.6.0')).toBeTruthy()
    expect(screen.queryByText(/pinned for this machine/)).toBeNull()
    expect(screen.queryByLabelText('Update channel for mac')).toBeNull()
  })

  it('keeps the target readable without a channel control', async () => {
    storeState.machines = [
      machine({ updateChannel: 'stable', updateChannelOverride: null, targetVersion: '0.6.0' }),
    ]
    setTrpc()
    render(<UpdateControlsPanel />)

    expect(await screen.findByText('Target 0.6.0')).toBeTruthy()
    expect(screen.queryByLabelText('Update channel for mac')).toBeNull()
  })

  it('shows the selector with the flag on', async () => {
    developing = true
    storeState.machines = [
      machine({ updateChannel: 'edge', updateChannelOverride: 'edge', targetVersion: '0.6.0' }),
    ]
    setTrpc()
    render(<UpdateControlsPanel />)

    const trigger = await screen.findByLabelText('Update channel for mac')
    expect(trigger.textContent).toContain('Edge')
  })

  it('offers Fleet default first, so a pin can always be cleared', async () => {
    developing = true
    storeState.machines = [
      machine({ updateChannel: 'dev', updateChannelOverride: 'dev', targetVersion: '0.6.0' }),
    ]
    setTrpc()
    render(<UpdateControlsPanel />)

    fireEvent.click(await screen.findByLabelText('Update channel for mac'))
    const options = (await screen.findAllByRole('option')).map((o) => o.textContent)
    // First on purpose: it is the only choice that is not a pin (POD-1882).
    expect(options).toEqual(['Fleet default', 'Development', 'Edge', 'Stable'])
  })
})
