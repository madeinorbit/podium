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
  },
]

vi.mock('@/app/store', () => ({
  useStoreSelector: (selector: (store: unknown) => unknown) =>
    selector({ trpc, machines }),
}))

const { UpdatesSection } = await import('./updates')

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe('UpdatesSection', () => {
  it('shows the running version, target, and per-machine version state', async () => {
    trpc.setup.channel.query.mockResolvedValue('stable')
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
    trpc.setup.channel.query.mockResolvedValue('stable')
    trpc.setup.info.query.mockResolvedValue({ appVersion: 'dev+abc1234' })
    trpc.updates.fleet.query.mockResolvedValue({
      targetVersion: null,
      total: 0,
      behind: 0,
      converging: 0,
      failed: 0,
      machines: [],
    })
    trpc.setup.setChannel.mutate.mockResolvedValue('edge')

    render(<UpdatesSection />)
    fireEvent.click(await screen.findByRole('button', { name: 'Edge' }))

    await waitFor(() =>
      expect(trpc.setup.setChannel.mutate).toHaveBeenCalledWith({ channel: 'edge' }),
    )
    expect(screen.getByRole('button', { name: 'Edge' }).getAttribute('aria-pressed')).toBe('true')
    expect(screen.getByText('dev+abc1234')).toBeTruthy()
  })
})
