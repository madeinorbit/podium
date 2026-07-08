import type { RunRecord } from '@podium/runtime/run-registry'
import { describe, expect, it } from 'vitest'
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
  it('a host (all-in-one) box reports the split — server + daemon', () => {
    const out = renderStatus({
      live: [rec({ role: 'server', pid: 42, port: 18787 }), rec({ role: 'daemon', pid: 43 })],
      config: { mode: 'all-in-one', persistence: 'detached', port: 18787 },
      nowMs: T0 + 90_000,
    })
    expect(out).toContain('mode: all-in-one, persistence: detached')
    expect(out).toContain('● server  up :18787  pid 42  (1m)')
    expect(out).toContain('● daemon  up  pid 43  (1m)')
    expect(out).toContain('http://localhost:18787')
  })

  it('an in-process all-in-one record (desktop sidecar) is surfaced directly', () => {
    const out = renderStatus({
      live: [rec({ role: 'all-in-one', pid: 42, port: 18787 })],
      config: { mode: 'all-in-one', port: 18787 },
      nowMs: T0,
    })
    expect(out).toContain('● all-in-one  up :18787')
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

  describe('daemon connectivity truthfulness (#19)', () => {
    it('a live PID no longer implies "up" — the daemon-written link state is shown', () => {
      const out = renderStatus({
        live: [rec({ role: 'daemon', pid: 7 })],
        config: { mode: 'daemon', persistence: 'systemd' },
        nowMs: T0 + 65_000,
        connectivity: {
          state: 'disconnected',
          serverUrl: 'wss://relay.example',
          lastHelloOkAt: new Date(T0).toISOString(),
          lastError: 'ECONNREFUSED',
          retryBackoffMs: 5000,
          updatedAt: new Date(T0 + 60_000).toISOString(),
        },
      })
      expect(out).toContain('● daemon  up') // the process exists…
      expect(out).toContain('disconnected — ECONNREFUSED') // …but the link is honest
      expect(out).toContain('wss://relay.example')
      expect(out).toContain('retrying every ~5s')
      expect(out).toContain('last contact 1m ago')
    })

    it('a blocked daemon explains the rejection and the re-pair recovery path', () => {
      const out = renderStatus({
        live: [],
        config: { mode: 'daemon', persistence: 'systemd' },
        nowMs: T0,
        connectivity: {
          state: 'blocked',
          serverUrl: 'wss://relay.example',
          blockedReason: 'pairRejected: bad code',
          updatedAt: new Date(T0).toISOString(),
        },
      })
      expect(out).toContain('BLOCKED — pairRejected: bad code')
      expect(out).toContain('podium set-server <join-code>')
    })

    it('a connected daemon reports the server URL and last contact', () => {
      const out = renderStatus({
        live: [rec({ role: 'daemon', pid: 7 })],
        config: { mode: 'daemon' },
        nowMs: T0 + 3_000,
        connectivity: {
          state: 'connected',
          serverUrl: 'wss://relay.example',
          lastHelloOkAt: new Date(T0).toISOString(),
          updatedAt: new Date(T0).toISOString(),
        },
      })
      expect(out).toContain('connected')
      expect(out).toContain('last contact 3s ago')
    })
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
