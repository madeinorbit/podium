// @vitest-environment happy-dom
/**
 * POD-1223: at balanced density the machine chip is two bare bars, and their
 * colour is severity, not identity — nothing on screen said which bar was
 * memory and which was load. The panel that opens on hover has to name them,
 * with the same fill the chip used, or the naming proves nothing.
 *
 * POD-1603 adds the third meter (DISK, which has no chip bar to be confused
 * with), drops the click-to-pin tier so the panel shows everything at once, and
 * gives the `/proc` walk a 20s freshness window through the one polling utility
 * — so a re-opened panel asks the machine for nothing — with a control that
 * overrides it. The OPEN panel's 5s cadence is untouched.
 */
import { asMachineId, asSessionId, type SessionMeta } from '@podium/model'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { JSX } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { resetPolledQueryCache } from '@/lib/use-polled-query'
import { LoadPanel } from './LoadPanel'

const MACHINE = 'vmi34'

const settingsGet = vi.fn(async () => ({
  hibernation: {
    enabled: true,
    memoryPct: 85,
    idleMinutes: 30,
    // Deliberately not the 1.5 default: the note must quote the live policy.
    loadPerCore: 2,
    maxIdleSessions: 8,
  },
  worktreeGc: { mode: 'propose' as const, afterDays: 14 },
}))

const memory = { totalBytes: 32e9, availableBytes: 20e9, swapTotalBytes: 0, swapFreeBytes: 0 }
// 412 GiB used with 46 GiB spendable → 90%, and a 5 GiB gap between used+avail
// and total that only the root reserve explains. `df` would say 90% too.
const disk = {
  path: '/home/podium',
  totalBytes: 463 * 1024 ** 3,
  usedBytes: 412 * 1024 ** 3,
  availableBytes: 46 * 1024 ** 3,
}
const memoryBreakdown = vi.fn(async () => ({
  hostname: 'vmi',
  sampledAt: '2026-08-17T00:00:00.000Z',
  supported: true,
  memory,
  disk,
  agents: [],
  projects: [],
  otherBytes: 12e9,
}))
const reclaimInventory = vi.fn(async () => ({
  candidates: [],
  orphans: [],
  diagnostics: [],
  estimate: { status: 'unknown', recoverableBytes: null, measuredAt: null },
}))

const agentSession = (sessionId: string, phase: 'idle' | 'working' | 'needs_user'): SessionMeta =>
  ({
    sessionId: asSessionId(sessionId),
    title: sessionId,
    status: 'live',
    agentState: { phase, since: '2026-08-17T00:00:00.000Z', nativeSubagentCount: 0 },
    archived: false,
    machineId: asMachineId(MACHINE),
    agentKind: 'claude',
  }) as unknown as SessionMeta

vi.mock('@/app/store', () => {
  // Stable across renders, as the real store's client is (`useMemo` in
  // store.tsx). A fresh object per render would re-run every effect keyed on it.
  // Built on first use, not here: the factory is hoisted above the spies.
  let trpc: unknown
  const client = (): unknown => {
    trpc ??= {
      hosts: {
        memoryBreakdown: { mutate: memoryBreakdown },
        reclaimInventory: { mutate: reclaimInventory },
      },
      settings: { get: { query: settingsGet } },
    }
    return trpc
  }
  const useStore = () => ({
    hostMetrics: [
      {
        hostname: 'vmi',
        machineId: asMachineId(MACHINE),
        name: 'vmi',
        sampledAt: '2026-08-17T00:00:00.000Z',
        // 12/32 GB used → 38%, comfortably `ok`.
        memory,
        // 24 / 8 cores = 3× per core, past the 2× policy → critical.
        load: { one: 24, five: 20, fifteen: 18, cpuCount: 8 },
      },
    ],
    sessions: [
      agentSession('a', 'working'),
      agentSession('b', 'idle'),
      agentSession('c', 'needs_user'),
    ],
    issues: [],
    setView: vi.fn(),
    setSettingsTab: vi.fn(),
    trpc: client(),
  })
  return {
    useStore,
    useReplicaIssues: () => [],
    useStoreSelector: (sel: (s: unknown) => unknown) => sel(useStore() as never),
  }
})

beforeEach(() => {
  // The walk's cache is process-wide by design, so one test's answer would
  // otherwise satisfy the next and the caching tests below would prove nothing.
  resetPolledQueryCache()
})

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

const row = (mark: string): HTMLElement => {
  const found = [...document.querySelectorAll<HTMLElement>('.hp-meter-row')].find(
    (node) => node.querySelector('.hp-meter-mark')?.textContent === mark,
  )
  if (!found) throw new Error(`no ${mark} row in the panel legend`)
  return found
}

const fill = (mark: string): HTMLElement =>
  row(mark).querySelector<HTMLElement>('.header-meter > span') as HTMLElement

const panel = (): JSX.Element => (
  <LoadPanel machineId={asMachineId(MACHINE)} onOpenConnection={() => {}} />
)

