import { describe, expect, it, vi } from 'vitest'
import { makeSafetyHandlers } from './process-safety'

/** A spy in the shape of the one logger method the net uses. */
function makeLog() {
  const error = vi.fn()
  return { log: { error }, error }
}

describe('makeSafetyHandlers', () => {
  it('logs an unhandled rejection with the reason as a structured err, and never rethrows', () => {
    const { log, error } = makeLog()
    const { onUnhandledRejection } = makeSafetyHandlers(log)
    const reason = new Error('a promise nobody caught')
    expect(() => onUnhandledRejection(reason)).not.toThrow()
    expect(error).toHaveBeenCalledOnce()
    const [msg, fields] = error.mock.calls[0] ?? []
    expect(String(msg).toLowerCase()).toContain('unhandledrejection')
    // The error goes in `err`, the one field the record shape gives a meaning:
    // the logger serializes it to {name, message, stack} on the way out.
    expect(fields).toEqual({ err: reason })
  })

  it('logs an uncaught exception with the error as a structured err, and never rethrows', () => {
    const { log, error } = makeLog()
    const { onUncaughtException } = makeSafetyHandlers(log)
    const err = new Error('a throw that escaped a callback')
    expect(() => onUncaughtException(err)).not.toThrow()
    expect(error).toHaveBeenCalledOnce()
    const [msg, fields] = error.mock.calls[0] ?? []
    expect(String(msg).toLowerCase()).toContain('uncaughtexception')
    expect(fields).toEqual({ err })
  })

  it('survives a logger that itself throws (a broken log sink must not become the fatal error)', () => {
    const log = {
      error: vi.fn(() => {
        throw new Error('logger blew up')
      }),
    }
    const { onUnhandledRejection } = makeSafetyHandlers(log)
    expect(() => onUnhandledRejection('boom')).not.toThrow()
  })
})
