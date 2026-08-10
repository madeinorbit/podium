import type { HostMetricsWire, MachineQuotaWire, QuotaWindowWire } from '@podium/model'
import { asMachineId } from '@podium/model'
import { describe, expect, it } from 'vitest'
import { capacityView, tightestLoad, tightestQuota } from './pulse'
import { groupQuotaByAccount } from './quota'

const NOW = Date.parse('2026-06-12T12:00:00.000Z')

const window = (over: Partial<QuotaWindowWire> = {}): QuotaWindowWire => ({
  key: '5h',
  label: '5-hour',
  usedPercent: 20,
  resetsAt: new Date(NOW + 3 * 3_600_000).toISOString(),
  windowMinutes: 300,
  ...over,
})

const machine = (windows: QuotaWindowWire[], agent: 'codex' | 'claude-code' = 'codex') =>
  ({
    machineId: asMachineId('m1'),
    machineName: 'studio',
    hostname: 'studio',
    agents: [
      {
        agent,
        status: 'ok' as const,
        account: { email: 'dev@example.com' },
        windows,
        fetchedAt: new Date(NOW).toISOString(),
      },
    ],
  }) satisfies MachineQuotaWire

const host = (one: number, cpuCount = 8): HostMetricsWire => ({
  hostname: 'studio',
  machineId: asMachineId('m1'),
  sampledAt: new Date(NOW).toISOString(),
  memory: {
    totalBytes: 32 * 1024 ** 3,
    availableBytes: 16 * 1024 ** 3,
    swapTotalBytes: 0,
    swapFreeBytes: 0,
  },
  load: { one, five: one, fifteen: one, cpuCount },
})

describe('tightestQuota', () => {
  it('reports the least-headroom gating window in remaining terms', () => {
    const groups = groupQuotaByAccount([
      machine([
        window({ usedPercent: 20 }),
        window({ key: 'wk', label: 'Weekly', usedPercent: 38 }),
      ]),
    ])
    const tight = tightestQuota(groups)
    expect(tight?.windowLabel).toBe('Weekly')
    expect(tight?.leftPercent).toBe(62)
  })

  it('never lets a spent model-scoped window speak for the pool', () => {
    // Spending a scoped bucket drops that MODEL, not the harness (POD-271), so
    // a 99%-spent Fable window must not report the account as out of room while
    // the gating window still has most of itself left.
    const groups = groupQuotaByAccount([
      machine([
        window({ usedPercent: 12 }),
        window({ key: 'wk:model:fable', label: 'Fable', usedPercent: 99, scopeModel: 'Fable' }),
      ]),
    ])
    expect(tightestQuota(groups)?.leftPercent).toBe(88)
  })

  it('is null when no pool can be read', () => {
    expect(tightestQuota([])).toBeNull()
  })
})

describe('tightestLoad', () => {
  it('picks the host closest to its park threshold', () => {
    const busy = { ...host(9.6), hostname: 'rig' }
    const hit = tightestLoad([host(2.4), busy], 1.5)
    expect(hit?.hostname).toBe('rig')
    // 9.6 / 8 cores = 1.2× per core, against a 1.5× threshold.
    expect(hit?.meterPct).toBe(80)
  })

  it('skips hosts whose daemon ships no load sample', () => {
    const { load: _dropped, ...noLoad } = host(1)
    expect(tightestLoad([noLoad], 1.5)).toBeNull()
  })
})

describe('capacityView', () => {
  it('names quota when it is the tighter of the two', () => {
    const view = capacityView({
      machines: [machine([window({ usedPercent: 38 })])],
      hosts: [host(2.4)], // 0.3x/core against 1.5 = 20% of the park line
      loadPerCore: 1.5,
      nowMs: NOW,
    })
    expect(view.constraint).toBe('quota')
    expect(view.headline).toBe('Room to run')
    expect(view.lead).toBe('Quota is the tighter limit.')
    expect(view.detail).toContain('62% left')
    expect(view.detail).toContain('five-hour')
  })

  it('names host pressure when the machine is the tighter limit', () => {
    const view = capacityView({
      machines: [machine([window({ usedPercent: 10 })])],
      hosts: [host(9.6)], // 80% of the park line, against 10% quota
      loadPerCore: 1.5,
      nowMs: NOW,
    })
    expect(view.constraint).toBe('load')
    expect(view.lead).toBe('Host pressure is the tighter limit.')
    expect(view.detail).toContain('80% of its park line')
  })

  it('escalates the headline off whichever reading is worst', () => {
    const spent = capacityView({
      machines: [machine([window({ usedPercent: 96 })])],
      hosts: [host(1)],
      loadPerCore: 1.5,
      nowMs: NOW,
    })
    expect(spent.tone).toBe('crit')
    expect(spent.headline).toBe('No room to start')

    const parking = capacityView({
      machines: [machine([window({ usedPercent: 5 })])],
      hosts: [host(16)], // 2.0x/core — past the 1.5x park line
      loadPerCore: 1.5,
      nowMs: NOW,
    })
    expect(parking.tone).toBe('crit')
    expect(parking.detail).toContain('past the park line')
  })

  it('says so rather than claiming room when nothing has been read', () => {
    const view = capacityView({ machines: null, hosts: [], loadPerCore: null, nowMs: NOW })
    expect(view.constraint).toBe('unknown')
    expect(view.quota).toBeNull()
    expect(view.load).toBeNull()
    // Not "Room to run": with no readings that would be a claim, not an answer.
    expect(view.headline).toBe('Nothing to report')
  })
})
