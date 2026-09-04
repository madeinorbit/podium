import { describe, expect, it, vi } from 'vitest'
import { startJanitorHost } from './janitor-host'

describe('startJanitorHost', () => {
  it('reports the injected worker state and closes it', async () => {
    const close = vi.fn()
    const host = await startJanitorHost({
      port: 1,
      serverUrl: 'http://127.0.0.1:1',
      token: 't',
      start: async () => ({
        progressVersion: () => 3,
        state: () => 'running',
        reason: () => undefined,
        close,
      }),
    })
    expect(host.state()).toBe('running')
    expect(host.progressVersion()).toBe(3)
    host.close()
    expect(close).toHaveBeenCalledOnce()
  })

  it('reports degraded when constructing the worker fails', async () => {
    const host = await startJanitorHost({
      port: 1,
      serverUrl: 'http://127.0.0.1:1',
      token: 't',
      start: async () => {
        throw new Error('worker module missing')
      },
    })
    expect(host.state()).toBe('degraded')
    expect(host.reason()).toMatch(/worker module missing/)
  })

  it('reflects a worker that degrades mid-run without throwing into the server', async () => {
    let state: 'running' | 'degraded' = 'running'
    let reason: string | undefined
    const host = await startJanitorHost({
      port: 1,
      serverUrl: 'http://127.0.0.1:1',
      token: 't',
      start: async () => ({
        progressVersion: () => 5,
        state: () => state,
        reason: () => reason,
        close: () => {},
      }),
    })
    expect(host.state()).toBe('running')
    state = 'degraded'
    reason = 'the database has applied 20260820_x, which this build does not define'
    expect(host.state()).toBe('degraded')
    expect(host.reason()).toMatch(/20260820_x/)
    expect(host.progressVersion()).toBe(5)
  })

  /**
   * POD-1607, from apps/cli's local-dial test: the janitor must dial the address
   * the server BOUND. It moved here with the worker (PDM-27) — `PODIUM_HOST` is
   * how you reach Podium from another device, and it leaves loopback unbound, so
   * a hard-coded `http://localhost:<port>` would refuse every maintenance call.
   */
  it('dials the bound interface, not a hard-coded loopback', async () => {
    const prior = process.env.PODIUM_HOST
    process.env.PODIUM_HOST = '100.113.194.89'
    try {
      let dialed: string | undefined
      await startJanitorHost({
        port: 23000,
        token: 't',
        start: async ({ serverUrl }) => {
          dialed = serverUrl
          return {
            progressVersion: () => 0,
            state: () => 'running',
            reason: () => undefined,
            close: () => {},
          }
        },
      })
      expect(dialed).toBe('http://100.113.194.89:23000')
    } finally {
      if (prior === undefined) delete process.env.PODIUM_HOST
      else process.env.PODIUM_HOST = prior
    }
  })
})
