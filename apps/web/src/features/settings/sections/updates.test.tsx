import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

const trpc = {
  setup: {
    channel: { query: vi.fn() },
    info: { query: vi.fn() },
    setChannel: { mutate: vi.fn() },
  },
  updates: { fleet: { query: vi.fn() } },
}

const machines = [
  {
    id: 'machine-ludovico',
    name: 'ludovico',
    hostname: 'ludovico.local',
    appVersion: '0.4.1',
    versionState: 'behind',
    updateChannelOverride: null as string | null,
    targetUnavailableReason: null as string | null,
  },
]

vi.mock('@/app/store', () => ({
  useStoreSelector: (selector: (store: unknown) => unknown) =>
    selector({ trpc, machines }),
}))

/** Settings → Experimental "Podium development" (POD-1882). */
let developing = false
vi.mock('@/lib/use-feature', () => ({ useFeature: () => developing }))

const { UpdatesSection } = await import('./updates')

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
  developing = false
})

const emptyFleet = {
  targetVersion: null,
  total: 0,
  behind: 0,
  converging: 0,
  failed: 0,
  machines: [],
}

describe('UpdatesSection', () => {
  it('shows the running version, target, and per-machine version state', async () => {
    trpc.setup.channel.query.mockResolvedValue({ channel: 'stable', envForced: false })
    trpc.setup.info.query.mockResolvedValue({ appVersion: '0.4.1' })
    trpc.updates.fleet.query.mockResolvedValue({
      targetVersion: '0.4.2',
      total: 1,
      behind: 1,
      converging: 0,
      failed: 0,
      machines: [
        {
          id: 'machine-ludovico',
          version: '0.4.1',
          state: 'current',
          online: true,
          busy: false,
        },
      ],
    })

    render(<UpdatesSection />)

    expect(await screen.findByText('0.4.1')).toBeTruthy()
    expect(screen.getByText('0.4.2')).toBeTruthy()
    expect(screen.getByText('ludovico')).toBeTruthy()
    expect(screen.getByText('Behind target')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Stable' }).getAttribute('aria-pressed')).toBe('true')
  })

  it('keeps the channel selector writable', async () => {
    trpc.setup.channel.query.mockResolvedValue({ channel: 'stable', envForced: false })
    trpc.setup.info.query.mockResolvedValue({ appVersion: 'dev+abc1234' })
    trpc.updates.fleet.query.mockResolvedValue({
      targetVersion: null,
      total: 0,
      behind: 0,
      converging: 0,
      failed: 0,
      machines: [],
    })
    trpc.setup.setChannel.mutate.mockResolvedValue({ channel: 'edge', envForced: false })

    render(<UpdatesSection />)
    fireEvent.click(await screen.findByRole('button', { name: 'Edge' }))

    await waitFor(() =>
      expect(trpc.setup.setChannel.mutate).toHaveBeenCalledWith({ channel: 'edge' }),
    )
    expect(screen.getByRole('button', { name: 'Edge' }).getAttribute('aria-pressed')).toBe('true')
    expect(screen.getByText('dev+abc1234')).toBeTruthy()
  })

  /**
   * POD-1882. The fleet-default selector is ordinary operation, so it is always
   * here; only Development is gated. These four cases are the whole contract.
   */
  describe('Podium development gating', () => {
    it('offers only the released channels without the flag', async () => {
      trpc.setup.channel.query.mockResolvedValue({ channel: 'stable', envForced: false })
      trpc.setup.info.query.mockResolvedValue({ appVersion: '0.4.1' })
      trpc.updates.fleet.query.mockResolvedValue(emptyFleet)

      render(<UpdatesSection />)

      expect(await screen.findByRole('button', { name: 'Stable' })).toBeTruthy()
      expect(screen.getByRole('button', { name: 'Edge' })).toBeTruthy()
      expect(screen.queryByRole('button', { name: 'Development' })).toBeNull()
    })

    it('adds Development with the flag on, and can select it', async () => {
      developing = true
      trpc.setup.channel.query.mockResolvedValue({ channel: 'stable', envForced: false })
      trpc.setup.info.query.mockResolvedValue({ appVersion: '0.4.1' })
      trpc.updates.fleet.query.mockResolvedValue(emptyFleet)
      trpc.setup.setChannel.mutate.mockResolvedValue({ channel: 'dev', envForced: false })

      render(<UpdatesSection />)
      fireEvent.click(await screen.findByRole('button', { name: 'Development' }))

      await waitFor(() =>
        expect(trpc.setup.setChannel.mutate).toHaveBeenCalledWith({ channel: 'dev' }),
      )
      expect(screen.getByRole('button', { name: 'Development' }).getAttribute('aria-pressed')).toBe(
        'true',
      )
    })

    it('still shows Development when the fleet is ON dev and the flag is off', async () => {
      // Turning the flag off must not make the selector lie about where the fleet is.
      trpc.setup.channel.query.mockResolvedValue({ channel: 'dev', envForced: false })
      trpc.setup.info.query.mockResolvedValue({ appVersion: '0.4.1' })
      trpc.updates.fleet.query.mockResolvedValue(emptyFleet)

      render(<UpdatesSection />)

      const dev = await screen.findByRole('button', { name: 'Development' })
      expect(dev.getAttribute('aria-pressed')).toBe('true')
    })

    it('explains a channel with no trusted target instead of showing a blank', async () => {
      // POD-1880: a dev bundle that is preparing/missing/failed has no target,
      // and that is a normal state the page has to be able to say out loud.
      trpc.setup.channel.query.mockResolvedValue({ channel: 'dev', envForced: false })
      trpc.setup.info.query.mockResolvedValue({ appVersion: '0.4.1' })
      trpc.updates.fleet.query.mockResolvedValue(emptyFleet)
      machines[0]!.targetUnavailableReason = 'dev bundle for 7de565e failed to build'

      render(<UpdatesSection />)

      expect(
        await screen.findByText(/No target: dev bundle for 7de565e failed to build/),
      ).toBeTruthy()
      machines[0]!.targetUnavailableReason = null
    })

    it('discloses a machine pinned away from the fleet default, flag or no flag', async () => {
      trpc.setup.channel.query.mockResolvedValue({ channel: 'stable', envForced: false })
      trpc.setup.info.query.mockResolvedValue({ appVersion: '0.4.1' })
      trpc.updates.fleet.query.mockResolvedValue(emptyFleet)
      machines[0]!.updateChannelOverride = 'dev'

      render(<UpdatesSection />)

      expect(await screen.findByText('Pinned: Development')).toBeTruthy()
      machines[0]!.updateChannelOverride = null
    })
  })
})