/** Both round trips the panel makes on open: the settings read and the walk. */
const settled = async (): Promise<void> => {
  await waitFor(() => expect(settingsGet).toHaveBeenCalled())
  await waitFor(() =>
    expect(row('DISK').querySelector('.hp-meter-value')?.textContent).not.toBe('—'),
  )
}

describe('the load panel names the host’s three meters', () => {
  it('gives each meter its mark, its number, and the sentence its colour stood for', async () => {
    render(panel())
    await settled()

    expect(row('MEM').querySelector('.hp-meter-value')?.textContent).toBe('38%')
    // 12e9 of 32e9 bytes, printed in GiB the way every other memory readout is.
    expect(row('MEM').querySelector('.hp-meter-note')?.textContent).toBe('11.2/29.8 GB used')

    expect(row('LOAD').querySelector('.hp-meter-value')?.textContent).toBe('3.0×')
    // The policy in settings, not the 1.5 default the meter falls back to.
    expect(row('LOAD').querySelector('.hp-meter-note')?.textContent).toBe(
      'per core — past the 2× line',
    )

    // df's Use%: used ÷ (used + available), so the root-only reserve is not
    // counted as headroom the operator has.
    expect(row('DISK').querySelector('.hp-meter-value')?.textContent).toBe('90%')
    expect(row('DISK').querySelector('.hp-meter-note')?.textContent).toBe(
      '412/463 GB used · 46 GB free',
    )
  })

  it('repeats the chip’s fill so the named bar is the bar you pointed at', async () => {
    render(panel())
    await settled()

    expect(fill('MEM').className).toContain('bg-success')
    expect(fill('MEM').style.width).toBe('38%')
    expect(fill('LOAD').className).toContain('bg-destructive')
    // Past the threshold the meter clamps rather than overflowing its track.
    expect(fill('LOAD').style.width).toBe('100%')
    expect(fill('DISK').className).toContain('bg-destructive')
    expect(fill('DISK').style.width).toBe('90%')
  })

  it('holds the disk row’s place while the walk that carries it is in flight', async () => {
    render(panel())
    // The row exists before any answer — appearing late would push the whole
    // body down a line under the pointer.
    expect(row('DISK').querySelector('.hp-meter-value')?.textContent).toBe('—')
    expect(row('DISK').querySelector('.hp-meter-note')?.textContent).toBe('reading the volume…')
    await settled()
  })

  it('says so when a host reports no disk sample at all', async () => {
    memoryBreakdown.mockResolvedValueOnce({
      hostname: 'vmi',
      sampledAt: '2026-08-17T00:00:00.000Z',
      supported: true,
      memory,
      agents: [],
      projects: [],
      otherBytes: 12e9,
    } as unknown as Awaited<ReturnType<typeof memoryBreakdown>>)
    render(panel())
    await waitFor(() =>
      expect(row('DISK').querySelector('.hp-meter-note')?.textContent).toBe(
        'this host reports no disk sample',
      ),
    )
  })

  it('keeps the residency the removed native tooltip used to carry', async () => {
    render(panel())
    await settled()

    expect(screen.getByText('3 agents here — 1 working, 1 idle, 1 waiting on you')).toBeTruthy()
  })
})

describe('the panel shows the whole breakdown without a second gesture', () => {
  it('lists the process sections and the reclaimable inventory on open', async () => {
    render(panel())
    await settled()

    // All of this used to be behind click-to-pin.
    expect(screen.getByText('Agents & shells')).toBeTruthy()
    expect(screen.getByText('Project processes')).toBeTruthy()
    expect(screen.getByText('Reclaimable')).toBeTruthy()
    expect(screen.getByText('Everything else on this machine')).toBeTruthy()
    expect(screen.queryByText(/click to pin breakdown/i)).toBeNull()
  })
})

describe('the walk is cached, and the cache has a manual override', () => {
  it('serves a re-opened panel from the cache instead of re-walking the daemon', async () => {
    const first = render(panel())
    await settled()
    expect(memoryBreakdown).toHaveBeenCalledTimes(1)
    first.unmount()

    // Re-opening inside the freshness window: the numbers are on screen from
    // the first frame and no second walk is placed on the daemon.
    render(panel())
    expect(row('DISK').querySelector('.hp-meter-value')?.textContent).toBe('90%')
    await waitFor(() => expect(settingsGet).toHaveBeenCalled())
    expect(memoryBreakdown).toHaveBeenCalledTimes(1)
  })

  it('re-walks on demand when the refresh control is used', async () => {
    render(panel())
    await settled()
    expect(memoryBreakdown).toHaveBeenCalledTimes(1)

    fireEvent.click(screen.getByRole('button', { name: /re-measure this machine now/i }))
    await waitFor(() => expect(memoryBreakdown).toHaveBeenCalledTimes(2))
  })

  it('stamps the footer with when what you are reading was measured', async () => {
    render(panel())
    await settled()
    expect(screen.getByText(/^sampled \d\d:\d\d:\d\d$/)).toBeTruthy()
  })
})
