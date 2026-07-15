// @vitest-environment happy-dom
/**
 * #136: the host status strip is machine-aware.
 *
 *  - Memory: clicking a machine's memory chip requests THAT machine's breakdown
 *    (regression: it always showed the first online machine).
 *  - Quota: the overlay groups by machine so two accounts are both visible.
 */
import type { MachineQuotaWire } from '@podium/protocol'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { HostIndicators } from './HostIndicators'
import { QuotaIndicator } from './QuotaIndicator'

const memoryBreakdown = vi.fn()
const quotaSummary = vi.fn()
const settingsGet = vi.fn(async () => ({
  hibernation: { enabled: false, memoryPct: 80, idleMinutes: 30 },
}))
const setView = vi.fn()
const setSettingsTab = vi.fn()

const host = (hostname: string, machineId: string) => ({
  hostname,
  machineId,
  name: hostname,
  sampledAt: '2026-07-07T00:00:00.000Z',
  memory: { totalBytes: 32e9, availableBytes: 20e9, swapTotalBytes: 0, swapFreeBytes: 0 },
})

const breakdownFor = (hostname: string) => ({
  hostname,
  sampledAt: '2026-07-07T00:00:00.000Z',
  supported: true,
  memory: { totalBytes: 32e9, availableBytes: 20e9, swapTotalBytes: 0, swapFreeBytes: 0 },
  agents: [],
  projects: [],
  otherBytes: 12e9,
})

vi.mock('@/app/store', () => {
  const useStore = () => ({
    hostMetrics: [host('podium-host', 'podium-host'), host('vmi', 'vmi34')],
    outboxSize: 0,
    sessions: [],
    setView,
    setSettingsTab,
    trpc: {
      quota: { summary: { query: quotaSummary } },
      hosts: { memoryBreakdown: { mutate: memoryBreakdown } },
      settings: { get: { query: settingsGet } },
    },
  })
  // The selector-store hook reads slices off the same store shape.
  return {
    useStore,
    useStoreSelector: (sel: (s: unknown) => unknown) => sel(useStore() as never),
  }
})

// Connection is machine-agnostic here; keep it healthy + hidden so it stays out
// of the way and we don't pull in the real websocket-backed hooks.
vi.mock('./ConnectionIndicator', () => ({
  useStableConnection: () => ({ health: { status: 'ok', rttMs: 10 }, visible: false }),
  useConnectionHealth: () => ({ status: 'ok', rttMs: 10 }),
  describeHealth: () => ({ headline: 'Connected', detail: '' }),
  ConnectionIndicator: () => null,
}))

const machineQuota = (
  machineId: string,
  machineName: string,
  hostname: string,
  email: string,
  fivePct: number,
): MachineQuotaWire => ({
  machineId,
  machineName,
  hostname,
  agents: [
    {
      agent: 'claude-code',
      status: 'ok',
      account: { email, plan: 'max' },
      windows: [
        { key: '5h', label: '5-hour', usedPercent: fivePct, resetsAt: '', windowMinutes: 300 },
        { key: 'weekly', label: 'Weekly', usedPercent: 10, resetsAt: '', windowMinutes: 10080 },
      ],
      fetchedAt: '2026-07-07T00:00:00.000Z',
    },
  ],
})

beforeEach(() => {
  vi.clearAllMocks()
  memoryBreakdown.mockResolvedValue(breakdownFor('vmi'))
  quotaSummary.mockResolvedValue([])
  // happy-dom lacks matchMedia; useIsMobile needs it.
  window.matchMedia = vi.fn().mockReturnValue({
    matches: false,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  }) as unknown as typeof window.matchMedia
})

afterEach(cleanup)

describe('memory chip is machine-aware', () => {
  it('requests the clicked machine breakdown, not the first machine', async () => {
    render(<HostIndicators />)
    // The vmi chip (second host) — its accessible name carries the hostname.
    const chip = screen.getByRole('button', { name: /vmi — memory/i })
    fireEvent.click(chip)
    await waitFor(() => expect(memoryBreakdown).toHaveBeenCalledWith({ machineId: 'vmi34' }))
    expect(memoryBreakdown).not.toHaveBeenCalledWith({ machineId: 'podium-host' })
  })

  it('requests the first machine when its own chip is clicked', async () => {
    render(<HostIndicators />)
    const chip = screen.getByRole('button', { name: /podium-host — memory/i })
    fireEvent.click(chip)
    await waitFor(() => expect(memoryBreakdown).toHaveBeenCalledWith({ machineId: 'podium-host' }))
  })
})

describe('quota overlay groups by account', () => {
  it('shows a card per distinct account, each labeled with its email + machine', async () => {
    quotaSummary.mockResolvedValue([
      machineQuota('podium-host', 'podium-host', 'podium-host', 'lud@example.com', 30),
      machineQuota('vmi34', 'vmi', 'vmi', 'vmi@example.com', 88),
    ])
    render(<QuotaIndicator />)
    const gauge = await screen.findByRole('button', { name: /agent quota/i })
    fireEvent.click(gauge)
    await waitFor(() => expect(screen.getByText('lud@example.com')).toBeTruthy())
    expect(screen.getByText('vmi@example.com')).toBeTruthy()
    // Each card is labeled with the machine the account is used on.
    expect(screen.getByText('podium-host')).toBeTruthy()
    expect(screen.getByText('vmi')).toBeTruthy()
  })

  it('dedupes a shared account into one card listing both machines', async () => {
    quotaSummary.mockResolvedValue([
      machineQuota('podium-host', 'podium-host', 'podium-host', 'shared@example.com', 30),
      machineQuota('vmi34', 'vmi', 'vmi', 'shared@example.com', 30),
    ])
    render(<QuotaIndicator />)
    const gauge = await screen.findByRole('button', { name: /agent quota/i })
    fireEvent.click(gauge)
    // One email, shown once, with both machines on the same card.
    await waitFor(() => expect(screen.getAllByText('shared@example.com')).toHaveLength(1))
    expect(screen.getByText('podium-host, vmi')).toBeTruthy()
  })

  it('single account: renders the account card with its email + machine', async () => {
    quotaSummary.mockResolvedValue([machineQuota('solo', 'solo', 'solo', 'solo@example.com', 20)])
    render(<QuotaIndicator />)
    const gauge = await screen.findByRole('button', { name: /agent quota/i })
    fireEvent.click(gauge)
    await waitFor(() => expect(screen.getByText('solo@example.com')).toBeTruthy())
    expect(screen.getByText('solo')).toBeTruthy()
  })

  it('renders a provider-labeled scoped window without UI-specific mapping', async () => {
    const quota = machineQuota('solo', 'solo', 'solo', 'solo@example.com', 20)
    quota.agents[0]?.windows.push({
      key: 'weekly-scoped:model:fable',
      label: 'Fable',
      usedPercent: 83,
      resetsAt: '',
      windowMinutes: 10080,
    })
    quotaSummary.mockResolvedValue([quota])

    render(<QuotaIndicator />)
    const gauge = await screen.findByRole('button', { name: /agent quota/i })
    fireEvent.click(gauge)

    await waitFor(() => expect(screen.getByText('Fable')).toBeTruthy())
    expect(screen.getByText(/83%/)).toBeTruthy()
  })
})
