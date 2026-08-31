import {
  asMachineId,
  type HostMetricsWire,
  type MachineWire,
  type QuotaWindowHistoryWire,
} from '@podium/model'
import type { HostMemoryBreakdown, MobileClientSession } from '@podium/protocol'
import { describe, expect, it } from 'vitest'
import {
  connectedDeviceViews,
  useGrantedHostMetrics,
  useGrantedMachineQuota,
  useGrantedQuotaHistory,
  visibleFleetOperations,
} from './operations-status'

const GIB = 1024 ** 3
const machine = (id: string, partial: Partial<MachineWire> = {}): MachineWire => ({
  id: asMachineId(id),
  name: id,
  hostname: `${id}.test`,
  online: true,
  lastSeenAt: '2026-08-31T00:00:00.000Z',
  use: 'granted',
  ...partial,
})

const host = (id?: string): HostMetricsWire => ({
  hostname: id ? `${id}.test` : 'legacy.test',
  ...(id ? { machineId: asMachineId(id) } : {}),
  sampledAt: '2026-08-31T00:00:00.000Z',
  memory: {
    totalBytes: 32 * GIB,
    availableBytes: 8 * GIB,
    swapTotalBytes: 0,
    swapFreeBytes: 0,
  },
  load: { one: 3, five: 2, fifteen: 1, cpuCount: 4 },
})

const breakdown: HostMemoryBreakdown = {
  hostname: 'owned.test',
  sampledAt: '2026-08-31T00:00:01.000Z',
  supported: true,
  memory: host('owned').memory,
  disk: {
    path: '/home/operator',
    totalBytes: 100 * GIB,
    usedBytes: 70 * GIB,
    availableBytes: 25 * GIB,
  },
  agents: [],
  projects: [],
  otherBytes: 0,
}

describe('visibleFleetOperations', () => {
  it('keeps visibility, use, liveness, and update state as separate facts', () => {
    const owned = machine('owned', {
      appVersion: '0.4.8',
      targetVersion: '0.4.8',
      versionState: 'current',
      updateChannel: 'stable',
    })
    const shared = machine('shared', {
      use: 'denied',
      appVersion: '0.4.7',
      targetVersion: '0.4.8',
      versionState: 'behind',
    })
    const fleet = visibleFleetOperations({
      machines: [owned, shared],
      hosts: [host('owned'), host('shared')],
      capacityReadings: {
        [owned.id]: { state: 'ready', value: breakdown },
        // A result cached before a grant was revoked must not render now.
        [shared.id]: { state: 'ready', value: breakdown },
      },
      loadPerCore: 1.5,
    })

    expect(fleet.fleetLabel).toBe('2 of 2 visible machines online')
    expect(fleet.updateLabel).toBe('1 machine behind')
    expect(fleet.usableCount).toBe(1)
    expect(fleet.machines[0]).toMatchObject({
      id: owned.id,
      capacityDetail: 'ready',
      updateLabel: '0.4.8 · current',
    })
    expect(fleet.machines[0]?.disk?.label).toBe('70/100 GB')
    expect(fleet.machines[1]).toMatchObject({
      id: shared.id,
      availability: 'unauthorized',
      capacityDetail: 'restricted',
      updateLabel: '0.4.7 → 0.4.8',
    })
    expect(fleet.machines[1]?.disk).toBeNull()
    expect(fleet.machines[1]?.memory).toBeNull()
    expect(fleet.machines[1]?.load).toBeNull()
  })

  it('labels an old capacity answer stale with its sample time', () => {
    const owned = machine('owned')
    const fleet = visibleFleetOperations({
      machines: [owned],
      hosts: [host('owned')],
      capacityReadings: { [owned.id]: { state: 'stale', value: breakdown } },
      nowMs: Date.parse('2026-08-31T00:05:01.000Z'),
    })
    expect(fleet.machines[0]).toMatchObject({
      capacityDetail: 'stale',
      capacityLabel: 'Stale · sampled 5m ago',
      sampledAt: breakdown.sampledAt,
    })
  })

  it('places an old host sample only when the visible fleet has one machine', () => {
    const sole = visibleFleetOperations({ machines: [machine('sole')], hosts: [host()] })
    expect(sole.machines[0]?.memory?.label).toBe('24.0/32 GB')

    const ambiguous = visibleFleetOperations({
      machines: [machine('one'), machine('two')],
      hosts: [host()],
    })
    expect(ambiguous.machines.every((row) => row.memory === null)).toBe(true)
  })
})

