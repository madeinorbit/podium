import { HostMetricsWire } from '@podium/model'
import { describe, expect, it } from 'vitest'
import { parseServerMessageLenient } from './codec'
import { HostMetricsMessage } from './host'

const sample = {
  hostname: 'synthetic-host', sampledAt: '2026-10-02T12:00:00Z',
  memory: { totalBytes: 100, availableBytes: 50, swapTotalBytes: 0, swapFreeBytes: 0 },
}
const disk = { path: '/synthetic/home', totalBytes: 100, usedBytes: 54, availableBytes: 36 }

describe('optional disk telemetry', () => {
  it('preserves disk from the daemon heartbeat through the client frame parser', () => {
    const { type: _type, ...metrics } = HostMetricsMessage.parse({ type: 'hostMetrics', ...sample, disk })
    expect(metrics.disk).toEqual(disk)
    const parsed = parseServerMessageLenient(JSON.stringify({ type: 'hostMetricsChanged', hosts: [metrics] }))
    expect(parsed.dropped).toBe(0)
    expect(parsed.message).toMatchObject({ type: 'hostMetricsChanged', hosts: [{ disk }] })
  })

  it('accepts older daemons and lets older schemas ignore the additive field', () => {
    expect(HostMetricsMessage.parse({ type: 'hostMetrics', ...sample })).not.toHaveProperty('disk')
    const parsed = parseServerMessageLenient(JSON.stringify({ type: 'hostMetricsChanged', hosts: [sample] }))
    expect(parsed.dropped).toBe(0)
    expect(parsed.message).toMatchObject({ hosts: [sample] })
    expect(HostMetricsWire.omit({ disk: true }).parse({ ...sample, disk })).toEqual(sample)
  })
})
