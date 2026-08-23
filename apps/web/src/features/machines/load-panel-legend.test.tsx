// @vitest-environment happy-dom
/**
 * POD-1223: at balanced density the machine chip is two bare bars, and their
 * colour is severity, not identity — nothing on screen said which bar was
 * memory and which was load. The panel that opens on hover has to name them,
 * with the same fill the chip used, or the naming proves nothing.
 */
import { asMachineId, asSessionId, type SessionMeta } from '@podium/model'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
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
const memoryBreakdown = vi.fn(async () => ({
  hostname: 'vmi',
  sampledAt: '2026-08-17T00:00:00.000Z',
  supported: true,
  memory,
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
    trpc: {
      hosts: {
        memoryBreakdown: { mutate: memoryBreakdown },
        reclaimInventory: { mutate: reclaimInventory },
      },
      settings: { get: { query: settingsGet } },
    },
  })
  return {
    useStore,
    useReplicaIssues: () => [],
    useStoreSelector: (sel: (s: unknown) => unknown) => sel(useStore() as never),
  }
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

describe('the load panel names the chip’s two meters', () => {
  it('gives each meter its mark, its number, and the sentence its colour stood for', async () => {
    render(
      <LoadPanel pinned={false} machineId={asMachineId(MACHINE)} onOpenConnection={() => {}} />,
    )
    await waitFor(() => expect(settingsGet).toHaveBeenCalled())

    expect(row('MEM').querySelector('.hp-meter-value')?.textContent).toBe('38%')
    // 12e9 of 32e9 bytes, printed in GiB the way every other memory readout is.
    expect(row('MEM').querySelector('.hp-meter-note')?.textContent).toBe('11.2/29.8 GB used')

    expect(row('LOAD').querySelector('.hp-meter-value')?.textContent).toBe('3.0×')
    // The policy in settings, not the 1.5 default the meter falls back to.
    expect(row('LOAD').querySelector('.hp-meter-note')?.textContent).toBe(
      'per core — past the 2× line',
    )
  })

  it('repeats the chip’s fill so the named bar is the bar you pointed at', async () => {
    render(
      <LoadPanel pinned={false} machineId={asMachineId(MACHINE)} onOpenConnection={() => {}} />,
    )
    await waitFor(() => expect(settingsGet).toHaveBeenCalled())

    expect(fill('MEM').className).toContain('bg-success')
    expect(fill('MEM').style.width).toBe('38%')
    expect(fill('LOAD').className).toContain('bg-destructive')
    // Past the threshold the meter clamps rather than overflowing its track.
    expect(fill('LOAD').style.width).toBe('100%')
  })

  it('keeps the residency the removed native tooltip used to carry', async () => {
    render(
      <LoadPanel pinned={false} machineId={asMachineId(MACHINE)} onOpenConnection={() => {}} />,
    )
    await waitFor(() => expect(settingsGet).toHaveBeenCalled())

    expect(screen.getByText('3 agents here — 1 working, 1 idle, 1 waiting on you')).toBeTruthy()
  })
})
