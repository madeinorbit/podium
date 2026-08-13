import { setActiveCrashReporter } from '@podium/client-core/logging'
import type { LogsCrashInput, LogsForwardInput } from '@podium/commands'
import { createLogger, resetLogging, setLogLevel } from '@podium/logger'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { installWebLogging, type LogTransport } from './install'

function recorder(): {
  transport: LogTransport
  forwarded: LogsForwardInput[]
  crashes: LogsCrashInput[]
} {
  const forwarded: LogsForwardInput[] = []
  const crashes: LogsCrashInput[] = []
  return {
    forwarded,
    crashes,
    transport: {
      forward: async (input) => {
        forwarded.push(input)
      },
      crash: async (input) => {
        crashes.push(input)
      },
    },
  }
}

describe('installWebLogging', () => {
  let dispose: (() => void) | null = null

  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    dispose?.()
    dispose = null
    setActiveCrashReporter(null)
    resetLogging()
    vi.useRealTimers()
  })

  it('forwards a warning to the server, tagged with the client origin', async () => {
    const { transport, forwarded } = recorder()
    dispose = installWebLogging({ transport, role: 'web', version: '1.2.3', console: false })

    createLogger('web:store').warn('replica degraded', { detail: 'quota' })
    await vi.advanceTimersByTimeAsync(5000)

    expect(forwarded).toHaveLength(1)
    expect(forwarded[0]?.origin).toMatchObject({ role: 'web', v: '1.2.3' })
    expect(forwarded[0]?.records[0]).toMatchObject({
      level: 'warn',
      ns: 'web:store',
      msg: 'replica degraded',
      detail: 'quota',
      role: 'web',
    })
  })

  it('does not forward debug by default, but keeps it for the crash report', async () => {
    const { transport, forwarded, crashes } = recorder()
    dispose = installWebLogging({ transport, role: 'web', console: false })

    createLogger('web:pty').debug('frame decoded', { bytes: 42 })
    await vi.advanceTimersByTimeAsync(5000)
    expect(forwarded).toHaveLength(0)

    window.dispatchEvent(new ErrorEvent('error', { error: new Error('async boom') }))
    await vi.advanceTimersByTimeAsync(0)

    expect(crashes).toHaveLength(1)
    expect(crashes[0]?.snapshot.map((r) => r.msg)).toEqual(['frame decoded', 'async boom'])
    expect(crashes[0]?.err.message).toBe('async boom')
  })

  it('forwards debug too once the client level is raised', async () => {
    const { transport, forwarded } = recorder()
    dispose = installWebLogging({ transport, role: 'web', console: false })

    setLogLevel('debug')
    createLogger('web:pty').debug('frame decoded')
    await vi.advanceTimersByTimeAsync(5000)

    expect(forwarded[0]?.records[0]?.msg).toBe('frame decoded')
  })

  /**
   * POD-1965. Every web record shipped with no `v` for months, and no test saw
   * it, because the failure was an ABSENT field — nothing asserted presence.
   * These two do, from both ends of the record: the origin an operator filters
   * on, and the crash payload that is the only thread back to a bundle.
   *
   * Armedness was verified by deleting the `version:` line from install.ts and
   * watching both go red; keep them that way. The value is deliberately matched
   * loosely — what must not regress is that SOMETHING build-distinguishing is
   * there, not which flavour of identity this build happens to have.
   */
  it('stamps which build wrote the record, without being told the version', async () => {
    const { transport, forwarded } = recorder()
    dispose = installWebLogging({ transport, role: 'web', console: false })

    createLogger('web:store').warn('replica degraded')
    await vi.advanceTimersByTimeAsync(5000)

    expect(forwarded[0]?.origin.v).toEqual(expect.any(String))
    expect(forwarded[0]?.origin.v).not.toBe('')
  })

  it('stamps the crash report too — the one record that must name its bundle', async () => {
    const { transport, crashes } = recorder()
    dispose = installWebLogging({ transport, role: 'web', console: false })

    window.dispatchEvent(new ErrorEvent('error', { error: new Error('boom') }))
    await vi.advanceTimersByTimeAsync(5000)

    expect(crashes[0]?.origin.v).toEqual(expect.any(String))
    expect(crashes[0]?.origin.v).not.toBe('')
  })

  it('stops capturing after dispose', async () => {
    const { transport, forwarded, crashes } = recorder()
    const stop = installWebLogging({ transport, role: 'web', console: false })
    stop()

    createLogger('web:store').warn('after dispose')
    window.dispatchEvent(new ErrorEvent('error', { error: new Error('after dispose') }))
    await vi.advanceTimersByTimeAsync(5000)

    expect(forwarded).toEqual([])
    expect(crashes).toEqual([])
  })
})
