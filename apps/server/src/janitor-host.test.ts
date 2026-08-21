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

  /**
   * THE PATH THAT ACTUALLY FIRES IN PRODUCTION: the schema advances while the
   * janitor is already ticking. Co-hosted, the janitor's own `process.exit(78)`
   * would exit the SERVER, whose parent then classifies 78 as a refusal and
   * parks the server permanently stopped — the literal inverse of the §8 policy
   * (review finding 3). The host must own the refusal instead.
   */
  it('a MID-RUN compatibility refusal degrades the janitor and leaves the host alive', async () => {
    let raise: ((error: Error) => void) | undefined
    let progress = 5
    const host = await startJanitorHost({
      port: 1,
      serverUrl: 'http://127.0.0.1:1',
      token: 't',
      startJanitor: async (opts) => {
        raise = opts.onCompatibilityRefusal
        return { service: { progressVersion: () => progress }, close: () => {} }
      },
    })
    expect(host.state()).toBe('running')
    expect(raise, 'the host must hand the janitor a refusal callback').toBeTypeOf('function')

    const err = new Error('the database has applied 20260820_x, which this build does not define')
    err.name = 'MaintenanceCompatibilityError'
    raise?.(err)

    expect(host.state()).toBe('degraded')
    expect(host.reason()).toMatch(/20260820_x/)
    // Frozen at its last value: a STOPPED component must not read as a WEDGED
    // one to the parent's watchdog rule.
    progress = 99
    expect(host.progressVersion()).toBe(5)
  })
})
