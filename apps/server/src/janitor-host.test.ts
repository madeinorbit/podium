import { describe, expect, it, vi } from 'vitest'
import { shouldHostJanitor, startJanitorHost } from './janitor-host'

describe('shouldHostJanitor', () => {
  it('is true under parent, desktop, or explicit host flag', () => {
    expect(shouldHostJanitor({})).toBe(false)
    expect(shouldHostJanitor({ PODIUM_UNDER_PARENT: '1' })).toBe(true)
    expect(shouldHostJanitor({ PODIUM_DESKTOP_SUPERVISED: '1' })).toBe(true)
    expect(shouldHostJanitor({ PODIUM_HOST_JANITOR: '1' })).toBe(true)
  })
})

describe('startJanitorHost', () => {
  it('reports running when startJanitor succeeds', async () => {
    const close = vi.fn()
    const host = await startJanitorHost({
      port: 1,
      serverUrl: 'http://127.0.0.1:1',
      token: 't',
      startJanitor: async () => ({
        service: { progressVersion: () => 3 },
        close,
      }),
    })
    expect(host.state()).toBe('running')
    expect(host.progressVersion()).toBe(3)
    host.close()
    expect(close).toHaveBeenCalledOnce()
    expect(host.state()).toBe('stopped')
  })

  it('reports degraded on MaintenanceCompatibilityError without throwing', async () => {
    const err = new Error('schema mismatch')
    err.name = 'MaintenanceCompatibilityError'
    const host = await startJanitorHost({
      port: 1,
      serverUrl: 'http://127.0.0.1:1',
      token: 't',
      startJanitor: async () => {
        throw err
      },
    })
    expect(host.state()).toBe('degraded')
    expect(host.reason()).toMatch(/schema mismatch/)
  })
})
