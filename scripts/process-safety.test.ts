import { describe, expect, it, vi } from 'vitest'
import { makeSafetyHandlers } from './process-safety'

describe('makeSafetyHandlers', () => {
  it('logs an unhandled rejection with the label and the reason, and never rethrows', () => {
    const log = vi.fn()
    const { onUnhandledRejection } = makeSafetyHandlers('daemon', log)
    const reason = new Error('a promise nobody caught')
    expect(() => onUnhandledRejection(reason)).not.toThrow()
    expect(log).toHaveBeenCalledOnce()
    const [msg, err] = log.mock.calls[0]
    expect(msg).toContain('daemon')
    expect(msg.toLowerCase()).toContain('unhandledrejection')
    expect(err).toBe(reason)
  })

  it('logs an uncaught exception with the label and the error, and never rethrows', () => {
    const log = vi.fn()
    const { onUncaughtException } = makeSafetyHandlers('server', log)
    const err = new Error('a throw that escaped a callback')
    expect(() => onUncaughtException(err)).not.toThrow()
    expect(log).toHaveBeenCalledOnce()
    const [msg, got] = log.mock.calls[0]
    expect(msg).toContain('server')
    expect(msg.toLowerCase()).toContain('uncaughtexception')
    expect(got).toBe(err)
  })

  it('survives a logger that itself throws (a broken log sink must not become the fatal error)', () => {
    const log = vi.fn(() => {
      throw new Error('logger blew up')
    })
    const { onUnhandledRejection } = makeSafetyHandlers('daemon', log)
    expect(() => onUnhandledRejection('boom')).not.toThrow()
  })
})
