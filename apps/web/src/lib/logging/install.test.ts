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
