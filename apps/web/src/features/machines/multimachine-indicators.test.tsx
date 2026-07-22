// @vitest-environment happy-dom
/**
 * #136: the host status strip is machine-aware.
 *
 *  - Memory: clicking a machine's memory chip requests THAT machine's breakdown
 *    (regression: it always showed the first online machine).
 *  - Quota: the overlay groups by machine so two accounts are both visible.
 */
import type { MachineQuotaWire } from '@podium/protocol'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { HeaderHostIndicators, HostIndicators } from './HostIndicators'
import { QuotaIndicator } from './QuotaIndicator'

const memoryBreakdown = vi.fn()
const quotaSummary = vi.fn()
const settingsGet = vi.fn(async () => ({
  hibernation: { enabled: false, memoryPct: 80, idleMinutes: 30 },
}))
const setView = vi.fn()
const setSettingsTab = vi.fn()
const setupInfo = vi.fn(async () => ({ publicUrl: null, appVersion: '0.5.0' }))

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
    // POD-838: vmi trails the server build; podium-host matches it.
    machines: [
      {
        id: 'podium-host',
        name: 'podium-host',
        hostname: 'podium-host',
        online: true,
        lastSeenAt: 0,
        inventory: { os: 'linux', arch: 'x64', podiumVersion: '0.5.0', agents: [], tools: [] },
      },
      {
        id: 'vmi34',
        name: 'vmi',
        hostname: 'vmi',
        online: true,
        lastSeenAt: 0,
        inventory: { os: 'linux', arch: 'x64', podiumVersion: '0.4.1', agents: [], tools: [] },
      },
    ],
    setView,
    setSettingsTab,
    trpc: {
      quota: { summary: { query: quotaSummary } },
      hosts: { memoryBreakdown: { mutate: memoryBreakdown } },
      settings: { get: { query: settingsGet } },
      setup: { info: { query: setupInfo } },
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
  it('shows a scoped header meter for each usable subscription', async () => {
    const mixed = machineQuota('solo', 'solo', 'solo', 'claude@example.com', 98)
    mixed.agents.push({
      agent: 'codex',
      status: 'ok',
      account: { email: 'codex@example.com', plan: 'plus' },
      windows: [
        { key: 'weekly', label: 'Weekly', usedPercent: 10, resetsAt: '', windowMinutes: 10080 },
      ],
      fetchedAt: '2026-07-07T00:00:00.000Z',
    })
    quotaSummary.mockResolvedValue([mixed])

    render(<QuotaIndicator header />)

    const chip = await screen.findByRole('button', {
      name: /Agent quota: Claude Code \(claude@example.com\) 98% used; Codex \(codex@example.com\) 10% used/i,
    })
    expect(within(chip).getByText('CC')).toBeTruthy()
    expect(within(chip).getByText('CX')).toBeTruthy()
    const meters = chip.querySelectorAll<HTMLElement>('.header-quota-meter > span')
    expect(meters).toHaveLength(2)
    expect(meters[0]?.style.width).toBe('98%')
    expect(meters[1]?.style.width).toBe('10%')
    expect(meters[0]?.className).toContain('bg-destructive')
    expect(meters[1]?.className).toContain('bg-success')

    fireEvent.click(chip)
    await waitFor(() => expect(screen.getByText('1 constrained · 1 healthy')).toBeTruthy())
  })

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

// POD-838: the header machine chips flag a daemon whose build trails the server —
// skew must be visible without opening Settings → Machines.
describe('header chips flag version skew', () => {
  it('marks only the machine behind the server build', async () => {
    render(<HeaderHostIndicators />)
    // The vmi chip (daemon 0.4.1 vs server 0.5.0) grows the update marker...
    await waitFor(() => expect(screen.getByLabelText('Update available')).toBeTruthy())
    // ...and exactly one chip carries it — podium-host matches the server.
    expect(screen.getAllByLabelText('Update available')).toHaveLength(1)
    const vmiChip = screen.getByRole('button', { name: /^vmi:/i })
    expect(vmiChip.querySelector('[aria-label="Update available"]')).toBeTruthy()
  })
})
