import { describe, expect, it } from 'vitest'
import { TunnelHealthStore } from './tunnel-health'
import { TUNNEL_REPORT_MAX_AGE_MS } from '@podium/runtime/tunnel-health'

describe('tunnel health', () => {
  it('expires a working report and recovers on a new heartbeat', () => {
    let now = 100_000
    const health = new TunnelHealthStore(() => now)
    const report = { state: 'working' as const, url: 'https://one.trycloudflare.com', lastOkAt: 90_000, failedSince: null, lastError: null }
    expect(health.read(report.url)).toBeNull()
    health.report(report)
    expect(health.read(report.url)?.state).toBe('working')
    now += TUNNEL_REPORT_MAX_AGE_MS + 1
    expect(health.read(report.url)).toMatchObject({ state: 'unhealthy', failedSince: 100_000 })
    health.report(report)
    expect(health.read(report.url)?.state).toBe('working')
  })
  it('never says an old address is working after a rotation', () => {
    const health = new TunnelHealthStore(() => 1)
    health.report({ state: 'working', url: 'https://old.example', lastOkAt: 1, failedSince: null, lastError: null })
    expect(health.read('https://new.example')?.state).toBe('starting')
    health.report({ state: 'restarting', url: 'https://old.example', lastOkAt: 1, failedSince: 1, lastError: 'Timed out.' })
    expect(health.read('https://new.example')?.state).toBe('restarting')
  })
})
