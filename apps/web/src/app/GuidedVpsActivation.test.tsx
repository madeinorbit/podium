// @vitest-environment happy-dom
import { asMachineId } from '@podium/model'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ConfirmedVpsActivation } from '@/features/setup/use-vps-activation'
import { vpsIntroState, vpsPairingState, vpsTransferState } from '@/features/setup/vps-activation'
import { clearVpsCheckpointAndReturn, GuidedVpsActivation } from './GuidedVpsActivation'

const mocks = vi.hoisted(() => ({
  store: { machines: [], trpc: {} },
  pairing: {
    pairingCode: null,
    joinCommand: null,
    publicUrl: '',
    loading: false,
    error: null,
    podiumManaged: false,
    newMachine: null as { id: string; name: string } | null,
    watchForNewMachine: vi.fn(),
    mint: vi.fn(),
    stopWatchingForNewMachine: vi.fn(),
    reset: vi.fn(),
  },
  status: { snapshot: null, error: null },
  transfer: {
    transfer: null as { publicUrl?: string } | null,
    publicUrl: '',
    displayState: null as string | null,
    setPublicUrl: vi.fn(),
    start: vi.fn(),
    showProgress: false,
    confirmation: '',
    error: null,
    awaitingStatus: false,
    checkingTarget: false,
    urlIsValid: false,
    canStart: false,
    checkTarget: vi.fn(),
  },
}))

vi.mock('@/app/store', () => ({
  useStoreSelector: (selector: (store: typeof mocks.store) => unknown) => selector(mocks.store),
}))

vi.mock('@/features/machines/machine-pairing', () => ({
  useMachinePairing: () => mocks.pairing,
}))

vi.mock('@/features/machines/server-transfer', () => ({
  transferErrorMessage: () => null,
  useServerTransfer: () => mocks.transfer,
  useServerTransferStatus: () => mocks.status,
}))

vi.mock('@/features/machines/MachinePairing', () => ({ MachinePairing: () => null }))
vi.mock('@/features/machines/ServerTransfer', () => ({
  ServerTransfer: () => null,
  ServerTransferProgress: () => null,
}))
vi.mock('@/features/setup/SetupView', () => ({ NetworkStep: () => null }))

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
  mocks.pairing.newMachine = null
  mocks.transfer.transfer = null
  mocks.transfer.publicUrl = ''
  mocks.transfer.displayState = null
  mocks.transfer.showProgress = false
})

function controller(
  returnRoute: 'welcome' | 'local-project',
  clear: ConfirmedVpsActivation['clear'],
): ConfirmedVpsActivation {
  return {
    state: vpsIntroState(returnRoute),
    ready: true,
    saving: false,
    error: null,
    persist: vi.fn(),
    clear,
  }
}

describe('guided VPS return route', () => {
  it('does not navigate away until the server confirms the checkpoint is cleared', async () => {
    let confirmClear: (() => void) | undefined
    const clear = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          confirmClear = resolve
        }),
    )
    const onRouteChange = vi.fn()

    render(
      <GuidedVpsActivation
        route="vps-intro"
        vps={controller('welcome', clear)}
        onRouteChange={onRouteChange}
        onExplore={vi.fn()}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: 'Back to welcome' }))
    expect(clear).toHaveBeenCalledOnce()
    expect(onRouteChange).not.toHaveBeenCalled()

    confirmClear?.()
    await waitFor(() => expect(onRouteChange).toHaveBeenCalledWith('welcome'))
  })

  it('preserves the local-project return route and stays put when clearing fails', async () => {
    const onRouteChange = vi.fn()
    await expect(
      clearVpsCheckpointAndReturn(
        { clear: vi.fn().mockRejectedValue(new Error('not confirmed')) },
        'local-project',
        onRouteChange,
      ),
    ).rejects.toThrow('not confirmed')

    expect(onRouteChange).not.toHaveBeenCalled()
  })

  it('returns a daemon-only setup to the route that opened the VPS flow', async () => {
    const clear = vi.fn().mockResolvedValue(undefined)
    const onRouteChange = vi.fn()
    const vps = controller('welcome', clear)
    vps.state = vpsPairingState(vps.state!, [], false)
    mocks.pairing.newMachine = { id: 'vps-machine', name: 'Always-on VPS' }

    render(
      <GuidedVpsActivation
        route="vps-pairing"
        vps={vps}
        onRouteChange={onRouteChange}
        onExplore={vi.fn()}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: 'Keep the current server' }))

    await waitFor(() => expect(clear).toHaveBeenCalledOnce())
    expect(mocks.pairing.reset).toHaveBeenCalledOnce()
    expect(onRouteChange).toHaveBeenCalledWith('welcome')
  })

  it('finishes on the destination using the persisted return route', async () => {
    const clear = vi.fn().mockResolvedValue(undefined)
    const onRouteChange = vi.fn()
    const vps = controller('welcome', clear)
    vps.state = vpsTransferState(vps.state!, {
      machineId: asMachineId('vps-machine'),
      name: 'Always-on VPS',
      publicUrl: window.location.origin,
    })
    mocks.transfer.transfer = { publicUrl: window.location.origin }
    mocks.transfer.publicUrl = window.location.origin
    mocks.transfer.displayState = 'connected'

    render(
      <GuidedVpsActivation
        route="vps-transfer"
        vps={vps}
        onRouteChange={onRouteChange}
        onExplore={vi.fn()}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: 'Continue activation' }))

    await waitFor(() => expect(clear).toHaveBeenCalledOnce())
    expect(onRouteChange).toHaveBeenCalledWith('welcome')
  })
})