describe('useGrantedHostMetrics', () => {
  it('removes host facts for invisible and use-denied machines', () => {
    const granted = machine('granted')
    const denied = machine('denied', { use: 'denied' })
    expect(
      useGrantedHostMetrics(
        [granted, denied],
        [host('granted'), host('denied'), host('invisible')],
      ).map((sample) => sample.machineId),
    ).toEqual([granted.id])
  })

  it('accepts an untagged legacy sample only for one granted visible machine', () => {
    expect(useGrantedHostMetrics([machine('sole')], [host()])).toHaveLength(1)
    expect(
      useGrantedHostMetrics([machine('one'), machine('two', { use: 'denied' })], [host()]),
    ).toHaveLength(0)
  })

  it('removes quota facts for invisible and use-denied machines', () => {
    const granted = machine('granted')
    const denied = machine('denied', { use: 'denied' })
    const quota = (machineId: MachineWire['id']) => ({
      machineId,
      machineName: machineId,
      hostname: `${machineId}.test`,
      agents: [],
    })
    expect(
      useGrantedMachineQuota(
        [granted, denied],
        [quota(granted.id), quota(denied.id), quota(asMachineId('invisible'))],
      ).map((reading) => reading.machineId),
    ).toEqual([granted.id])
  })

  it('keeps history only for accounts established by granted live quota', () => {
    const granted = machine('granted')
    const denied = machine('denied', { use: 'denied' })
    const quota = (machineRow: MachineWire, email: string) => ({
      machineId: machineRow.id,
      machineName: machineRow.name,
      hostname: machineRow.hostname,
      agents: [
        {
          agent: 'codex' as const,
          status: 'ok' as const,
          account: { email },
          windows: [],
          fetchedAt: '2026-08-31T00:00:00.000Z',
        },
      ],
    })
    const history = (accountKey: string): QuotaWindowHistoryWire => ({
      accountKey,
      agent: 'codex',
      windowKey: 'weekly',
      label: 'Weekly',
      resetsAt: '2026-08-31T00:00:00.000Z',
      windowMinutes: 10_080,
      firstSeenAt: '2026-08-24T00:00:00.000Z',
      lastSeenAt: '2026-08-31T00:00:00.000Z',
      firstPercent: 0,
      peakPercent: 50,
      lastPercent: 50,
      sampleCount: 2,
      closed: true,
      partial: false,
      source: 'live',
    })
    const rows = useGrantedQuotaHistory(
      [granted, denied],
      [quota(granted, 'mine@example.com'), quota(denied, 'other@example.com')],
      [
        history('codex::mine@example.com'),
        history('codex::other@example.com'),
        history('codex::machine:granted'),
        history('codex::machine:invisible'),
      ],
    )
    expect(rows.map((row) => row.accountKey)).toEqual([
      'codex::mine@example.com',
      'codex::machine:granted',
    ])
  })
})

describe('connectedDeviceViews', () => {
  const session = (
    sessionId: string,
    partial: Partial<MobileClientSession> = {},
  ): MobileClientSession => ({
    sessionId,
    userId: 'user:one',
    label: 'mobile',
    deviceId: `device-${sessionId}`,
    deviceName: sessionId,
    platform: 'ios',
    createdAt: '2026-08-29T00:00:00.000Z',
    expiresAt: '2026-09-30T00:00:00.000Z',
    lastSeenAt: null,
    current: false,
    ...partial,
  })

  it('puts this device first and publishes no user identity', () => {
    const views = connectedDeviceViews(
      [
        session('recent', { lastSeenAt: '2026-08-30T23:55:00.000Z' }),
        session('current', { current: true, deviceName: 'My iPhone' }),
      ],
      Date.parse('2026-08-31T00:00:00.000Z'),
    )
    expect(views.map((view) => view.sessionId)).toEqual(['current', 'recent'])
    expect(views[0]).toMatchObject({
      name: 'My iPhone',
      platform: 'iOS',
      activityLabel: 'This device · active now',
    })
    expect(views[1]?.activityLabel).toBe('Active 5m ago')
    expect(views.some((view) => 'userId' in view)).toBe(false)
  })
})
