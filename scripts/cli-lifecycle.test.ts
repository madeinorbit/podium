import { describe, expect, it } from 'vitest'
import type { RunRecord } from '../packages/core/src/run-registry'
import { humanUptime, renderStatus } from './cli-lifecycle'

const T0 = Date.parse('2026-07-06T12:00:00.000Z')

describe('humanUptime', () => {
  it('formats seconds/minutes/hours/days', () => {
    expect(humanUptime(new Date(T0).toISOString(), T0 + 5_000)).toBe('5s')
    expect(humanUptime(new Date(T0).toISOString(), T0 + 5 * 60_000)).toBe('5m')
    expect(humanUptime(new Date(T0).toISOString(), T0 + 3 * 3600_000)).toBe('3h')
    expect(humanUptime(new Date(T0).toISOString(), T0 + 2 * 86400_000)).toBe('2d')
  })
  it('handles a bad timestamp', () => {
    expect(humanUptime('not-a-date', T0)).toBe('unknown')
  })
})

const rec = (over: Partial<RunRecord>): RunRecord => ({
  role: 'server',
  pid: 100,
  startedAt: new Date(T0).toISOString(),
  ...over,
})

describe('renderStatus', () => {
  it('shows an up all-in-one component with port + uptime', () => {
    const out = renderStatus({
      live: [rec({ role: 'all-in-one', pid: 42, port: 18787 })],
      config: { mode: 'all-in-one', persistence: 'detached', port: 18787 },
      nowMs: T0 + 90_000,
    })
    expect(out).toContain('mode: all-in-one, persistence: detached')
    expect(out).toContain('● all-in-one  up :18787  pid 42  (1m)')
    expect(out).toContain('http://localhost:18787')
  })

  it('shows a down component when nothing is live for the mode', () => {
    const out = renderStatus({
      live: [],
      config: { mode: 'server', port: 18787 },
      nowMs: T0,
    })
    expect(out).toContain('○ server  down')
  })

  it('prefers publicUrl for the URL line', () => {
    const out = renderStatus({
      live: [],
      config: { mode: 'daemon', publicUrl: 'https://box.ts.net' },
      nowMs: T0,
    })
    expect(out).toContain('URL: https://box.ts.net')
    expect(out).toContain('○ daemon  down')
  })

  it('unknown mode falls back to listing every role that is live', () => {
    const out = renderStatus({
      live: [rec({ role: 'daemon', pid: 7 })],
      config: {},
      nowMs: T0,
    })
    expect(out).toContain('● daemon  up')
  })
})
